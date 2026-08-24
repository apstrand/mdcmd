use std::io;
use std::path::PathBuf;
use std::time::Duration;
use crossterm::{
    event::{self, Event},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    cursor::{Hide, Show},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use anyhow::Result;

mod config;
mod markdown;
mod palette;
mod termquery;
mod tui;

use tui::AppState;

const HELP: &str = "\
mdc — Terminal file browser and Markdown viewer

USAGE:
    mdc [OPTIONS] [PATH]

ARGS:
    <PATH>    Directory or file to open (defaults to the current directory)

OPTIONS:
    -g, --gui          Open the file (or current directory) in the MarkDown Commander GUI and exit
    -h, --help         Print help information
    -v, --version      Print version information
        --debug-image  Print detected terminal image-protocol capabilities and exit";

/// Version line shared by `-v`/`--version` and the top of `-h`/`--help`, and
/// mirrored in the TUI's welcome/help screen (see `tui::get_welcome_text`).
fn version_line() -> String {
    let dirty = match env!("GIT_DIRTY") {
        "dirty" => "-dirty",
        _ => "",
    };
    format!(
        "{} {} (commit {}{}, {}; built {})",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        env!("GIT_HASH"),
        dirty,
        env!("GIT_COMMIT_DATE"),
        env!("BUILD_DATE"),
    )
}

/// Runs the same terminal capability query the TUI uses at startup and prints
/// the result, without entering the alternate screen. Useful for diagnosing
/// why inline images fall back to halfblocks in a given terminal/session
/// (e.g. over SSH) without having to read escape-sequence output by eye.
fn debug_image() {
    for (name, val) in [
        "TERM",
        "TERM_PROGRAM",
        "WEZTERM_EXECUTABLE",
        "KONSOLE_VERSION",
        "SSH_TTY",
        "SSH_CONNECTION",
        "TMUX",
        "TMUX_PANE",
    ]
    .map(|name| (name, std::env::var(name)))
    {
        println!("{name}={val:?}");
    }

    println!("is_tmux={:?}", termquery::is_tmux());
    if let Ok(pane) = std::env::var("TMUX_PANE") {
        let allow_passthrough = std::process::Command::new("tmux")
            .args(["show-options", "-p", "-t", &pane, "-v", "allow-passthrough"])
            .output();
        match allow_passthrough {
            Ok(out) => println!(
                "tmux_allow_passthrough={:?}",
                String::from_utf8_lossy(&out.stdout).trim()
            ),
            Err(e) => println!("tmux_allow_passthrough query failed: {e:?}"),
        }
        let version = std::process::Command::new("tmux").arg("-V").output();
        match version {
            Ok(out) => println!("tmux_version={:?}", String::from_utf8_lossy(&out.stdout).trim()),
            Err(e) => println!("tmux_version query failed: {e:?}"),
        }
    }

    let raw_was_enabled = enable_raw_mode().is_ok();
    let picker = ratatui_image::picker::Picker::from_query_stdio_with_options(
        ratatui_image::picker::cap_parser::QueryStdioOptions {
            terminal_background_color_osc: true,
            ..Default::default()
        },
    );
    if raw_was_enabled {
        let _ = disable_raw_mode();
    }

    match picker {
        Ok(p) => {
            println!("protocol_type={:?}", p.protocol_type());
            println!("font_size={:?}", p.font_size());
            println!("capabilities={:?}", p.capabilities());
        }
        Err(e) => println!("query failed: {e:?}"),
    }

    println!("xtversion_is_wezterm={:?}", termquery::is_wezterm());
}

/// Tears the terminal down, stops the process with SIGTSTP (the same signal
/// the kernel would send for Ctrl-Z outside of raw mode), and restores the
/// terminal once the shell resumes us with SIGCONT. A no-op on non-Unix
/// platforms, which have no equivalent job-control signal.
fn suspend(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, Show)?;

    #[cfg(unix)]
    unsafe {
        libc::raise(libc::SIGTSTP);
    }

    enable_raw_mode()?;
    execute!(terminal.backend_mut(), EnterAlternateScreen, Hide)?;
    terminal.clear()?;
    Ok(())
}

/// Handles a command-line path that doesn't exist yet: asks the user whether
/// to create it. If yes, creates an empty file at that path and returns it so
/// the caller can proceed as if it had already existed. If no (or input
/// can't be read, e.g. non-interactive stdin), falls back to the path's
/// parent directory instead.
fn prompt_create_missing_path(path: &std::path::Path) -> Option<PathBuf> {
    print!("{} does not exist. Create it? [y/N] ", path.display());
    let _ = io::Write::flush(&mut io::stdout());

    let mut answer = String::new();
    let create = io::stdin().read_line(&mut answer).is_ok()
        && matches!(answer.trim().to_lowercase().as_str(), "y" | "yes");

    if create {
        match std::fs::File::create(path) {
            Ok(_) => Some(path.to_path_buf()),
            Err(e) => {
                eprintln!("Warning: failed to create {}: {e}", path.display());
                path.parent().map(|p| p.to_path_buf())
            }
        }
    } else {
        path.parent().map(|p| p.to_path_buf())
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    let mut launch_gui = false;
    for arg in &args[1..] {
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{}\n\n{HELP}", version_line());
                return Ok(());
            }
            "-v" | "--version" => {
                println!("{}", version_line());
                return Ok(());
            }
            "--debug-image" => {
                debug_image();
                return Ok(());
            }
            "-g" | "--gui" => launch_gui = true,
            _ => {}
        }
    }

    let path_arg = args[1..].iter().find(|a| !a.starts_with('-'));

    // `--gui` hands off to the desktop app instead of starting the TUI. If a
    // path was given, open it; otherwise just launch the app.
    if launch_gui {
        match path_arg {
            Some(arg) => tui::open_in_gui(arg)?,
            None => tui::launch_gui()?,
        }
        return Ok(());
    }
    let initial_path = if let Some(arg) = path_arg {
        let path = PathBuf::from(arg);
        if path.exists() {
            Some(path)
        } else {
            prompt_create_missing_path(&path)
        }
    } else {
        std::env::current_dir().ok()
    };

    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let _ = disable_raw_mode();
        let _ = execute!(std::io::stdout(), LeaveAlternateScreen, Show);
        original_hook(panic_info);
    }));

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, Hide)?;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = AppState::new(initial_path);

    // tmux's `allow-passthrough` forwards escape sequences straight to the
    // real terminal without first syncing its cursor to tmux's pane-relative
    // position, so an image transmitted in the same flush as the cursor move
    // that positions it can land at the wrong spot (often (0,0)) or not show
    // up at all. Only relevant when actually running inside tmux, so this is
    // resolved once up front rather than re-checked every frame.
    let in_tmux = termquery::is_tmux();
    // Overridable for diagnosis: over SSH the gap has to cover tmux relaying
    // through the outer ssh session to the real (remote) terminal, not just
    // tmux's own local processing, so the right value may be much larger
    // than what a bare local tmux setup needs. Try e.g.
    // `MDCMD_TMUX_IMAGE_DELAY_MS=50 mdc` if images are still misplaced.
    let tmux_image_delay = std::env::var("MDCMD_TMUX_IMAGE_DELAY_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(2));
    let trace_tmux_images = std::env::var("MDCMD_DEBUG_TMUX_IMAGES").is_ok();
    let mut last_image_signature = None;

    while !app.quit {
        if app.needs_clear {
            terminal.clear()?;
            app.needs_clear = false;
        }
        app.poll_fs_events();

        if in_tmux {
            let has_image = app.image_protocol.is_some() || !app.image_blocks.is_empty();
            let signature = (
                app.selected_file.clone(),
                app.scroll_offset,
                app.last_content_area,
                app.fullscreen,
            );
            if has_image && last_image_signature.as_ref() != Some(&signature) {
                // Draw once with images suppressed to settle the surrounding
                // layout and cursor state, flush, give tmux a moment to relay
                // that to the real terminal, then draw again with the image
                // included so only its cells actually hit the wire this
                // time. Same underlying bug (and fix) as
                // https://github.com/sxyazi/yazi/issues/1064.
                if trace_tmux_images {
                    eprintln!("[tmux-images] resync: signature={signature:?} delay={tmux_image_delay:?}\r");
                }
                app.suppress_images_this_frame = true;
                terminal.draw(|f| app.draw(f))?;
                app.suppress_images_this_frame = false;
                std::thread::sleep(tmux_image_delay);
                last_image_signature = Some(signature);
            }
        }
        terminal.draw(|f| app.draw(f))?;

        // An inline editor session needs to redraw promptly as the child
        // process produces output; the plain viewer doesn't change between
        // keystrokes, so a slower poll is fine there.
        let poll_interval = if app.pty_session.is_some() { 16 } else { 100 };
        if event::poll(Duration::from_millis(poll_interval))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == event::KeyEventKind::Press {
                    app.handle_key(key)?;
                    if app.suspend_requested {
                        app.suspend_requested = false;
                        suspend(&mut terminal)?;
                        app.needs_clear = true;
                    }
                }
            }
        }
    }

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        Show
    )?;
    
    Ok(())
}
