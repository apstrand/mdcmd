use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Capture the git commit the binary is built from so the TUI help screen can
/// display detailed version information. Emits `GIT_HASH` (short),
/// `GIT_COMMIT_DATE` (YYYY-MM-DD), `GIT_DIRTY` (`clean`/`dirty`/`unknown` —
/// whether tracked files differed from HEAD at build time), and `BUILD_DATE`
/// (YYYY-MM-DD, UTC, when `cargo build` ran) as compile-time env vars. Git
/// fields fall back to "unknown" when git isn't available (e.g. building
/// from a source tarball).
fn main() {
    let hash = git(&["rev-parse", "--short", "HEAD"]);
    let date = git(&["log", "-1", "--format=%cd", "--date=short"]);
    let dirty = git_dirty();

    println!("cargo:rustc-env=GIT_HASH={hash}");
    println!("cargo:rustc-env=GIT_COMMIT_DATE={date}");
    println!("cargo:rustc-env=GIT_DIRTY={dirty}");
    println!("cargo:rustc-env=BUILD_DATE={}", build_date());

    // Rebuild when HEAD moves, or the index/worktree changes, so the
    // embedded info stays current.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs");
    println!("cargo:rerun-if-changed=../.git/index");
}

fn git(args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Whether tracked files have uncommitted changes relative to HEAD.
/// Untracked files are ignored — they don't modify the commit being built.
fn git_dirty() -> &'static str {
    match Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .output()
    {
        Ok(o) if o.status.success() => {
            if o.stdout.is_empty() { "clean" } else { "dirty" }
        }
        _ => "unknown",
    }
}

/// Current UTC date as YYYY-MM-DD, computed from `SystemTime` without a
/// chrono/time dependency (Howard Hinnant's `civil_from_days`:
/// http://howardhinnant.github.io/date_algorithms.html).
fn build_date() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d) = civil_from_days((secs / 86400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
