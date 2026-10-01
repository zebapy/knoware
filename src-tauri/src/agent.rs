//! ACP client side: one agent subprocess per blob, driven by a small command channel.

use crate::state::{Entry, PlanItem, Shared};
use crate::world::{Activity, Blob, Blocked, PermissionChoice, now_ms};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, ForkSessionRequest, InitializeRequest, InitializeResponse,
    ListSessionsRequest, LoadSessionRequest, NewSessionRequest, PermissionOptionId, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResumeSessionRequest, SelectedPermissionOutcome, SessionId, SessionInfo, SessionNotification,
    TextContent,
};
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, Client, ConnectionTo, Responder};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub enum Cmd {
    Prompt(String),
    Cancel,
    Permission(Option<String>),
    Stop,
}

pub struct AgentHandle {
    pub tx: mpsc::UnboundedSender<Cmd>,
}

#[derive(Clone)]
pub enum StartMode {
    New,
    /// Reattach to an existing session (load, or resume when the agent only supports that).
    Load(String),
    /// Branch a new session off an existing one.
    Fork(String),
}

fn acp_agent(app: &Shared, agent: &str) -> anyhow::Result<AcpAgent> {
    let Some(profile) = app.settings.agents.get(agent) else {
        anyhow::bail!("no agent profile named {agent:?} in settings.json");
    };
    Ok(AcpAgent::new(
        AcpAgentConfig::new(&profile.command).args(profile.args.clone()),
    ))
}

/// Run a future on its own thread and runtime. ACP connection futures are not `Send`,
/// and keeping each agent on its own thread isolates a misbehaving agent.
fn run_on_thread<M, F>(name: String, make: M)
where
    M: FnOnce() -> F + Send + 'static,
    F: Future<Output = ()>,
{
    std::thread::Builder::new()
        .name(name)
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            if let Ok(rt) = rt {
                rt.block_on(make());
            }
        })
        .expect("spawn agent thread");
}

/// Ensure a blob has a live agent, starting one if needed. Returns the command sender.
pub fn ensure(app: &Shared, blob_id: &str, mode: StartMode) -> Option<mpsc::UnboundedSender<Cmd>> {
    let mut agents = app.agents.lock().unwrap();
    if let Some(h) = agents.get(blob_id) {
        return Some(h.tx.clone());
    }
    let blob = app.blob(blob_id)?;
    let (tx, rx) = mpsc::unbounded_channel();
    agents.insert(blob_id.to_string(), AgentHandle { tx: tx.clone() });
    drop(agents);

    app.update_blob(blob_id, false, |b| b.activity = Activity::Starting);
    let app = app.clone();
    let id = blob_id.to_string();
    run_on_thread(format!("agent-{id}"), move || async move {
        let result = run(app.clone(), blob, mode, rx).await;
        app.agents.lock().unwrap().remove(&id);
        if let Err(e) = result {
            app.notice(&id, format!("Agent stopped: {e}"));
        }
        app.update_blob(&id, true, |b| {
            b.activity = Activity::Offline;
            b.blocked = None;
            b.subagents = 0;
        });
    });
    Some(tx)
}

pub fn send(app: &Shared, blob_id: &str, cmd: Cmd) -> bool {
    app.agents
        .lock()
        .unwrap()
        .get(blob_id)
        .is_some_and(|h| h.tx.send(cmd).is_ok())
}

struct Ctx {
    app: Shared,
    blob_id: String,
    /// False while `session/load` replays history, so old messages don't count as activity.
    live: AtomicBool,
    permission: Mutex<Option<Responder<RequestPermissionResponse>>>,
    subagent_calls: Mutex<HashSet<String>>,
}

async fn run(
    app: Shared,
    blob: Blob,
    mode: StartMode,
    mut rx: mpsc::UnboundedReceiver<Cmd>,
) -> anyhow::Result<()> {
    let agent = acp_agent(&app, &blob.agent)?;
    let ctx = Arc::new(Ctx {
        app: app.clone(),
        blob_id: blob.id.clone(),
        live: AtomicBool::new(false),
        permission: Mutex::new(None),
        subagent_calls: Mutex::new(HashSet::new()),
    });
    let on_note = ctx.clone();
    let on_perm = ctx.clone();
    let main = ctx.clone();
    let cwd = blob.cwd.clone();

    Client
        .builder()
        .on_receive_notification(
            async move |n: SessionNotification, _cx| {
                on_update(
                    &on_note,
                    serde_json::to_value(&n.update).unwrap_or_default(),
                );
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |req: RequestPermissionRequest, responder, _cx| {
                on_permission(
                    &on_perm,
                    serde_json::to_value(&req).unwrap_or_default(),
                    responder,
                );
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, async move |cx: ConnectionTo<Agent>| {
            let init = cx
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            let session = open_session(&cx, &init, &mode, cwd).await?;
            main.live.store(true, Ordering::SeqCst);
            main.app.update_blob(&main.blob_id, true, |b| {
                b.session_id = Some(session.0.to_string());
                b.activity = Activity::Idle;
            });

            while let Some(cmd) = rx.recv().await {
                match cmd {
                    Cmd::Prompt(text) => prompt(&main, &cx, &session, text)?,
                    Cmd::Cancel => {
                        answer_permission(&main, None);
                        cx.send_notification(CancelNotification::new(session.clone()))?;
                    }
                    Cmd::Permission(choice) => answer_permission(&main, choice),
                    Cmd::Stop => break,
                }
            }
            Ok(())
        })
        .await?;
    Ok(())
}

async fn open_session(
    cx: &ConnectionTo<Agent>,
    init: &InitializeResponse,
    mode: &StartMode,
    cwd: PathBuf,
) -> Result<SessionId, agent_client_protocol::Error> {
    let caps = &init.agent_capabilities;
    match mode {
        StartMode::New => Ok(cx
            .send_request(NewSessionRequest::new(cwd))
            .block_task()
            .await?
            .session_id),
        StartMode::Load(id) if caps.load_session => {
            let id = SessionId::new(id.as_str());
            cx.send_request(LoadSessionRequest::new(id.clone(), cwd))
                .block_task()
                .await?;
            Ok(id)
        }
        StartMode::Load(id) if caps.session_capabilities.resume.is_some() => {
            let id = SessionId::new(id.as_str());
            cx.send_request(ResumeSessionRequest::new(id.clone(), cwd))
                .block_task()
                .await?;
            Ok(id)
        }
        StartMode::Fork(id) if caps.session_capabilities.fork.is_some() => Ok(cx
            .send_request(ForkSessionRequest::new(SessionId::new(id.as_str()), cwd))
            .block_task()
            .await?
            .session_id),
        StartMode::Load(_) => Err(agent_client_protocol::Error::invalid_params()
            .data("this agent can't load or resume sessions")),
        StartMode::Fork(_) => {
            Err(agent_client_protocol::Error::invalid_params()
                .data("this agent can't fork sessions"))
        }
    }
}

fn prompt(
    main: &Arc<Ctx>,
    cx: &ConnectionTo<Agent>,
    session: &SessionId,
    text: String,
) -> Result<(), agent_client_protocol::Error> {
    let app = &main.app;
    app.push_entry(&main.blob_id, Entry::User { text: text.clone() }, |_| false);
    app.update_blob(&main.blob_id, true, |b| {
        b.activity = Activity::Working;
        b.your_turn = false;
        b.last_activity_ms = now_ms();
        b.last = first_line(&text);
    });
    let request = PromptRequest::new(
        session.clone(),
        vec![ContentBlock::Text(TextContent::new(text))],
    );
    let done = main.clone();
    let task_cx = cx.clone();
    cx.spawn(async move {
        let result = task_cx.send_request(request).block_task().await;
        let note = match &result {
            Ok(r) => match serde_json::to_value(r.stop_reason)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
            {
                Some(reason) if reason != "end_turn" => {
                    Some(format!("Turn ended: {}", reason.replace('_', " ")))
                }
                _ => None,
            },
            Err(e) => Some(format!("Prompt failed: {e}")),
        };
        if let Some(note) = note {
            done.app.notice(&done.blob_id, note);
        }
        done.subagent_calls.lock().unwrap().clear();
        done.app.update_blob(&done.blob_id, true, |b| {
            b.activity = Activity::Idle;
            b.your_turn = true;
            b.blocked = None;
            b.subagents = 0;
            b.last_activity_ms = now_ms();
        });
        Ok(())
    })
}

fn answer_permission(ctx: &Ctx, choice: Option<String>) {
    let Some(responder) = ctx.permission.lock().unwrap().take() else {
        return;
    };
    let outcome = match choice {
        Some(id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            PermissionOptionId::new(id),
        )),
        None => RequestPermissionOutcome::Cancelled,
    };
    let _ = responder.respond(RequestPermissionResponse::new(outcome));
    ctx.app.update_blob(&ctx.blob_id, false, |b| {
        b.blocked = None;
        b.last_activity_ms = now_ms();
    });
}

fn on_permission(ctx: &Ctx, req: Value, responder: Responder<RequestPermissionResponse>) {
    let title = req["toolCall"]["title"]
        .as_str()
        .unwrap_or("Permission requested")
        .to_string();
    let options = req["options"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|o| PermissionChoice {
            option_id: o["optionId"].as_str().unwrap_or_default().to_string(),
            name: o["name"].as_str().unwrap_or_default().to_string(),
            kind: o["kind"].as_str().unwrap_or_default().to_string(),
        })
        .collect();
    // A new request supersedes an unanswered one; the agent treats that as cancelled.
    if let Some(old) = ctx.permission.lock().unwrap().replace(responder) {
        let _ = old.respond(RequestPermissionResponse::new(
            RequestPermissionOutcome::Cancelled,
        ));
    }
    ctx.app.update_blob(&ctx.blob_id, false, |b| {
        b.last = format!("Allow: {title}");
        b.blocked = Some(Blocked { title, options });
        b.last_activity_ms = now_ms();
    });
}

fn text_of(update: &Value) -> String {
    update["content"]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn first_line(s: &str) -> String {
    s.lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or_default()
        .trim()
        .chars()
        .take(200)
        .collect()
}

fn last_line(s: &str) -> String {
    s.lines()
        .rfind(|l| !l.trim().is_empty())
        .unwrap_or_default()
        .trim()
        .chars()
        .take(200)
        .collect()
}

/// Claude's adapter marks its sub-agent tool in `_meta`; other agents simply show none.
fn is_subagent(update: &Value) -> bool {
    let name = update["_meta"]["claudeCode"]["toolName"]
        .as_str()
        .unwrap_or_default();
    ["Task", "Agent"].contains(&name)
}

fn on_update(ctx: &Ctx, update: Value) {
    let app = &ctx.app;
    let id = ctx.blob_id.as_str();
    let live = ctx.live.load(Ordering::SeqCst);
    let kind = update["sessionUpdate"].as_str().unwrap_or_default();
    let touch = |b: &mut Blob| {
        if live {
            b.last_activity_ms = now_ms();
        }
    };

    match kind {
        "user_message_chunk" => {
            let text = text_of(&update);
            app.push_entry(id, Entry::User { text: text.clone() }, |e| match e {
                Entry::User { text: t } if !live => {
                    t.push_str(&text);
                    true
                }
                _ => false,
            });
        }
        "agent_message_chunk" | "agent_thought_chunk" => {
            let chunk = text_of(&update);
            let thought = kind == "agent_thought_chunk";
            let fresh = if thought {
                Entry::Thought {
                    text: chunk.clone(),
                }
            } else {
                Entry::Agent {
                    text: chunk.clone(),
                }
            };
            let mut full = String::new();
            app.push_entry(id, fresh, |e| match e {
                Entry::Agent { text } if !thought => {
                    text.push_str(&chunk);
                    full = text.clone();
                    true
                }
                Entry::Thought { text } if thought => {
                    text.push_str(&chunk);
                    true
                }
                _ => false,
            });
            if !thought {
                let line = last_line(if full.is_empty() { &chunk } else { &full });
                if !line.is_empty() {
                    app.update_blob(id, false, |b| {
                        b.last = line;
                        touch(b);
                    });
                }
            }
        }
        "tool_call" => {
            let call_id = update["toolCallId"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let title = update["title"].as_str().unwrap_or("tool").to_string();
            let status = update["status"].as_str().unwrap_or("pending").to_string();
            let sub = live && is_subagent(&update);
            if sub {
                ctx.subagent_calls.lock().unwrap().insert(call_id.clone());
            }
            let count = ctx.subagent_calls.lock().unwrap().len() as u32;
            app.push_entry(
                id,
                Entry::Tool {
                    id: call_id,
                    title: title.clone(),
                    status,
                },
                |_| false,
            );
            app.update_blob(id, false, |b| {
                b.last = format!("$ {}", first_line(&title));
                b.subagents = count;
                touch(b);
            });
        }
        "tool_call_update" => {
            let call_id = update["toolCallId"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let title = update["title"].as_str().map(String::from);
            let status = update["status"].as_str().map(String::from);
            if status
                .as_deref()
                .is_some_and(|s| ["completed", "failed"].contains(&s))
            {
                ctx.subagent_calls.lock().unwrap().remove(&call_id);
            }
            let count = ctx.subagent_calls.lock().unwrap().len() as u32;
            app.edit_entry(
                id,
                |e| matches!(e, Entry::Tool { id, .. } if *id == call_id),
                |e| {
                    if let Entry::Tool {
                        title: t,
                        status: s,
                        ..
                    } = e
                    {
                        if let Some(title) = title {
                            *t = title;
                        }
                        if let Some(status) = status {
                            *s = status;
                        }
                    }
                },
            );
            app.update_blob(id, false, |b| {
                b.subagents = count;
                touch(b);
            });
        }
        "plan" => {
            let items = update["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|e| PlanItem {
                    content: e["content"].as_str().unwrap_or_default().to_string(),
                    status: e["status"].as_str().unwrap_or("pending").to_string(),
                })
                .collect::<Vec<_>>();
            let replace = items.clone();
            app.push_entry(id, Entry::Plan { items }, |e| match e {
                Entry::Plan { items } => {
                    *items = replace;
                    true
                }
                _ => false,
            });
        }
        "usage_update" => {
            let used = update["used"].as_u64().unwrap_or(0);
            let size = update["size"].as_u64().unwrap_or(0);
            app.update_blob(id, false, |b| {
                b.ctx_used = used;
                b.ctx_size = size;
            });
        }
        "session_info_update" => {
            if let Some(title) = update["title"].as_str().filter(|t| !t.is_empty()) {
                let title = title.to_string();
                app.update_blob(id, true, |b| b.name = title);
            }
        }
        _ => {}
    }
}

/// Ask one agent for the sessions it already has (ACP `session/list`).
pub async fn list_sessions(app: Shared, agent_name: String) -> anyhow::Result<Vec<SessionInfo>> {
    let agent = acp_agent(&app, &agent_name)?;
    let sessions = Client
        .builder()
        .connect_with(agent, async move |cx: ConnectionTo<Agent>| {
            let init = cx
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            let mut all = Vec::new();
            if init.agent_capabilities.session_capabilities.list.is_none() {
                return Ok(all);
            }
            let mut cursor: Option<String> = None;
            loop {
                let page = cx
                    .send_request(ListSessionsRequest::new().cursor(cursor.clone()))
                    .block_task()
                    .await?;
                all.extend(page.sessions);
                cursor = page.next_cursor;
                if cursor.is_none() || all.len() > 2000 {
                    break;
                }
            }
            Ok(all)
        })
        .await?;
    Ok(sessions)
}

/// Run `list_sessions` for every configured agent on background threads and report each result.
pub fn discover_all(
    app: &Shared,
    on_found: impl Fn(&Shared, &str, Vec<SessionInfo>) + Send + Sync + 'static,
) {
    let on_found = Arc::new(on_found);
    for name in app.settings.agents.keys() {
        let name = name.clone();
        let app = app.clone();
        let on_found = on_found.clone();
        run_on_thread(format!("discover-{name}"), move || async move {
            if let Ok(sessions) = list_sessions(app.clone(), name.clone()).await {
                on_found(&app, &name, sessions);
            }
        });
    }
}
