use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// Detects WezTerm by asking the terminal to self-report its name via XTVERSION
/// (`CSI > q`), which round-trips over the real terminal connection the same way
/// whether that's local or over SSH. This matters because `ratatui-image`'s own
/// WezTerm special-casing (it blacklists Kitty/Sixel and prefers the iTerm2 protocol,
/// since WezTerm's Kitty support has known gaps in "virtual placement" / unicode
/// placeholder mode) keys off the `WEZTERM_EXECUTABLE`/`TERM_PROGRAM` env vars WezTerm
/// sets locally. Those don't survive into a remote shell over SSH, so a remote session
/// silently falls through to the same accurate-but-broken Kitty capability query result
/// that a local session would have overridden.
///
/// A trailing Device Status Report (`CSI 5n`) guarantees some reply so terminals that
/// don't implement XTVERSION don't leave us waiting out the full timeout.
pub fn is_wezterm() -> bool {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdout = std::io::stdout();
        if stdout.write_all(b"\x1b[>q\x1b[5n").is_err() || stdout.flush().is_err() {
            let _ = tx.send(false);
            return;
        }
        let mut stdin = std::io::stdin();
        let mut response = String::new();
        let mut chunk = [0u8; 256];
        loop {
            match stdin.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(false);
                    return;
                }
                Ok(n) => {
                    response.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    if response.contains("WezTerm") {
                        let _ = tx.send(true);
                        return;
                    }
                    if response.contains("\x1b[0n") {
                        let _ = tx.send(false);
                        return;
                    }
                }
            }
        }
    });

    rx.recv_timeout(Duration::from_millis(1000)).unwrap_or(false)
}
