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
mod tui;

use tui::AppState;

const HELP: &str = "\
mdc — Terminal file browser and Markdown viewer

USAGE:
    mdc [OPTIONS] [PATH]

ARGS:
    <PATH>    Directory or file to open (defaults to the current directory)

OPTIONS:
    -h, --help       Print help information
    -v, --version    Print version information";

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    for arg in &args[1..] {
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{HELP}");
                return Ok(());
            }
            "-v" | "--version" => {
                println!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            _ => {}
        }
    }

    let path_arg = args[1..].iter().find(|a| !a.starts_with('-'));
    let initial_path = if let Some(arg) = path_arg {
        let path = PathBuf::from(arg);
        if path.exists() {
            Some(path)
        } else {
            eprintln!("Warning: provided path does not exist.");
            None
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

    while !app.quit {
        if app.needs_clear {
            terminal.clear()?;
            app.needs_clear = false;
        }
        terminal.draw(|f| app.draw(f))?;

        if event::poll(Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == event::KeyEventKind::Press {
                    app.handle_key(key)?;
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
