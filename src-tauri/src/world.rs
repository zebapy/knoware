//! The world model: planets (repos or plain dirs), moons (worktrees) and blobs (agent sessions).
//! Persisted as JSON so the galaxy survives restarts; live agent state is rebuilt on demand.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Planet {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub is_repo: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Moon {
    pub id: String,
    pub planet_id: String,
    pub branch: String,
    pub path: PathBuf,
    #[serde(default)]
    pub dirty: bool,
}

/// What the agent process is doing right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Activity {
    /// No live connection: discovered, restored after restart, or its process exited.
    Offline,
    /// Connecting, initializing or loading the session.
    Starting,
    /// A prompt turn is running.
    Working,
    /// Turn ended; the agent waits for the user.
    Idle,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionChoice {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocked {
    pub title: String,
    pub options: Vec<PermissionChoice>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrState {
    Open,
    Merged,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CiState {
    None,
    Running,
    Passing,
    Failing,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSignal {
    pub number: u64,
    pub url: String,
    pub state: PrState,
    pub ci: CiState,
    /// Last push or review, ms since epoch. Drives the PR decay clock.
    pub updated_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blob {
    pub id: String,
    pub planet_id: String,
    pub moon_id: Option<String>,
    pub agent: String,
    pub session_id: Option<String>,
    pub name: String,
    pub cwd: PathBuf,
    pub activity: Activity,
    #[serde(default)]
    pub blocked: Option<Blocked>,
    /// Turn ended and the user has not replied yet.
    #[serde(default)]
    pub your_turn: bool,
    pub last: String,
    pub ctx_used: u64,
    pub ctx_size: u64,
    /// Last agent or user activity, ms since epoch. Drives dormancy and the session decay clock.
    pub last_activity_ms: u64,
    #[serde(default)]
    pub pr: Option<PrSignal>,
    #[serde(default)]
    pub issues: Vec<String>,
    /// Tool calls in flight that look like sub-agents (Task tools).
    #[serde(default)]
    pub subagents: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub agents: HashMap<String, AgentProfile>,
    pub default_agent: String,
    pub dormant_after_hours: f64,
    pub session_decay_start_days: f64,
    pub session_decay_full_days: f64,
    pub pr_decay_start_days: f64,
    pub pr_decay_full_days: f64,
    pub auto_cleanup_merged_moons: bool,
    pub worktree_root: PathBuf,
    pub signals_poll_secs: u64,
}

impl Default for Settings {
    fn default() -> Self {
        let npx = |pkg: &str| AgentProfile {
            command: "npx".into(),
            args: vec!["-y".into(), pkg.into()],
        };
        let agents = HashMap::from([
            (
                "claude".to_string(),
                npx("@agentclientprotocol/claude-agent-acp@latest"),
            ),
            (
                "codex".to_string(),
                npx("@agentclientprotocol/codex-acp@latest"),
            ),
        ]);
        Self {
            agents,
            default_agent: "claude".into(),
            dormant_after_hours: 2.0,
            session_decay_start_days: 2.0,
            session_decay_full_days: 14.0,
            pr_decay_start_days: 3.0,
            pr_decay_full_days: 21.0,
            auto_cleanup_merged_moons: false,
            worktree_root: home().join(".knoware").join("worktrees"),
            signals_poll_secs: 60,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct World {
    pub planets: Vec<Planet>,
    pub moons: Vec<Moon>,
    pub blobs: Vec<Blob>,
}

impl World {
    pub fn planet(&self, id: &str) -> Option<&Planet> {
        self.planets.iter().find(|p| p.id == id)
    }

    pub fn moon(&self, id: &str) -> Option<&Moon> {
        self.moons.iter().find(|m| m.id == id)
    }

    pub fn blob(&self, id: &str) -> Option<&Blob> {
        self.blobs.iter().find(|b| b.id == id)
    }

    pub fn blob_mut(&mut self, id: &str) -> Option<&mut Blob> {
        self.blobs.iter_mut().find(|b| b.id == id)
    }

    /// Find where a path lives: the deepest moon containing it, else the deepest planet.
    pub fn locate(&self, path: &Path) -> Option<(String, Option<String>)> {
        if let Some(m) = self
            .moons
            .iter()
            .filter(|m| path.starts_with(&m.path))
            .max_by_key(|m| m.path.as_os_str().len())
        {
            return Some((m.planet_id.clone(), Some(m.id.clone())));
        }
        self.planets
            .iter()
            .filter(|p| path.starts_with(&p.path))
            .max_by_key(|p| p.path.as_os_str().len())
            .map(|p| (p.id.clone(), None))
    }

    pub fn blocked_count(&self) -> usize {
        self.blobs.iter().filter(|b| b.blocked.is_some()).count()
    }
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

pub fn data_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(home).join("knoware")
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> anyhow::Result<()> {
    std::fs::create_dir_all(data_dir())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

pub fn load_world() -> World {
    let mut world: World = read_json(&data_dir().join("world.json"));
    // Nothing is live after a restart: every blob comes back offline, with no stale prompts.
    for b in &mut world.blobs {
        b.activity = Activity::Offline;
        b.blocked = None;
        b.subagents = 0;
    }
    world
}

pub fn save_world(world: &World) -> anyhow::Result<()> {
    write_json(&data_dir().join("world.json"), world)
}

pub fn load_settings() -> Settings {
    let path = data_dir().join("settings.json");
    let settings: Settings = read_json(&path);
    if !path.exists() {
        let _ = write_json(&path, &settings);
    }
    settings
}

/// Linear-style issue keys (e.g. `eng-142`) found in a branch name.
pub fn issue_keys(branch: &str) -> Vec<String> {
    branch
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .flat_map(|part| {
            let pieces: Vec<&str> = part.split('-').collect();
            pieces
                .windows(2)
                .filter(|w| {
                    (2..=5).contains(&w[0].len())
                        && w[0].chars().all(|c| c.is_ascii_alphabetic())
                        && !w[1].is_empty()
                        && w[1].chars().all(|c| c.is_ascii_digit())
                })
                .map(|w| format!("{}-{}", w[0].to_uppercase(), w[1]))
                .collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_issue_keys_in_branches() {
        assert_eq!(issue_keys("zeb/eng-142-fix-auth"), vec!["ENG-142"]);
        assert_eq!(issue_keys("feature/no-issue"), Vec::<String>::new());
        assert_eq!(issue_keys("abc-1-and-de-22"), vec!["ABC-1", "DE-22"]);
    }

    #[test]
    fn locates_deepest_match() {
        let world = World {
            planets: vec![Planet {
                id: "p".into(),
                name: "api".into(),
                path: "/src/api".into(),
                is_repo: true,
            }],
            moons: vec![Moon {
                id: "m".into(),
                planet_id: "p".into(),
                branch: "x".into(),
                path: "/wt/api/x".into(),
                dirty: false,
            }],
            blobs: vec![],
        };
        assert_eq!(
            world.locate(Path::new("/src/api/sub")),
            Some(("p".into(), None))
        );
        assert_eq!(
            world.locate(Path::new("/wt/api/x")),
            Some(("p".into(), Some("m".into())))
        );
        assert_eq!(world.locate(Path::new("/elsewhere")), None);
    }
}
