//! The signals layer: PR + CI state from GitHub (via the `gh` CLI), issue keys from branch
//! names, and keeping moons in sync with the worktrees git actually has.

use crate::diff::{self, DiffStat};
use crate::git;
use crate::state::Shared;
use crate::world::{self, Activity, CiState, Moon, Planet, PrSignal, PrState, World};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// Conclusions that count as a passing check. Anything not listed here or in FAILING is still running.
const PASSING: &[&str] = &["SUCCESS", "NEUTRAL", "SKIPPED"];
const FAILING: &[&str] = &[
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
];

fn rfc3339_ms(s: &str) -> u64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis().max(0) as u64)
        .unwrap_or(0)
}

pub fn ci_state(rollup: &Value) -> CiState {
    let checks = rollup.as_array().map(Vec::as_slice).unwrap_or_default();
    if checks.is_empty() {
        return CiState::None;
    }
    // Check runs report `conclusion`; commit statuses report `state`.
    let outcome = |c: &Value| {
        c["conclusion"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or(c["state"].as_str())
            .unwrap_or_default()
            .to_string()
    };
    let outcomes: Vec<String> = checks.iter().map(outcome).collect();
    if outcomes.iter().any(|o| FAILING.contains(&o.as_str())) {
        CiState::Failing
    } else if outcomes.iter().all(|o| PASSING.contains(&o.as_str())) {
        CiState::Passing
    } else {
        CiState::Running
    }
}

pub fn parse_prs(json: &str) -> HashMap<String, PrSignal> {
    let list: Vec<Value> = serde_json::from_str(json).unwrap_or_default();
    let mut by_branch: HashMap<String, PrSignal> = HashMap::new();
    for pr in list {
        let state = match pr["state"].as_str().unwrap_or_default() {
            "OPEN" => PrState::Open,
            "MERGED" => PrState::Merged,
            "CLOSED" => PrState::Closed,
            _ => continue,
        };
        let signal = PrSignal {
            number: pr["number"].as_u64().unwrap_or(0),
            url: pr["url"].as_str().unwrap_or_default().to_string(),
            state,
            ci: ci_state(&pr["statusCheckRollup"]),
            updated_ms: rfc3339_ms(pr["updatedAt"].as_str().unwrap_or_default()),
        };
        let branch = pr["headRefName"].as_str().unwrap_or_default().to_string();
        // An open PR wins over older closed ones on the same branch; otherwise the newest wins.
        let keep_old = by_branch.get(&branch).is_some_and(|old| {
            let old_open = old.state == PrState::Open;
            let new_open = state == PrState::Open;
            (old_open && !new_open) || (old_open == new_open && old.updated_ms >= signal.updated_ms)
        });
        if !keep_old {
            by_branch.insert(branch, signal);
        }
    }
    by_branch
}

fn fetch_prs(repo: &Path) -> HashMap<String, PrSignal> {
    let out = Command::new("gh")
        .current_dir(repo)
        .args([
            "pr",
            "list",
            "--state",
            "all",
            "--limit",
            "100",
            "--json",
            "number,url,state,headRefName,updatedAt,statusCheckRollup",
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => parse_prs(&String::from_utf8_lossy(&o.stdout)),
        _ => HashMap::new(),
    }
}

/// Add moons for worktrees made outside the app; drop moons whose worktree is gone.
/// Returns the ids of dropped moons.
fn sync_moons(world: &mut World, planet: &Planet) -> Vec<String> {
    let Ok(trees) = git::worktrees(&planet.path) else {
        return Vec::new();
    };
    for t in &trees {
        if !world.moons.iter().any(|m| m.path == t.path) {
            world.moons.push(Moon {
                id: world::new_id(),
                planet_id: planet.id.clone(),
                branch: t.branch.clone().unwrap_or_else(|| "detached".into()),
                path: t.path.clone(),
                dirty: false,
                diff: Default::default(),
            });
        }
    }
    let gone: Vec<String> = world
        .moons
        .iter()
        .filter(|m| m.planet_id == planet.id && !trees.iter().any(|t| t.path == m.path))
        .map(|m| m.id.clone())
        .collect();
    for id in &gone {
        drop_moon(world, id, planet);
    }
    gone
}

/// Remove a moon from the world; its blobs fall to the planet root and go dormant.
pub fn drop_moon(world: &mut World, moon_id: &str, planet: &Planet) {
    world.moons.retain(|m| m.id != moon_id);
    for b in world
        .blobs
        .iter_mut()
        .filter(|b| b.moon_id.as_deref() == Some(moon_id))
    {
        b.moon_id = None;
        b.cwd = planet.path.clone();
        b.activity = Activity::Offline;
        b.blocked = None;
    }
}

/// One pass over every repo planet. Blocking: shells out to git and gh.
/// Re-survey every planet so its look follows the code as it changes.
fn survey_planets(app: &Shared) {
    for p in app.snapshot().planets {
        let traits = crate::survey::survey(&p.path, p.is_repo);
        let mut world = app.world.lock().unwrap();
        if let Some(planet) = world.planets.iter_mut().find(|q| q.id == p.id) {
            planet.traits = traits;
        }
    }
}

/// Recompute uncommitted work for every planet root and moon. Returns true when anything changed.
pub fn refresh_diffs(app: &Shared) -> bool {
    let world = app.snapshot();
    let roots: Vec<(String, DiffStat)> = world
        .planets
        .iter()
        .filter(|p| p.is_repo)
        .map(|p| (p.id.clone(), diff::diff_stat(&p.path)))
        .collect();
    let moons: Vec<(String, DiffStat)> = world
        .moons
        .iter()
        .map(|m| (m.id.clone(), diff::diff_stat(&m.path)))
        .collect();
    let mut changed = false;
    let mut world = app.world.lock().unwrap();
    for (id, stat) in roots {
        if let Some(p) = world
            .planets
            .iter_mut()
            .find(|p| p.id == id)
            .filter(|p| p.diff != stat)
        {
            p.diff = stat;
            changed = true;
        }
    }
    for (id, stat) in moons {
        if let Some(m) = world
            .moons
            .iter_mut()
            .find(|m| m.id == id)
            .filter(|m| m.diff != stat)
        {
            m.dirty = stat.is_dirty();
            m.diff = stat;
            changed = true;
        }
    }
    changed
}

pub fn refresh(app: &Shared) {
    survey_planets(app);
    refresh_diffs(app);
    let planets: Vec<Planet> = app
        .snapshot()
        .planets
        .into_iter()
        .filter(|p| p.is_repo)
        .collect();
    let mut dropped = Vec::new();
    for planet in &planets {
        let prs = fetch_prs(&planet.path);
        let root_branch = git::current_branch(&planet.path);
        let moons: Vec<Moon> = {
            let mut world = app.world.lock().unwrap();
            dropped.extend(sync_moons(&mut world, planet));
            world
                .moons
                .iter()
                .filter(|m| m.planet_id == planet.id)
                .cloned()
                .collect()
        };
        let mut cleanup = Vec::new();
        {
            let mut world = app.world.lock().unwrap();
            for m in world.moons.iter_mut().filter(|m| m.planet_id == planet.id) {
                let merged = prs
                    .get(&m.branch)
                    .is_some_and(|p| p.state == PrState::Merged);
                if app.settings.auto_cleanup_merged_moons && merged && !m.dirty {
                    cleanup.push(m.clone());
                }
            }
            for b in world.blobs.iter_mut().filter(|b| b.planet_id == planet.id) {
                let branch = match &b.moon_id {
                    Some(mid) => moons
                        .iter()
                        .find(|m| &m.id == mid)
                        .map(|m| m.branch.clone()),
                    None => root_branch.clone(),
                };
                b.pr = branch.as_ref().and_then(|br| prs.get(br).cloned());
                b.issues = branch.as_deref().map(world::issue_keys).unwrap_or_default();
            }
        }
        for m in cleanup {
            let live = app.snapshot().blobs.iter().any(|b| {
                b.moon_id.as_deref() == Some(m.id.as_str()) && b.activity != Activity::Offline
            });
            if !live && git::remove_worktree(&planet.path, &m.path, false).is_ok() {
                drop_moon(&mut app.world.lock().unwrap(), &m.id, planet);
                dropped.push(m.id);
            }
        }
    }
    if !dropped.is_empty() {
        let _ = tauri::Emitter::emit(&app.handle, "moons-dropped", &dropped);
    }
    app.world_changed();
}

pub fn start_polling(app: Shared) {
    // Diffs move fast while agents work, so they get their own quicker loop.
    let diffs = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(diffs.settings.diff_poll_secs.max(2)));
            if refresh_diffs(&diffs) {
                diffs.world_changed();
            }
        }
    });
    std::thread::spawn(move || {
        loop {
            refresh(&app);
            std::thread::sleep(Duration::from_secs(app.settings.signals_poll_secs.max(15)));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_ci() {
        assert_eq!(ci_state(&json!([])), CiState::None);
        assert_eq!(
            ci_state(&json!([{"conclusion": "SUCCESS"}, {"state": "SUCCESS"}])),
            CiState::Passing
        );
        assert_eq!(
            ci_state(&json!([{"conclusion": "SUCCESS"}, {"conclusion": ""}])),
            CiState::Running
        );
        assert_eq!(
            ci_state(&json!([{"conclusion": "FAILURE"}, {"conclusion": ""}])),
            CiState::Failing
        );
        assert_eq!(ci_state(&json!([{"state": "PENDING"}])), CiState::Running);
    }

    #[test]
    fn open_pr_wins_per_branch() {
        let prs = parse_prs(
            &json!([
                {"number": 1, "url": "u1", "state": "CLOSED", "headRefName": "a", "updatedAt": "2026-09-30T00:00:00Z", "statusCheckRollup": []},
                {"number": 2, "url": "u2", "state": "OPEN", "headRefName": "a", "updatedAt": "2026-09-01T00:00:00Z", "statusCheckRollup": [{"conclusion": "FAILURE"}]},
            ])
            .to_string(),
        );
        let a = &prs["a"];
        assert_eq!(a.number, 2);
        assert_eq!(a.ci, CiState::Failing);
        assert!(a.updated_ms > 0);
    }
}
