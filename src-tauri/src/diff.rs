//! Uncommitted work in a checkout: `git diff HEAD --numstat` plus untracked files.
//! Drives the construction sites drawn on planets and moons.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

/// How many changed files to keep for the hover card, biggest churn first.
const TOP_FILES: usize = 6;
/// Untracked files bigger than this aren't read for a line count.
const MAX_UNTRACKED_BYTES: u64 = 1 << 20;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub insertions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiffStat {
    /// Changed tracked files plus untracked files.
    pub files: u64,
    pub insertions: u64,
    pub deletions: u64,
    pub untracked: u64,
    pub top: Vec<FileDiff>,
}

impl DiffStat {
    pub fn is_dirty(&self) -> bool {
        self.files > 0
    }
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Parse `git diff --numstat` output. Binary files (`-\t-\t`) count as changed with no lines.
pub fn parse_numstat(out: &str) -> Vec<FileDiff> {
    out.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let ins = parts.next()?;
            let del = parts.next()?;
            let path = parts.next()?.to_string();
            Some(FileDiff {
                path,
                insertions: ins.parse().unwrap_or(0),
                deletions: del.parse().unwrap_or(0),
            })
        })
        .collect()
}

pub fn summarize(mut files: Vec<FileDiff>, untracked: u64) -> DiffStat {
    let insertions = files.iter().map(|f| f.insertions).sum();
    let deletions = files.iter().map(|f| f.deletions).sum();
    let count = files.len() as u64;
    files.sort_by(|a, b| {
        (b.insertions + b.deletions)
            .cmp(&(a.insertions + a.deletions))
            .then(a.path.cmp(&b.path))
    });
    files.truncate(TOP_FILES);
    DiffStat {
        files: count,
        insertions,
        deletions,
        untracked,
        top: files,
    }
}

fn line_count(path: &Path) -> u64 {
    let small = std::fs::metadata(path).is_ok_and(|m| m.len() <= MAX_UNTRACKED_BYTES);
    if !small {
        return 0;
    }
    std::fs::read(path).map(|b| bytecount(&b)).unwrap_or(0)
}

fn bytecount(bytes: &[u8]) -> u64 {
    let lines = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
    lines + u64::from(bytes.last().is_some_and(|&b| b != b'\n'))
}

/// Uncommitted changes in a checkout. Empty for plain dirs or repos with no commits.
pub fn diff_stat(dir: &Path) -> DiffStat {
    let Some(numstat) = git(dir, &["diff", "HEAD", "--numstat", "--no-renames"]) else {
        return DiffStat::default();
    };
    let mut files = parse_numstat(&numstat);
    let untracked = git(dir, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();
    let untracked: Vec<&str> = untracked.lines().collect();
    // New files count as all-insertions, so a fresh module shows up as construction too.
    files.extend(untracked.iter().take(200).map(|p| FileDiff {
        path: p.to_string(),
        insertions: line_count(&dir.join(p)),
        deletions: 0,
    }));
    let extra = untracked.len().saturating_sub(200);
    let mut stat = summarize(files, untracked.len() as u64);
    stat.files += extra as u64;
    stat
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_numstat_including_binary() {
        let files = parse_numstat("10\t2\tsrc/a.rs\n-\t-\tlogo.png\n0\t7\tREADME.md\n");
        assert_eq!(files.len(), 3);
        assert_eq!(
            files[1],
            FileDiff {
                path: "logo.png".into(),
                insertions: 0,
                deletions: 0
            }
        );
        let stat = summarize(files, 0);
        assert_eq!((stat.files, stat.insertions, stat.deletions), (3, 10, 9));
        assert_eq!(stat.top[0].path, "src/a.rs");
    }

    #[test]
    fn counts_lines() {
        assert_eq!(bytecount(b"a\nb\n"), 2);
        assert_eq!(bytecount(b"a\nb"), 2);
        assert_eq!(bytecount(b""), 0);
    }

    #[test]
    fn reads_a_real_checkout() {
        let dir = std::env::temp_dir().join(format!("knoware-diff-{}", crate::world::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .unwrap();
        };
        run(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        run(&["add", "."]);
        run(&[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            "init",
        ]);
        assert!(!diff_stat(&dir).is_dirty());

        std::fs::write(dir.join("a.txt"), "one\nthree\nfour\n").unwrap();
        std::fs::write(dir.join("new.txt"), "x\ny\nz\n").unwrap();
        let stat = diff_stat(&dir);
        assert_eq!(
            (stat.files, stat.insertions, stat.deletions, stat.untracked),
            (2, 5, 1, 1)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
