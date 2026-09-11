#[cfg(not(unix))]
use std::io::Read;
use std::io::Write;
#[cfg(not(unix))]
use std::sync::mpsc;
use std::time::Duration;

/// Writes `query` to the terminal and feeds everything that comes back on stdin
/// to `extract` until it produces a value.
///
/// Every query here ends with a Device Status Report (`CSI 5n`); its `CSI 0n`
/// reply means the terminal has said everything it is going to, so we give up
/// there instead of waiting out the timeout on terminals that ignore the
/// interesting part of the query.
///
/// The timeout is enforced by waiting for readable input with `poll(2)` before
/// each read, so giving up actually stops reading. Doing the read on a helper
/// thread instead (which is the only way to abandon a *blocking* read) leaves
/// that thread parked in `read` for the life of the process, where it goes on
/// stealing bytes from stdin — the user's keystrokes — that crossterm never
/// sees. That's not hypothetical: a terminal only has to fail to answer one
/// query (tmux with no attached client, or an outer terminal that ignores
/// OSC 11 over ssh) and the app then drops keys at random forever.
///
/// Reads go to the raw file descriptor rather than through `io::Stdin`, whose
/// internal `BufReader` would swallow anything that arrives in the same read
/// as the reply — again, keystrokes crossterm would then never see.
///
/// Assumes raw mode is already enabled (the TUI startup path does that before
/// any of this runs), so replies arrive as plain bytes rather than line input.
#[cfg(unix)]
fn query_stdio<T, F>(query: String, extract: F, timeout: Duration) -> Option<T>
where
    T: Send + 'static,
    F: Fn(&str) -> Option<T> + Send + 'static,
{
    use std::os::fd::AsRawFd;

    let mut stdout = std::io::stdout();
    if stdout.write_all(query.as_bytes()).is_err() || stdout.flush().is_err() {
        return None;
    }

    let fd = std::io::stdin().as_raw_fd();
    let deadline = std::time::Instant::now() + timeout;
    let mut response = String::new();
    let mut chunk = [0u8; 256];
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        let ready = unsafe {
            libc::poll(&mut pfd, 1, remaining.as_millis().min(i32::MAX as u128) as i32)
        };
        if ready <= 0 {
            // Timed out, or the poll failed; either way stop reading.
            return None;
        }
        let n = unsafe { libc::read(fd, chunk.as_mut_ptr() as *mut libc::c_void, chunk.len()) };
        if n <= 0 {
            return None;
        }
        response.push_str(&String::from_utf8_lossy(&chunk[..n as usize]));
        if let Some(value) = extract(&response) {
            return Some(value);
        }
        if response.contains("\x1b[0n") {
            return None;
        }
    }
}

/// Non-Unix fallback: no `poll(2)`, so the read has to run on a helper thread
/// that outlives the timeout. See the Unix version above for what that costs.
#[cfg(not(unix))]
fn query_stdio<T, F>(query: String, extract: F, timeout: Duration) -> Option<T>
where
    T: Send + 'static,
    F: Fn(&str) -> Option<T> + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdout = std::io::stdout();
        if stdout.write_all(query.as_bytes()).is_err() || stdout.flush().is_err() {
            let _ = tx.send(None);
            return;
        }
        let mut stdin = std::io::stdin();
        let mut response = String::new();
        let mut chunk = [0u8; 256];
        loop {
            match stdin.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
                Ok(n) => {
                    response.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    if let Some(value) = extract(&response) {
                        let _ = tx.send(Some(value));
                        return;
                    }
                    if response.contains("\x1b[0n") {
                        let _ = tx.send(None);
                        return;
                    }
                }
            }
        }
    });

    rx.recv_timeout(timeout).ok().flatten()
}

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

    query_stdio(
        query,
        |response| response.contains("WezTerm").then_some(()),
        Duration::from_millis(1000),
    )
    .is_some()
}

/// Asks the terminal for its background color with OSC 11, so the palette can
/// match a light terminal instead of assuming dark.
///
/// Unlike [`is_wezterm`], this query is deliberately *not* wrapped in tmux's
/// passthrough envelope. tmux runs its own OSC 11 query against the outer
/// terminal and consumes that reply out of the client's input stream itself, so
/// a passed-through query is relayed outward but its answer never reaches the
/// pane — it just disappears, and we time out having learned nothing. (This is
/// why `ratatui-image`'s bundled `terminal_background_color_osc` query, which is
/// always passthrough-wrapped inside tmux, comes back empty there.) Sent
/// unwrapped, tmux answers on the outer terminal's behalf with the color it
/// already knows. Outside tmux the query reaches the real terminal either way.
///
/// The trailing Device Status Report bounds the wait for terminals that don't
/// implement OSC 11 at all.
pub fn query_background() -> Option<(u8, u8, u8)> {
    query_stdio(
        "\x1b]11;?\x07\x1b[5n".to_string(),
        parse_osc_background,
        Duration::from_millis(1000),
    )
}

/// Pulls the RGB triple out of an OSC 11 reply
/// (`ESC ] 11 ; rgb:RRRR/GGGG/BBBB` terminated by BEL or ST). Returns `None`
/// until the terminator has arrived, since this is fed a response that is still
/// being read.
fn parse_osc_background(response: &str) -> Option<(u8, u8, u8)> {
    let body = response.split("rgb:").nth(1)?;
    let terminator = body.find(['\x07', '\x1b'])?;
    let mut parts = body[..terminator].split('/');
    let rgb = (
        scale_hex_component(parts.next()?)?,
        scale_hex_component(parts.next()?)?,
        scale_hex_component(parts.next()?)?,
    );
    parts.next().is_none().then_some(rgb)
}

/// Scales one hex color component of an OSC reply down to 8 bits. Replies are
/// most commonly 4 hex digits per channel, but the format allows 1 to 4 and
/// some terminals answer with 2, so the component is scaled by its own width
/// rather than assumed to be 16-bit.
fn scale_hex_component(part: &str) -> Option<u8> {
    if part.is_empty() || part.len() > 4 {
        return None;
    }
    let value = u32::from_str_radix(part, 16).ok()?;
    let max = (1u32 << (4 * part.len())) - 1;
    Some(((value * 255 + max / 2) / max) as u8)
}

/// True when running inside a tmux client, mirroring the heuristic
/// `ratatui-image` itself uses internally (tmux sets one of these).
pub fn is_tmux() -> bool {
    std::env::var("TERM").is_ok_and(|term| term.starts_with("tmux"))
        || std::env::var("TERM_PROGRAM").is_ok_and(|term_program| term_program == "tmux")
}

#[cfg(test)]
mod tests {
    use super::parse_osc_background;

    #[test]
    fn parses_16_bit_bel_terminated_reply() {
        assert_eq!(
            parse_osc_background("\x1b]11;rgb:efef/f1f1/f5f5\x07"),
            Some((239, 241, 245))
        );
    }

    #[test]
    fn parses_st_terminated_reply() {
        assert_eq!(
            parse_osc_background("\x1b]11;rgb:0f0f/1717/2a2a\x1b\\"),
            Some((15, 23, 42))
        );
    }

    #[test]
    fn scales_narrow_components() {
        assert_eq!(parse_osc_background("]11;rgb:ff/80/00\x07"), Some((255, 128, 0)));
        assert_eq!(parse_osc_background("]11;rgb:f/8/0\x07"), Some((255, 136, 0)));
    }

    #[test]
    fn ignores_incomplete_or_malformed_replies() {
        assert_eq!(parse_osc_background("\x1b]11;rgb:efef/f1f1/f5"), None);
        assert_eq!(parse_osc_background("\x1b[0n"), None);
        assert_eq!(parse_osc_background("]11;rgb:efef/f1f1\x07"), None);
        assert_eq!(parse_osc_background("]11;rgb:efef/f1f1/f5f5/ffff\x07"), None);
    }
}
