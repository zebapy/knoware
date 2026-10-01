mod agent;
mod git;
mod signals;
mod state;
mod world;

use agent::{Cmd, StartMode};
use serde::Serialize;
use state::{App, Entry, Shared};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State, WindowEvent};
use world::{Activity, Blob, Planet, Settings, World, now_ms};

type Res<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    world: World,
    settings: Settings,
}

/// A newly made blob plus the world that contains it, so the renderer can select it right away.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    id: String,
    world: World,
}

#[tauri::command]
fn get_state(app: State<Shared>) -> Snapshot {
    Snapshot {
        world: app.snapshot(),
        settings: app.settings.clone(),
    }
}

#[tauri::command]
fn get_transcript(app: State<Shared>, blob_id: String) -> Vec<Entry> {
    app.transcript(&blob_id)
}

fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~") {
        Some(rest) => world::home().join(rest.trim_start_matches('/')),
        None => PathBuf::from(path),
    }
}

#[tauri::command]
async fn add_planet(app: State<'_, Shared>, path: String) -> Res<Created> {
    let path = expand_home(path.trim())
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;
    if !path.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    let root = git::repo_root(&path);
    let is_repo = root.is_some();
    let path = root.unwrap_or(path);
    let id = {
        let mut world = app.world.lock().unwrap();
        if let Some(p) = world.planets.iter().find(|p| p.path == path) {
            return Ok(Created {
                id: p.id.clone(),
                world: world.clone(),
            });
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".into());
        let name = if is_repo {
            name
        } else {
            path.display()
                .to_string()
                .replacen(&world::home().display().to_string(), "~", 1)
        };
        let id = world::new_id();
        world.planets.push(Planet {
            id: id.clone(),
            name,
            path,
            is_repo,
        });
        id
    };
    app.world_changed();
    let shared = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        signals::refresh(&shared);
        discover(&shared);
    });
    Ok(Created {
        id,
        world: app.snapshot(),
    })
}

#[tauri::command]
fn remove_planet(app: State<Shared>, planet_id: String) -> Res<()> {
    {
        let mut world = app.world.lock().unwrap();
        if world.blobs.iter().any(|b| b.planet_id == planet_id) {
            return Err("Delete this planet's blobs first".into());
        }
        world.planets.retain(|p| p.id != planet_id);
        world.moons.retain(|m| m.planet_id != planet_id);
    }
    app.world_changed();
    Ok(())
}

fn make_blob(
    app: &App,
    planet_id: &str,
    moon_id: Option<String>,
    agent: Option<String>,
) -> Res<Blob> {
    let world = app.world.lock().unwrap();
    let planet = world.planet(planet_id).ok_or("No such planet")?;
    let cwd = match &moon_id {
        Some(m) => world.moon(m).ok_or("No such moon")?.path.clone(),
        None => planet.path.clone(),
    };
    let agent = agent.unwrap_or_else(|| app.settings.default_agent.clone());
    if !app.settings.agents.contains_key(&agent) {
        return Err(format!("No agent profile named {agent:?}"));
    }
    let n = world.blobs.len() + 1;
    Ok(Blob {
        id: world::new_id(),
        planet_id: planet_id.to_string(),
        moon_id,
        name: format!("new-{agent}-{n}"),
        agent,
        session_id: None,
        cwd,
        activity: Activity::Offline,
        blocked: None,
        your_turn: true,
        last: "Starting up…".into(),
        ctx_used: 0,
        ctx_size: 0,
        last_activity_ms: now_ms(),
        pr: None,
        issues: Vec::new(),
        subagents: 0,
    })
}

fn add_and_start(app: &Shared, blob: Blob, mode: StartMode) -> Created {
    let id = blob.id.clone();
    app.world.lock().unwrap().blobs.push(blob);
    app.world_changed();
    agent::ensure(app, &id, mode);
    Created {
        id,
        world: app.snapshot(),
    }
}

#[tauri::command]
fn spawn_blob(
    app: State<Shared>,
    planet_id: String,
    moon_id: Option<String>,
    agent: Option<String>,
) -> Res<Created> {
    let blob = make_blob(&app, &planet_id, moon_id, agent)?;
    Ok(add_and_start(&app, blob, StartMode::New))
}

#[tauri::command]
async fn new_moon(
    app: State<'_, Shared>,
    planet_id: String,
    branch: String,
    agent: Option<String>,
) -> Res<Created> {
    let planet = app
        .snapshot()
        .planet(&planet_id)
        .cloned()
        .ok_or("No such planet")?;
    if !planet.is_repo {
        return Err("No repo here, so no worktrees".into());
    }
    let branch = git::slug(&branch);
    if branch.is_empty() {
        return Err("Branch name is empty".into());
    }
    let root = expand_home(&app.settings.worktree_root.to_string_lossy());
    let path = root.join(&planet.name).join(branch.replace('/', "-"));
    let (repo, wt, br) = (planet.path.clone(), path.clone(), branch.clone());
    tauri::async_runtime::spawn_blocking(move || git::add_worktree(&repo, &wt, &br))
        .await
        .map_err(err)?
        .map_err(err)?;
    let path = path.canonicalize().unwrap_or(path);
    let moon_id = world::new_id();
    app.world.lock().unwrap().moons.push(world::Moon {
        id: moon_id.clone(),
        planet_id: planet_id.clone(),
        branch: branch.clone(),
        path,
        dirty: false,
    });
    let mut blob = make_blob(&app, &planet_id, Some(moon_id), agent)?;
    blob.issues = world::issue_keys(&branch);
    Ok(add_and_start(&app, blob, StartMode::New))
}

#[tauri::command]
async fn delete_moon(app: State<'_, Shared>, moon_id: String, force: bool) -> Res<()> {
    let world = app.snapshot();
    let moon = world.moon(&moon_id).cloned().ok_or("No such moon")?;
    let planet = world
        .planet(&moon.planet_id)
        .cloned()
        .ok_or("No such planet")?;
    for b in world
        .blobs
        .iter()
        .filter(|b| b.moon_id.as_deref() == Some(moon_id.as_str()))
    {
        agent::send(&app, &b.id, Cmd::Stop);
    }
    let (repo, path) = (planet.path.clone(), moon.path.clone());
    tauri::async_runtime::spawn_blocking(move || git::remove_worktree(&repo, &path, force))
        .await
        .map_err(err)?
        .map_err(|e| format!("{e}. The worktree has changes; delete again with Shift to force."))?;
    signals::drop_moon(&mut app.world.lock().unwrap(), &moon_id, &planet);
    app.world_changed();
    Ok(())
}

#[tauri::command]
fn delete_blob(app: State<Shared>, blob_id: String) {
    agent::send(&app, &blob_id, Cmd::Stop);
    app.world.lock().unwrap().blobs.retain(|b| b.id != blob_id);
    app.transcripts.lock().unwrap().remove(&blob_id);
    app.world_changed();
}

#[tauri::command]
fn prompt(app: State<Shared>, blob_id: String, text: String) -> Res<()> {
    let blob = app.blob(&blob_id).ok_or("No such blob")?;
    if blob.name.starts_with("new-") {
        let name: String = git::slug(
            &text
                .split_whitespace()
                .take(4)
                .collect::<Vec<_>>()
                .join(" "),
        )
        .chars()
        .take(24)
        .collect();
        if !name.is_empty() {
            app.update_blob(&blob_id, true, |b| b.name = name);
        }
    }
    let mode = match &blob.session_id {
        Some(id) => StartMode::Load(id.clone()),
        None => StartMode::New,
    };
    let tx = agent::ensure(&app, &blob_id, mode).ok_or("Could not start the agent")?;
    tx.send(Cmd::Prompt(text)).map_err(err)
}

#[tauri::command]
fn wake(app: State<Shared>, blob_id: String) -> Res<()> {
    let blob = app.blob(&blob_id).ok_or("No such blob")?;
    let mode = blob
        .session_id
        .map(StartMode::Load)
        .unwrap_or(StartMode::New);
    agent::ensure(&app, &blob_id, mode);
    Ok(())
}

#[tauri::command]
fn fork_blob(app: State<Shared>, blob_id: String) -> Res<Created> {
    let src = app.blob(&blob_id).ok_or("No such blob")?;
    let session = src
        .session_id
        .clone()
        .ok_or("This blob has no session yet")?;
    let mut blob = make_blob(
        &app,
        &src.planet_id,
        src.moon_id.clone(),
        Some(src.agent.clone()),
    )?;
    blob.name = format!("{}-fork", src.name.chars().take(18).collect::<String>());
    blob.cwd = src.cwd.clone();
    Ok(add_and_start(&app, blob, StartMode::Fork(session)))
}

#[tauri::command]
fn cancel(app: State<Shared>, blob_id: String) {
    agent::send(&app, &blob_id, Cmd::Cancel);
}

#[tauri::command]
fn answer_permission(app: State<Shared>, blob_id: String, option_id: Option<String>) {
    agent::send(&app, &blob_id, Cmd::Permission(option_id));
}

#[tauri::command]
fn refresh_signals(app: State<Shared>) {
    let shared = app.inner().clone();
    std::thread::spawn(move || signals::refresh(&shared));
}

/// How many discovered sessions to place per planet, newest first, so old history doesn't flood the view.
const DISCOVER_PER_PLANET: usize = 8;

fn discover(app: &Shared) {
    agent::discover_all(app, |app, agent_name, mut sessions| {
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let mut placed: std::collections::HashMap<String, usize> = Default::default();
        {
            let mut world = app.world.lock().unwrap();
            for s in sessions {
                let sid = s.session_id.0.to_string();
                if world
                    .blobs
                    .iter()
                    .any(|b| b.session_id.as_deref() == Some(sid.as_str()))
                {
                    continue;
                }
                let Some((planet_id, moon_id)) = world.locate(&s.cwd) else {
                    continue;
                };
                let count = placed.entry(planet_id.clone()).or_default();
                if *count >= DISCOVER_PER_PLANET {
                    continue;
                }
                *count += 1;
                let updated = s
                    .updated_at
                    .as_deref()
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                    .map(|d| d.timestamp_millis().max(0) as u64)
                    .unwrap_or(0);
                let title = s
                    .title
                    .clone()
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| format!("{agent_name}-session"));
                world.blobs.push(Blob {
                    id: world::new_id(),
                    planet_id,
                    moon_id,
                    agent: agent_name.to_string(),
                    session_id: Some(sid),
                    name: title.chars().take(40).collect(),
                    cwd: s.cwd.clone(),
                    activity: Activity::Offline,
                    blocked: None,
                    your_turn: false,
                    last: title,
                    ctx_used: 0,
                    ctx_size: 0,
                    last_activity_ms: updated,
                    pr: None,
                    issues: Vec::new(),
                    subagents: 0,
                });
            }
        }
        app.world_changed();
    });
}

#[tauri::command]
fn discover_sessions(app: State<Shared>) {
    discover(app.inner());
}

/// GUI apps on macOS start with a bare PATH; borrow the login shell's so `npx`, `git` and `gh` resolve.
fn adopt_login_path() {
    let Ok(shell) = std::env::var("SHELL") else {
        return;
    };
    let out = std::process::Command::new(shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .output();
    if let Ok(o) = out {
        let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if o.status.success() && !path.is_empty() {
            // SAFETY: called once at startup before any other threads are spawned.
            unsafe { std::env::set_var("PATH", path) };
        }
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn setup_tray(app: &tauri::App, shared: Shared) -> tauri::Result<()> {
    let idle = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let alert = [
        Image::from_bytes(include_bytes!("../icons/tray-alert-a.png"))?,
        Image::from_bytes(include_bytes!("../icons/tray-alert-b.png"))?,
    ];
    let show = MenuItem::with_id(app, "show", "Show Knoware", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Knoware", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let tray = TrayIconBuilder::with_id("main")
        .icon(idle.clone())
        .tooltip("Knoware")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    // The tray blob bounces while anything is blocked.
    std::thread::spawn(move || {
        let mut frame = 0usize;
        let mut last: Option<usize> = None;
        loop {
            let blocked = shared.world.lock().unwrap().blocked_count();
            let state = if blocked > 0 { frame % 2 } else { 2 };
            if last != Some(state) {
                let icon = if blocked > 0 {
                    alert[state].clone()
                } else {
                    idle.clone()
                };
                let _ = tray.set_icon(Some(icon));
                let tip = if blocked > 0 {
                    format!("Knoware — {blocked} blocked")
                } else {
                    "Knoware".into()
                };
                let _ = tray.set_tooltip(Some(tip));
                last = Some(state);
            }
            frame += 1;
            std::thread::sleep(Duration::from_millis(320));
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    adopt_login_path();
    tauri::Builder::default()
        .setup(|app| {
            let shared: Shared = Arc::new(App::new(app.handle().clone()));
            app.manage(shared.clone());
            setup_tray(app, shared.clone())?;
            signals::start_polling(shared.clone());
            discover(&shared);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps agents running; the tray brings it back.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_transcript,
            add_planet,
            remove_planet,
            spawn_blob,
            new_moon,
            delete_moon,
            delete_blob,
            prompt,
            wake,
            fork_blob,
            cancel,
            answer_permission,
            refresh_signals,
            discover_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running knoware");
}
