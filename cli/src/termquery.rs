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
/// Inside tmux, an *unwrapped* query like this doesn't reach the real terminal at
/// all: tmux answers XTVERSION (and the trailing status query) itself, on behalf
/// of the virtual terminal it presents to the pane, reporting its own name/version
/// instead of relaying the query outward. So this always wraps the query in tmux's
/// passthrough envelope (same mechanism `ratatui-image` uses for its own queries)
/// when running inside tmux, which makes tmux forward it to the actual outer
/// terminal instead of intercepting it. The reply doesn't need unwrapping — tmux
/// delivers terminal input (including query replies) to the pane's stdin exactly
/// like it does keystrokes, passthrough or not.
///
/// A trailing Device Status Report (`CSI 5n`) guarantees some reply so terminals that
/// don't implement XTVERSION don't leave us waiting out the full timeout.
pub fn is_wezterm() -> bool {
    let (start, escape, end) = ratatui_image::picker::cap_parser::Parser::tmux_start_escape_end(is_tmux());
    let query = format!("{start}{escape}[>q{escape}[5n{end}");

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdout = std::io::stdout();
        if stdout.write_all(query.as_bytes()).is_err() || stdout.flush().is_err() {
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

/// True when running inside a tmux client, mirroring the heuristic
/// `ratatui-image` itself uses internally (tmux sets one of these).
pub fn is_tmux() -> bool {
    std::env::var("TERM").is_ok_and(|term| term.starts_with("tmux"))
        || std::env::var("TERM_PROGRAM").is_ok_and(|term_program| term_program == "tmux")
}
