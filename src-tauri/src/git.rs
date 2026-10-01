//! Thin wrappers over the `git` CLI for planets (repo roots) and moons (worktrees).

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .context("failed to run git")?;
    if !out.status.success() {
        bail!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The main checkout's root for a path, or None when the path is not in a repo.
/// For a path inside a linked worktree this resolves to the main repo, so moons land on their planet.
pub fn repo_root(path: &Path) -> Option<PathBuf> {
    let common = git(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .ok()?;
    let common = PathBuf::from(common);
    if common.file_name().is_some_and(|n| n == ".git") {
        return common.parent().map(Path::to_path_buf);
    }
    git(path, &["rev-parse", "--show-toplevel"])
        .ok()
        .map(PathBuf::from)
}

pub fn current_branch(path: &Path) -> Option<String> {
    git(path, &["branch", "--show-current"])
        .ok()
        .filter(|b| !b.is_empty())
}

pub struct Worktree {
    pub path: PathBuf,
    pub branch: Option<String>,
}

/// Linked worktrees of a repo, excluding the main checkout.
pub fn worktrees(repo: &Path) -> Result<Vec<Worktree>> {
    let out = git(repo, &["worktree", "list", "--porcelain"])?;
    let mut list = Vec::new();
    for block in out.split("\n\n") {
        let mut path = None;
        let mut branch = None;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(p));
            }
            if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.trim_start_matches("refs/heads/").to_string());
            }
        }
        if let Some(path) = path {
            list.push(Worktree { path, branch });
        }
    }
    // The first entry is always the main checkout.
    Ok(list.into_iter().skip(1).collect())
}

pub fn add_worktree(repo: &Path, path: &Path, branch: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let p = path.to_string_lossy();
    let exists = git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok();
    if exists {
        git(repo, &["worktree", "add", &p, branch])?;
    } else {
        git(repo, &["worktree", "add", "-b", branch, &p])?;
    }
    Ok(())
}

pub fn remove_worktree(repo: &Path, path: &Path, force: bool) -> Result<()> {
    let p = path.to_string_lossy();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&p);
    git(repo, &args)?;
    Ok(())
}

pub fn is_dirty(path: &Path) -> bool {
    git(path, &["status", "--porcelain"]).is_ok_and(|s| !s.is_empty())
}

/// A branch name that is safe for git and for a directory name.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '/' {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches(|c| c == '-' || c == '/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_branch_names() {
        assert_eq!(slug("Fix the Auth bug!"), "fix-the-auth-bug");
        assert_eq!(slug("zeb/ENG-1 thing"), "zeb/eng-1-thing");
    }

    #[test]
    fn worktree_round_trip() {
        let dir = std::env::temp_dir().join(format!("knoware-git-{}", crate::world::new_id()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]).unwrap();
        git(
            &repo,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        )
        .unwrap();
        let repo = repo.canonicalize().unwrap();

        assert_eq!(repo_root(&repo).unwrap(), repo);
        let wt = dir.join("wt").join("feature");
        add_worktree(&repo, &wt, "feature").unwrap();
        let wt = wt.canonicalize().unwrap();
        assert_eq!(repo_root(&wt).unwrap(), repo);
        assert_eq!(current_branch(&wt).as_deref(), Some("feature"));

        let list = worktrees(&repo).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].branch.as_deref(), Some("feature"));
        assert!(!is_dirty(&wt));

        remove_worktree(&repo, &wt, false).unwrap();
        assert!(worktrees(&repo).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
