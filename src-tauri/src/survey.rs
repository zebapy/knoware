//! Surveys a planet's directory for the traits its look is generated from:
//! dominant language, size and age. Everything here is deterministic for a given tree.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Traits {
    /// Most common language by file count, from an allowlist of known extensions.
    pub language: Option<String>,
    /// Share of files in the dominant language, 0..=100.
    pub language_pct: u8,
    /// Tracked files (repos) or files found in a bounded walk (plain dirs).
    pub files: u64,
    /// Commits on HEAD; 0 for plain dirs.
    pub commits: u64,
}

/// Extensions that count toward a language. Anything not listed is ignored.
const LANGUAGES: &[(&str, &[&str])] = &[
    ("rust", &["rs"]),
    ("typescript", &["ts", "tsx", "mts", "cts"]),
    ("javascript", &["js", "jsx", "mjs", "cjs", "vue", "svelte"]),
    ("python", &["py", "pyi", "ipynb"]),
    ("go", &["go"]),
    ("ruby", &["rb", "erb", "rake"]),
    ("java", &["java", "kt", "kts", "scala", "groovy"]),
    ("c", &["c", "h", "cc", "cpp", "hpp", "cxx", "zig"]),
    ("csharp", &["cs", "fs", "vb"]),
    ("swift", &["swift", "m", "mm"]),
    ("elixir", &["ex", "exs", "erl", "gleam"]),
    ("php", &["php"]),
    ("haskell", &["hs", "ml", "mli", "elm", "clj", "cljs"]),
    ("shell", &["sh", "bash", "zsh", "fish", "nix"]),
    ("prose", &["md", "mdx", "txt", "org", "rst", "tex"]),
];

fn language_of(file: &str) -> Option<&'static str> {
    let ext = Path::new(file).extension()?.to_str()?.to_ascii_lowercase();
    LANGUAGES
        .iter()
        .find(|(_, exts)| exts.contains(&ext.as_str()))
        .map(|(lang, _)| *lang)
}

pub fn from_files<'a>(files: impl IntoIterator<Item = &'a str>, commits: u64) -> Traits {
    let mut counts: HashMap<&str, u64> = HashMap::new();
    let mut total = 0;
    let mut known = 0;
    for f in files {
        total += 1;
        if let Some(lang) = language_of(f) {
            known += 1;
            *counts.entry(lang).or_default() += 1;
        }
    }
    // Ties break by name so the result never depends on hash order.
    let top = counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0)));
    Traits {
        language: top.map(|(l, _)| l.to_string()),
        language_pct: top.map_or(0, |(_, n)| (n * 100 / known.max(1)) as u8),
        files: total,
        commits,
    }
}

fn git_out(dir: &Path, args: &[&str]) -> Option<String> {
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

/// Plain directories: a bounded walk that skips hidden and dependency folders.
fn walk(dir: &Path, depth: u32, out: &mut Vec<String>) {
    const SKIP: &[&str] = &[
        "node_modules",
        "target",
        "dist",
        "build",
        "vendor",
        "__pycache__",
    ];
    if depth > 4 || out.len() >= 5000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || SKIP.contains(&name.as_str()) {
            continue;
        }
        let path = e.path();
        if path.is_dir() {
            walk(&path, depth + 1, out);
        } else {
            out.push(name);
        }
        if out.len() >= 5000 {
            return;
        }
    }
}

pub fn survey(path: &Path, is_repo: bool) -> Traits {
    if is_repo {
        let files = git_out(path, &["ls-files"]).unwrap_or_default();
        let commits = git_out(path, &["rev-list", "--count", "HEAD"])
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        return from_files(files.lines(), commits);
    }
    let mut files = Vec::new();
    walk(path, 0, &mut files);
    from_files(files.iter().map(String::as_str), 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_dominant_language_from_allowlist() {
        let t = from_files(
            [
                "src/main.rs",
                "src/lib.rs",
                "web/app.ts",
                "README.md",
                "Cargo.lock",
                "logo.png",
            ],
            7,
        );
        assert_eq!(t.language.as_deref(), Some("rust"));
        assert_eq!(t.language_pct, 50);
        assert_eq!(t.files, 6);
        assert_eq!(t.commits, 7);
    }

    #[test]
    fn breaks_ties_by_name_and_handles_unknown() {
        let t = from_files(["a.rs", "b.go"], 0);
        assert_eq!(t.language.as_deref(), Some("go"));
        assert_eq!(from_files(["a.bin", "b.dat"], 0).language, None);
    }
}
