//! Where this `mdc` binary came from, whether its source has moved on since it
//! was built, and how to update it (`mdc --self-update`, or `U` in the TUI).
//!
//! The source is worked out from `CARGO_MANIFEST_DIR` (baked in at compile
//! time) plus where the running executable lives:
//! - a crates.io install builds out of `~/.cargo/registry/src/...`,
//! - a `cargo install --git` builds out of `~/.cargo/git/checkouts/...`,
//! - anything else is a local checkout, either run straight from its
//!   `target/` dir or installed with `cargo install --path`.
//!
//! For a local checkout the "pending changes" check only looks at git state
//! that's already on disk (no network): commits on HEAD since the build,
//! files edited after the binary was written, and upstream commits as of the
//! last `git fetch`. `--self-update` does the fetch.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::SystemTime;

const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");
const BUILT_COMMIT: &str = env!("GIT_HASH_FULL");
const CRATE_NAME: &str = env!("CARGO_PKG_NAME");
const GIT_URL: &str = env!("CARGO_PKG_REPOSITORY");

#[derive(Clone, Debug)]
pub enum Source {
    /// Built from a local git checkout.
    Local {
        /// The crate directory (`.../mdcmd/cli`).
        dir: PathBuf,
        /// How the binary got where it is.
        kind: LocalKind,
    },
    CratesIo,
    CargoGit,
    /// The build-time source directory is gone (or isn't a git checkout), so
    /// there's nothing to compare against or rebuild from.
    Unknown { dir: PathBuf },
}

#[derive(Clone, Debug)]
pub enum LocalKind {
    /// Running out of `<dir>/target/<profile>/`.
    BuildDir { profile: String },
    /// Copied elsewhere by `cargo install --path`; `root` is the install root
    /// when it isn't the default `~/.cargo`.
    Installed { root: Option<PathBuf> },
}

#[derive(Clone, Debug)]
pub struct Status {
    pub exe: Option<PathBuf>,
    pub source: Source,
    /// Human-readable reasons the binary is behind its source. Empty means up
    /// to date (as far as we can tell without the network).
    pub pending: Vec<String>,
    /// Whether `pending` could be computed at all (local checkouts only).
    pub checked: bool,
    /// Upstream has commits that a `git pull` would bring in.
    pub upstream_ahead: bool,
}

impl Status {
    /// One-line description of where this binary came from.
    pub fn source_line(&self) -> String {
        match &self.source {
            Source::Local { dir, kind } => {
                let how = match kind {
                    LocalKind::BuildDir { profile } => format!("run from target/{profile}"),
                    LocalKind::Installed { .. } => "cargo install --path".to_string(),
                };
                format!("local checkout {} ({how})", tilde(dir))
            }
            Source::CratesIo => "crates.io (cargo install mdc)".to_string(),
            Source::CargoGit => format!("git (cargo install --git {GIT_URL})"),
            Source::Unknown { dir } => format!("unknown (built from {}, no longer a git checkout)", tilde(dir)),
        }
    }

    /// One-line summary of the pending-changes check.
    pub fn pending_line(&self) -> String {
        if !self.checked {
            match self.source {
                Source::CratesIo | Source::CargoGit => {
                    "not checked (run the update command to fetch the latest)".to_string()
                }
                _ => "not checked".to_string(),
            }
        } else if self.pending.is_empty() {
            "up to date with source".to_string()
        } else {
            format!("out of date: {}", self.pending.join(", "))
        }
    }

    /// The plain shell command that updates this install, if there is one.
    pub fn update_command(&self) -> Option<String> {
        match &self.source {
            Source::Local { dir, kind } => {
                let mut cmd = format!("cd {}", shell_quote(&tilde(dir)));
                if self.upstream_ahead {
                    cmd.push_str(" && git pull --ff-only");
                }
                match kind {
                    LocalKind::BuildDir { profile } => {
                        cmd.push_str(" && cargo build");
                        cmd.push_str(&profile_flag(profile).map(|f| format!(" {f}")).unwrap_or_default());
                    }
                    LocalKind::Installed { root } => {
                        cmd.push_str(" && cargo install --locked --path .");
                        if let Some(root) = root {
                            cmd.push_str(&format!(" --root {}", shell_quote(&tilde(root))));
                        }
                    }
                }
                Some(cmd)
            }
            Source::CratesIo => Some(format!("cargo install --locked {CRATE_NAME}")),
            Source::CargoGit => Some(format!("cargo install --locked --git {GIT_URL} {CRATE_NAME}")),
            Source::Unknown { .. } => None,
        }
    }

    pub fn is_outdated(&self) -> bool {
        !self.pending.is_empty()
    }
}

static STATUS: OnceLock<Status> = OnceLock::new();

/// Computes the status once and caches it. Runs a few local git commands, so
/// the TUI kicks it off on a background thread at startup.
pub fn status() -> &'static Status {
    STATUS.get_or_init(compute)
}

/// The cached status, if it has finished computing.
pub fn cached_status() -> Option<&'static Status> {
    STATUS.get()
}

fn compute() -> Status {
    let exe = std::env::current_exe().ok().and_then(|p| p.canonicalize().ok().or(Some(p)));
    let source = detect_source(exe.as_deref());
    let mut status = Status { exe: exe.clone(), source, pending: Vec::new(), checked: false, upstream_ahead: false };

    if let Source::Local { dir, .. } = &status.source {
        let dir = dir.clone();
        status.checked = true;
        check_local(&dir, exe.as_deref(), &mut status);
    }
    status
}

fn detect_source(exe: Option<&Path>) -> Source {
    let dir = PathBuf::from(MANIFEST_DIR);
    let dir_str = MANIFEST_DIR.replace('\\', "/");
    if dir_str.contains("/.cargo/registry/") {
        return Source::CratesIo;
    }
    if dir_str.contains("/.cargo/git/checkouts/") {
        return Source::CargoGit;
    }
    if git(&dir, &["rev-parse", "--git-dir"]).is_none() {
        return Source::Unknown { dir };
    }

    let target = dir.join("target");
    let target = target.canonicalize().unwrap_or(target);
    let kind = match exe.and_then(|e| e.strip_prefix(&target).ok()) {
        Some(rel) => {
            // target/<profile>/mdc, or target/<triple>/<profile>/mdc
            let parts: Vec<_> = rel.iter().map(|p| p.to_string_lossy().into_owned()).collect();
            let profile = parts.len().checked_sub(2).map(|i| parts[i].clone()).unwrap_or_else(|| "debug".into());
            LocalKind::BuildDir { profile }
        }
        None => {
            // `cargo install` puts the binary in `<root>/bin`; only spell out
            // `--root` when it isn't the default.
            let root = exe
                .and_then(|e| e.parent())
                .filter(|bin| bin.file_name().is_some_and(|n| n == "bin"))
                .and_then(|bin| bin.parent())
                .map(|r| r.to_path_buf());
            let default_root = std::env::var_os("CARGO_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|h| h.join(".cargo")));
            let root = match (root, default_root) {
                (Some(r), Some(d)) if r == d || d.canonicalize().ok().as_ref() == Some(&r) => None,
                (r, _) => r,
            };
            LocalKind::Installed { root }
        }
    };
    Source::Local { dir, kind }
}

fn check_local(dir: &Path, exe: Option<&Path>, status: &mut Status) {
    let head = git(dir, &["rev-parse", "HEAD"]);
    let built_known = BUILT_COMMIT != "unknown";

    if let (Some(head), true) = (&head, built_known) {
        if head != BUILT_COMMIT {
            // Only commits touching the CLI crate count; GUI-only commits
            // don't change this binary.
            let range = format!("{BUILT_COMMIT}..HEAD");
            match git(dir, &["rev-list", "--count", &range, "--", "."]).and_then(|s| s.parse::<u32>().ok()) {
                Some(0) => {
                    // HEAD moved but nothing under cli/ changed, or HEAD isn't
                    // a descendant of the build commit (branch switch).
                    let is_ancestor = git_ok(dir, &["merge-base", "--is-ancestor", BUILT_COMMIT, "HEAD"]);
                    let differs = !git_ok(dir, &["diff", "--quiet", BUILT_COMMIT, "HEAD", "--", "."]);
                    if !is_ancestor && differs {
                        status.pending.push(format!("checkout is now on a different commit ({})", &head[..7.min(head.len())]));
                    }
                }
                Some(n) => status.pending.push(plural(n, "new commit", "new commits")),
                None => status.pending.push("build commit not found in checkout".to_string()),
            }
        }
    }

    // Uncommitted edits (tracked or new) made after the binary was written.
    if let Some(exe_mtime) = exe.and_then(mtime) {
        let mut files: Vec<String> = Vec::new();
        for args in [
            &["diff", "--name-only", "--relative", "HEAD", "--", "."][..],
            &["ls-files", "--others", "--exclude-standard", "--", "."][..],
        ] {
            if let Some(out) = git(dir, args) {
                files.extend(out.lines().map(str::to_string));
            }
        }
        files.sort();
        files.dedup();
        let edited = files
            .iter()
            .filter(|f| mtime(&dir.join(f)).is_some_and(|m| m > exe_mtime))
            .count() as u32;
        if edited > 0 {
            status.pending.push(format!("{} since build", plural(edited, "uncommitted file edited", "uncommitted files edited")));
        }
    }

    // Upstream commits as of the last fetch.
    if let Some(n) = git(dir, &["rev-list", "--count", "HEAD..@{u}", "--", "."]).and_then(|s| s.parse::<u32>().ok()) {
        if n > 0 {
            status.upstream_ahead = true;
            status.pending.push(format!("{} upstream (as of last fetch)", plural(n, "commit", "commits")));
        }
    }
}

/// Runs the update for this install, streaming its output to the terminal.
/// Returns `Ok(true)` when a new binary was built.
pub fn self_update() -> anyhow::Result<bool> {
    let status = status();
    println!("mdc {} — installed from {}", env!("CARGO_PKG_VERSION"), status.source_line());

    match &status.source {
        Source::Local { dir, kind } => {
            println!("\n→ git fetch");
            if !run(Command::new("git").arg("-C").arg(dir).arg("fetch")) {
                println!("  (fetch failed; continuing with what's on disk)");
            }
            let behind = git(dir, &["rev-list", "--count", "HEAD..@{u}"]).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            if behind > 0 {
                println!("\n→ git pull --ff-only ({})", plural(behind, "commit", "commits"));
                if !run(Command::new("git").arg("-C").arg(dir).args(["pull", "--ff-only"])) {
                    println!("  (pull failed; rebuilding the checkout as it is)");
                }
            }
            let mut cmd = Command::new("cargo");
            cmd.current_dir(dir);
            match kind {
                LocalKind::BuildDir { profile } => {
                    cmd.arg("build");
                    if let Some(f) = profile_flag(profile) {
                        cmd.args(f.split(' '));
                    }
                }
                LocalKind::Installed { root } => {
                    cmd.args(["install", "--locked", "--path", "."]);
                    if let Some(root) = root {
                        cmd.arg("--root").arg(root);
                    }
                }
            }
            println!("\n→ {}", describe(&cmd));
            Ok(run(&mut cmd))
        }
        Source::CratesIo => {
            let mut cmd = Command::new("cargo");
            cmd.args(["install", "--locked", CRATE_NAME]);
            println!("\n→ {}", describe(&cmd));
            Ok(run(&mut cmd))
        }
        Source::CargoGit => {
            let mut cmd = Command::new("cargo");
            cmd.args(["install", "--locked", "--git", GIT_URL, CRATE_NAME]);
            println!("\n→ {}", describe(&cmd));
            Ok(run(&mut cmd))
        }
        Source::Unknown { .. } => {
            anyhow::bail!("don't know how to update this install; reinstall it the way it was installed")
        }
    }
}

/// Lines for `--version`.
pub fn version_details() -> String {
    let s = status();
    let mut out = format!("source:  {}\nstatus:  {}", s.source_line(), s.pending_line());
    if let Some(exe) = &s.exe {
        out = format!("binary:  {}\n{out}", tilde(exe));
    }
    if s.is_outdated() || !s.checked {
        if s.update_command().is_some() {
            out.push_str("\nupdate:  mdc --self-update");
        }
    }
    out
}

fn profile_flag(profile: &str) -> Option<String> {
    match profile {
        "debug" => None,
        "release" => Some("--release".into()),
        other => Some(format!("--profile {other}")),
    }
}

fn run(cmd: &mut Command) -> bool {
    match cmd.status() {
        Ok(s) => s.success(),
        Err(e) => {
            eprintln!("  failed to run {}: {e}", cmd.get_program().to_string_lossy());
            false
        }
    }
}

fn describe(cmd: &Command) -> String {
    let mut s = cmd.get_program().to_string_lossy().into_owned();
    for a in cmd.get_args() {
        s.push(' ');
        s.push_str(&a.to_string_lossy());
    }
    if let Some(dir) = cmd.get_current_dir() {
        s.push_str(&format!("   (in {})", tilde(dir)));
    }
    s
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn git_ok(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .is_ok_and(|o| o.status.success())
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn tilde(p: &Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(rest) = p.strip_prefix(&home) {
            return format!("~/{}", rest.display());
        }
    }
    p.display().to_string()
}

fn shell_quote(s: &str) -> String {
    // Keep a leading `~/` outside the quotes so the shell still expands it.
    let (prefix, rest) = s.strip_prefix("~/").map_or(("", s), |r| ("~/", r));
    if rest.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c)) {
        s.to_string()
    } else {
        format!("{prefix}'{}'", rest.replace('\'', r"'\''"))
    }
}
