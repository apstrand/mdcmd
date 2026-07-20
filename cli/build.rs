use std::process::Command;

/// Capture the git commit the binary is built from so the TUI help screen can
/// display detailed version information. Emits `GIT_HASH` (short) and
/// `GIT_COMMIT_DATE` (YYYY-MM-DD) as compile-time env vars, falling back to
/// "unknown" when git isn't available (e.g. building from a source tarball).
fn main() {
    let hash = git(&["rev-parse", "--short", "HEAD"]);
    let date = git(&["log", "-1", "--format=%cd", "--date=short"]);

    println!("cargo:rustc-env=GIT_HASH={hash}");
    println!("cargo:rustc-env=GIT_COMMIT_DATE={date}");

    // Rebuild when HEAD moves so the embedded info stays current.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs");
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
