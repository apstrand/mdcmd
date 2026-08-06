use std::path::{Path, PathBuf};
use std::fs;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, BorderType, Borders, Clear, List, ListItem, ListState, Padding, Paragraph, Wrap},
    Frame,
};
use crossterm::event::{self, KeyCode, KeyModifiers};
use anyhow::Result;
use ratatui_image::{Resize, StatefulImage};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tui_term::widget::PseudoTerminal;

use crate::config::{Config, PinnedItem, ViewMode};
use crate::markdown::parse_markdown;
use crate::palette::Palette;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ActiveSection {
    Workspaces,
    Folders,
    Viewer,
}

/// Reading modes cycled through with `f` in the viewer.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum FullscreenMode {
    #[default]
    Off,
    /// No sidebar/status bar; text centered in a comfortable reading column.
    Margins,
    /// No sidebar/status bar; no margins, wraps only at the terminal edge.
    NoMargins,
}

impl FullscreenMode {
    fn next(self) -> Self {
        match self {
            FullscreenMode::Off => FullscreenMode::Margins,
            FullscreenMode::Margins => FullscreenMode::NoMargins,
            FullscreenMode::NoMargins => FullscreenMode::Off,
        }
    }
}

#[derive(Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Clone, Debug)]
pub struct TuiTreeNode {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub depth: usize,
    pub parent_path: Option<PathBuf>,
}

/// A text editor running in a real PTY, embedded inline in the viewer pane
/// instead of taking over the whole screen. `master` is kept around (rather
/// than only cloning a reader/writer from it) purely so we can call
/// `resize()` on it whenever the viewer pane's area changes.
pub struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    parser: Arc<RwLock<vt100::Parser>>,
    exited: Arc<AtomicBool>,
    cols: u16,
    rows: u16,
}

impl PtySession {
    fn resize(&mut self, cols: u16, rows: u16) {
        if cols == self.cols && rows == self.rows || cols == 0 || rows == 0 {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        let _ = self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        if let Ok(mut parser) = self.parser.write() {
            parser.screen_mut().set_size(rows, cols);
        }
    }
}

pub struct AppState {
    pub config: Config,
    pub current_dir: PathBuf,
    pub entries: Vec<FileEntry>,
    pub workspace_index: usize,
    pub folder_index: usize,
    pub active_section: ActiveSection,
    pub selected_file: Option<PathBuf>,
    pub file_content: Option<Text<'static>>,
    pub file_lines_count: usize,
    pub scroll_offset: usize,
    pub error: Option<String>,
    pub quit: bool,
    pub palette: Palette,
    pub open_files: Vec<PathBuf>,
    pub needs_clear: bool,
    pub view_mode: ViewMode,
    pub expanded_paths: std::collections::HashSet<PathBuf>,
    pub search_active: bool,
    pub search_input: String,
    pub search_query: Option<String>,
    pub create_active: bool,
    pub create_input: String,
    pub status_message: Option<String>,
    pub workspace_list_state: ListState,
    pub folder_list_state: ListState,
    pub cached_search_results: Option<Vec<FileEntry>>,
    pub help_active: bool,
    pub gui_missing_active: bool,
    pub fullscreen: FullscreenMode,
    pub image_picker: ratatui_image::picker::Picker,
    pub image_protocol: Option<ratatui_image::protocol::StatefulProtocol>,
    pub pty_session: Option<PtySession>,
    pub last_content_area: Rect,
}


impl AppState {
    pub fn new(initial_path: Option<PathBuf>, palette: Palette) -> Self {
        let config = Config::load();
        
        let start_path = initial_path
            .or_else(|| dirs::home_dir())
            .unwrap_or_else(|| PathBuf::from("."));
            
        let start_path = fs::canonicalize(&start_path)
            .unwrap_or(start_path);

        let mut initial_file = None;
        let current_dir = if start_path.is_file() {
            initial_file = Some(start_path.clone());
            start_path.parent().unwrap_or(&start_path).to_path_buf()
        } else {
            start_path
        };

        let view_mode = config.view_mode;
        // Queries the terminal for graphics-protocol support (Kitty/Sixel/iTerm2) and cell
        // pixel size; falls back to a halfblocks approximation when the terminal doesn't
        // answer (e.g. it isn't a real TTY, or doesn't support any image protocol).
        let image_picker = ratatui_image::picker::Picker::from_query_stdio()
            .unwrap_or_else(|_| ratatui_image::picker::Picker::halfblocks());
        let mut app = Self {
            config,
            current_dir,
            entries: Vec::new(),
            workspace_index: 0,
            folder_index: 0,
            active_section: ActiveSection::Folders,
            selected_file: None,
            file_content: None,
            file_lines_count: 0,
            scroll_offset: 0,
            error: None,
            quit: false,
            palette,
            open_files: Vec::new(),
            needs_clear: false,
            view_mode,
            expanded_paths: std::collections::HashSet::new(),
            search_active: false,
            search_input: String::new(),
            search_query: None,
            create_active: false,
            create_input: String::new(),
            status_message: None,
            workspace_list_state: ListState::default(),
            folder_list_state: ListState::default(),
            cached_search_results: None,
            help_active: false,
            gui_missing_active: false,
            fullscreen: FullscreenMode::Off,
            image_picker,
            image_protocol: None,
            pty_session: None,
            last_content_area: Rect::new(0, 0, 80, 24),
        };

        app.reload_directory();

        if let Some(file) = initial_file {
            app.select_file(file);
            app.active_section = ActiveSection::Viewer;
        }

        app
    }

    pub fn get_sorted_workspaces(&self) -> Vec<PinnedItem> {
        let mut items = self.config.pinned_workspaces.clone();
        items.sort_by(|a, b| {
            if a.is_dir && !b.is_dir {
                std::cmp::Ordering::Greater
            } else if !a.is_dir && b.is_dir {
                std::cmp::Ordering::Less
            } else {
                a.path.to_lowercase().cmp(&b.path.to_lowercase())
            }
        });
        items
    }

    pub fn activate_workspace_at_index(&mut self, idx: usize) {
        let workspaces = self.get_sorted_workspaces();
        if idx < workspaces.len() {
            let item = &workspaces[idx];
            let path = PathBuf::from(&item.path);
            if path.exists() {
                if item.is_dir {
                    self.current_dir = path;
                    self.reload_directory();
                    self.active_section = ActiveSection::Folders;
                    self.folder_index = 0;
                    if self.view_mode == ViewMode::Tree {
                        self.expanded_paths.clear();
                    }
                } else {
                    self.select_file(path);
                }
                self.clamp_folder_index();
            }
        }
    }

    pub fn clamp_folder_index(&mut self) {
        if let Some(ref query) = self.search_query {
            let count = self.get_search_results(query).len();
            if count == 0 {
                self.folder_index = 0;
            } else if self.folder_index >= count {
                self.folder_index = count.saturating_sub(1);
            }
            return;
        }

        match self.view_mode {
            ViewMode::List => {
                if self.entries.is_empty() {
                    self.folder_index = 0;
                } else if self.folder_index >= self.entries.len() {
                    self.folder_index = self.entries.len().saturating_sub(1);
                }
            }
            ViewMode::Tree => {
                let count = self.get_flat_tree().len();
                if count == 0 {
                    self.folder_index = 0;
                } else if self.folder_index >= count {
                    self.folder_index = count.saturating_sub(1);
                }
            }
        }
    }


    pub fn get_flat_tree(&self) -> Vec<TuiTreeNode> {
        let mut nodes = Vec::new();
        self.traverse_tree(&self.current_dir, 0, &mut nodes);
        nodes
    }

    fn traverse_tree(&self, dir: &Path, depth: usize, nodes: &mut Vec<TuiTreeNode>) {
        if let Ok(entries) = list_directory(dir) {
            for entry in entries {
                let path = PathBuf::from(&entry.path);
                nodes.push(TuiTreeNode {
                    name: entry.name,
                    path: path.clone(),
                    is_dir: entry.is_dir,
                    depth,
                    parent_path: Some(dir.to_path_buf()),
                });
                
                if entry.is_dir && self.expanded_paths.contains(&path) {
                    self.traverse_tree(&path, depth + 1, nodes);
                }
            }
        }
    }

    #[allow(dead_code)]
    pub fn toggle_expand(&mut self, path: PathBuf) {
        if self.expanded_paths.contains(&path) {
            self.expanded_paths.remove(&path);
        } else {
            self.expanded_paths.insert(path);
        }
        self.clamp_folder_index();
    }

    pub fn get_search_results(&self, query: &str) -> Vec<FileEntry> {
        let mut results = Vec::new();
        let query_lower = query.to_lowercase();
        self.walk_search_local(&self.current_dir, &query_lower, &mut results);
        
        results.sort_by(|a, b| {
            if a.is_dir && !b.is_dir {
                std::cmp::Ordering::Less
            } else if !a.is_dir && b.is_dir {
                std::cmp::Ordering::Greater
            } else {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            }
        });
        results
    }

    fn walk_search_local(&self, dir: &Path, query_lower: &str, results: &mut Vec<FileEntry>) {
        if let Ok(entries) = list_directory(dir) {
            for entry in entries {
                let path = PathBuf::from(&entry.path);
                if entry.name.to_lowercase().contains(query_lower) {
                    results.push(entry.clone());
                }
                if entry.is_dir {
                    self.walk_search_local(&path, query_lower, results);
                }
            }
        }
    }

    fn handle_key_search_input(&mut self, key: event::KeyEvent) -> Result<()> {
        match key.code {
            KeyCode::Esc => {
                self.search_active = false;
                self.search_query = None;
                self.search_input.clear();
                self.clamp_folder_index();
            }
            KeyCode::Enter => {
                self.search_active = false;
                if !self.search_input.is_empty() {
                    self.search_query = Some(self.search_input.clone());
                } else {
                    self.search_query = None;
                }
                self.folder_index = 0;
                self.clamp_folder_index();
            }
            KeyCode::Backspace => {
                self.search_input.pop();
                self.search_query = if self.search_input.is_empty() {
                    None
                } else {
                    Some(self.search_input.clone())
                };
                self.folder_index = 0;
                self.clamp_folder_index();
            }
            KeyCode::Char(c) => {
                self.search_input.push(c);
                self.search_query = Some(self.search_input.clone());
                self.folder_index = 0;
                self.clamp_folder_index();
            }
            _ => {}
        }
        Ok(())
    }



    fn handle_key_create_input(&mut self, key: event::KeyEvent) -> Result<()> {
        match key.code {
            KeyCode::Esc => {
                self.create_active = false;
                self.create_input.clear();
            }
            KeyCode::Enter => {
                let name = self.create_input.trim().to_string();
                self.create_active = false;
                self.create_input.clear();
                if !name.is_empty() {
                    let new_path = self.current_dir.join(&name);
                    if new_path.exists() {
                        self.error = Some(format!("File already exists: {}", name));
                    } else {
                        if let Some(parent) = new_path.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        match fs::write(&new_path, "") {
                            Ok(_) => {
                                self.reload_directory();
                                self.select_file(new_path);
                                return self.edit_current_file();
                            }
                            Err(e) => {
                                self.error = Some(format!("Error creating file: {}", e));
                            }
                        }
                    }
                }
            }
            KeyCode::Backspace => {
                self.create_input.pop();
            }
            KeyCode::Char(c) => {
                self.create_input.push(c);
            }
            _ => {}
        }
        Ok(())
    }

    /// Copy the given text to the OS clipboard via the platform utility.
    fn copy_to_clipboard(&mut self, text: &str) {
        use std::process::{Command, Stdio};
        use std::io::Write as _;

        #[cfg(target_os = "macos")]
        let candidates: &[(&str, &[&str])] = &[("pbcopy", &[])];
        #[cfg(target_os = "windows")]
        let candidates: &[(&str, &[&str])] = &[("clip", &[])];
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let candidates: &[(&str, &[&str])] = &[("wl-copy", &[]), ("xclip", &["-selection", "clipboard"])];

        for (cmd, args) in candidates {
            let child = Command::new(cmd)
                .args(*args)
                .stdin(Stdio::piped())
                .spawn();
            if let Ok(mut child) = child {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(text.as_bytes());
                }
                let _ = child.wait();
                self.status_message = Some(format!("Copied: {}", text));
                return;
            }
        }
        self.error = Some("No clipboard utility found".to_string());
    }

    /// Path of the currently focused folder entry (or selected file as fallback).
    fn focused_path(&self) -> Option<PathBuf> {
        if let Some(ref query) = self.search_query {
            let results = self.get_search_results(query);
            return results.get(self.folder_index).map(|e| PathBuf::from(&e.path));
        }
        match self.view_mode {
            ViewMode::List => self
                .entries
                .get(self.folder_index)
                .map(|e| PathBuf::from(&e.path)),
            ViewMode::Tree => self
                .get_flat_tree()
                .get(self.folder_index)
                .map(|n| n.path.clone()),
        }
    }

    /// Path to copy for the 'y'/'Y' shortcuts: the open file when focused on the
    /// viewer, otherwise the highlighted folder entry.
    fn copy_target(&self) -> Option<PathBuf> {
        if self.active_section == ActiveSection::Viewer {
            self.selected_file.clone()
        } else {
            self.focused_path().or_else(|| self.selected_file.clone())
        }
    }

    /// Navigate to the parent of the current directory, keeping the cursor on the
    /// directory we came from. Works in both List and Tree view.
    fn go_up_directory(&mut self) {
        let old_dir = self.current_dir.clone();
        if let Some(parent) = old_dir.parent() {
            self.current_dir = parent.to_path_buf();
            self.reload_directory();

            match self.view_mode {
                ViewMode::List => {
                    let old_name = old_dir.file_name().map(|n| n.to_string_lossy().into_owned());
                    self.folder_index = old_name
                        .and_then(|name| self.entries.iter().position(|e| e.is_dir && e.name == name))
                        .unwrap_or(0);
                }
                ViewMode::Tree => {
                    let flat_tree = self.get_flat_tree();
                    self.folder_index = flat_tree
                        .iter()
                        .position(|n| n.path == old_dir)
                        .unwrap_or(0);
                }
            }
            self.clamp_folder_index();
        }
    }

    pub fn reload_directory(&mut self) {
        match list_directory(&self.current_dir) {
            Ok(entries) => {
                self.entries = entries;
                if self.entries.is_empty() {
                    self.folder_index = 0;
                } else if self.folder_index >= self.entries.len() {
                    self.folder_index = self.entries.len() - 1;
                }
                self.error = None;
            }
            Err(e) => {
                self.entries = Vec::new();
                self.folder_index = 0;
                self.error = Some(format!("Error reading folder: {}", e));
            }
        }
    }

    pub fn select_file(&mut self, path: PathBuf) {
        if !self.open_files.contains(&path) {
            self.open_files.push(path.clone());
        }

        if let Some(parent) = path.parent() {
            let canon_parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
            if self.current_dir != canon_parent {
                self.current_dir = canon_parent;
                self.reload_directory();
                if let Some(ref q) = self.search_query {
                    let results = self.get_search_results(q);
                    self.cached_search_results = Some(results);
                }
                
                if self.view_mode == ViewMode::Tree {
                    let mut p = parent.to_path_buf();
                    while p.starts_with(&self.current_dir) && p != self.current_dir {
                        self.expanded_paths.insert(p.clone());
                        if let Some(p_parent) = p.parent() {
                            p = p_parent.to_path_buf();
                        } else {
                            break;
                        }
                    }
                }
            }
        }

        match self.view_mode {
            ViewMode::List => {
                if let Some(pos) = self.entries.iter().position(|e| PathBuf::from(&e.path) == path) {
                    self.folder_index = pos;
                }
            }
            ViewMode::Tree => {
                let flat_tree = self.get_flat_tree();
                if let Some(pos) = flat_tree.iter().position(|n| n.path == path) {
                    self.folder_index = pos;
                }
            }
        }

        let path_str = path.to_string_lossy();
        if is_media_file(&path_str) {
            self.image_protocol = if is_video_file(&path_str) {
                None
            } else {
                image::ImageReader::open(&path)
                    .ok()
                    .and_then(|reader| reader.decode().ok())
                    .map(|img| self.image_picker.new_resize_protocol(img))
            };
            self.selected_file = Some(path);
            self.file_content = None;
            self.file_lines_count = 0;
            self.scroll_offset = 0;
            self.error = None;
            return;
        }

        self.image_protocol = None;

        match fs::read_to_string(&path) {
            Ok(content) => {
                let parsed = parse_markdown(&content, &self.palette);
                self.file_lines_count = parsed.lines.len();
                self.file_content = Some(parsed);
                self.selected_file = Some(path);
                self.scroll_offset = 0;
                self.error = None;
            }
            Err(e) => {
                self.selected_file = Some(path);
                self.file_content = None;
                self.file_lines_count = 0;
                self.scroll_offset = 0;
                self.error = Some(format!("Error opening file: {}", e));
            }
        }
    }

    pub fn close_file(&mut self, path: PathBuf) {
        let index = self.open_files.iter().position(|p| p == &path);
        if let Some(idx) = index {
            self.open_files.remove(idx);
            
            if self.selected_file.as_ref() == Some(&path) {
                if !self.open_files.is_empty() {
                    let next_idx = idx.min(self.open_files.len() - 1);
                    let next_path = self.open_files[next_idx].clone();
                    self.select_file(next_path);
                } else {
                    self.selected_file = None;
                    self.file_content = None;
                    self.file_lines_count = 0;
                    self.scroll_offset = 0;
                    self.error = None;
                }
            }
        }
    }

    pub fn open_terminal_in_current_dir(&mut self) -> Result<()> {
        let path = &self.current_dir;
        if !path.exists() || !path.is_dir() {
            self.error = Some("Current directory does not exist".to_string());
            return Ok(());
        }

        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .args(&["-a", "Terminal", &path.to_string_lossy()])
                .status()?;
        }
        
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("cmd")
                .args(&["/C", "start", "cmd.exe", "/K", &format!("cd /d {}", path.to_string_lossy())])
                .status()?;
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            // On Linux, try standard terminal emulators. A trailing '=' means
            // the flag and path must be joined into a single arg (Ghostty
            // parses its CLI flags like config keys and rejects the
            // space-separated form).
            let terminals = [
                ("gnome-terminal", "--working-directory"),
                ("xfce4-terminal", "--working-directory"),
                ("konsole", "--workdir"),
                ("alacritty", "--working-directory"),
                ("ghostty", "--working-directory="),
                ("xterm", "-working-directory"),
            ];

            let mut spawned = false;
            for (term, flag) in terminals.iter() {
                let mut cmd = std::process::Command::new(term);
                if let Some(prefix) = flag.strip_suffix('=') {
                    cmd.arg(format!("{}={}", prefix, path.to_string_lossy()));
                } else {
                    cmd.arg(*flag).arg(path);
                }
                if cmd.spawn().is_ok() {
                    spawned = true;
                    break;
                }
            }
            
            if !spawned {
                // Fallback for generic terminal emulator launcher
                let fallback = std::process::Command::new("x-terminal-emulator")
                    .args(&["-e", &format!("cd {} && exec sh", path.to_string_lossy())])
                    .spawn();
                if fallback.is_err() {
                    self.error = Some("No supported terminal emulator found".to_string());
                }
            }
        }

        Ok(())
    }

    /// Open `path` in the MarkDown Commander GUI. If the GUI app is not
    /// installed, show an info panel with a download link and install steps
    /// instead of silently failing.
    fn open_gui(&mut self, path: &str) {
        if is_gui_installed() {
            if let Err(e) = open_in_gui(path) {
                self.error = Some(format!("Failed to launch GUI: {}", e));
            }
        } else {
            self.gui_missing_active = true;
        }
    }

    pub fn handle_key(&mut self, key: event::KeyEvent) -> Result<()> {
        self.status_message = None;

        // While an inline editor session is running, every key goes straight
        // to it (mirroring tmux/embedded-terminal conventions) rather than
        // being interpreted as an mdc keybinding. The session tears itself
        // down automatically once the child process exits.
        if self.pty_session.is_some() {
            return self.handle_pty_key(key);
        }

        if self.create_active {
            self.handle_key_create_input(key)?;
            return Ok(());
        }

        if self.search_active {
            self.handle_key_search_input(key)?;
            return Ok(());
        }

        // Any key dismisses the "GUI not installed" info panel.
        if self.gui_missing_active {
            self.gui_missing_active = false;
            return Ok(());
        }

        // While the help box is open, Esc closes it rather than quitting.
        if self.help_active && key.code == KeyCode::Esc {
            self.help_active = false;
            return Ok(());
        }

        if key.code == KeyCode::Char('q') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.quit = true;
            return Ok(());
        }

        match self.active_section {
            ActiveSection::Workspaces => self.handle_key_workspaces(key)?,
            ActiveSection::Folders => self.handle_key_folders(key)?,
            ActiveSection::Viewer => self.handle_key_viewer(key)?,
        }

        Ok(())
    }

    fn handle_global_keys(&mut self, key: event::KeyEvent) -> bool {
        if let KeyCode::Char(c) = key.code {
            let has_ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
            let has_alt = key.modifiers.contains(KeyModifiers::ALT);
            let has_shift = key.modifiers.contains(KeyModifiers::SHIFT);

            if c.is_ascii_digit() && c != '0' {
                let index = (c as u8 - b'1') as usize;
                if (has_ctrl && has_shift) || (has_alt && has_shift) {
                    self.activate_workspace_at_index(index);
                    return true;
                } else if has_ctrl || has_alt {
                    if index < self.open_files.len() {
                        let path = self.open_files[index].clone();
                        self.select_file(path);
                    }
                    return true;
                }
            } else if let Some(digit_char) = symbol_to_digit(c) {
                let index = (digit_char as u8 - b'1') as usize;
                if has_ctrl || has_alt {
                    self.activate_workspace_at_index(index);
                    return true;
                }
            }
        }
        
        if key.code == KeyCode::Char('?') && !self.search_active && !self.create_active {
            self.help_active = !self.help_active;
            return true;
        }

        match key.code {
            KeyCode::Char('t') => {
                let _ = self.open_terminal_in_current_dir();
                true
            }
            KeyCode::Char('n') => {
                self.create_active = true;
                self.create_input.clear();
                true
            }
            KeyCode::Char('y') => {
                if let Some(p) = self.copy_target() {
                    let s = p.to_string_lossy().into_owned();
                    self.copy_to_clipboard(&s);
                }
                true
            }
            KeyCode::Char('Y') => {
                if let Some(p) = self.copy_target() {
                    let name = p
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| p.to_string_lossy().into_owned());
                    self.copy_to_clipboard(&name);
                }
                true
            }
            KeyCode::Char('[') => {
                if !self.open_files.is_empty() {
                    if let Some(ref current) = self.selected_file {
                        if let Some(idx) = self.open_files.iter().position(|p| p == current) {
                            let prev_idx = if idx == 0 {
                                self.open_files.len() - 1
                            } else {
                                idx - 1
                            };
                            let prev_path = self.open_files[prev_idx].clone();
                            self.select_file(prev_path);
                        }
                    } else {
                        let path = self.open_files[0].clone();
                        self.select_file(path);
                    }
                }
                true
            }
            KeyCode::Char(']') => {
                if !self.open_files.is_empty() {
                    if let Some(ref current) = self.selected_file {
                        if let Some(idx) = self.open_files.iter().position(|p| p == current) {
                            let next_idx = if idx == self.open_files.len() - 1 {
                                0
                            } else {
                                idx + 1
                            };
                            let next_path = self.open_files[next_idx].clone();
                            self.select_file(next_path);
                        }
                    } else {
                        let path = self.open_files[0].clone();
                        self.select_file(path);
                    }
                }
                true
            }
            KeyCode::Tab => {
                self.active_section = match self.active_section {
                    ActiveSection::Workspaces => {
                        let flat_tree_empty = self.view_mode == ViewMode::Tree && self.get_flat_tree().is_empty();
                        let list_empty = self.view_mode == ViewMode::List && self.entries.is_empty();
                        if !flat_tree_empty && !list_empty {
                            ActiveSection::Folders
                        } else {
                            ActiveSection::Viewer
                        }
                    }
                    ActiveSection::Folders => ActiveSection::Viewer,
                    ActiveSection::Viewer => {
                        if !self.config.pinned_workspaces.is_empty() {
                            ActiveSection::Workspaces
                        } else {
                            let flat_tree_empty = self.view_mode == ViewMode::Tree && self.get_flat_tree().is_empty();
                            let list_empty = self.view_mode == ViewMode::List && self.entries.is_empty();
                            if !flat_tree_empty && !list_empty {
                                ActiveSection::Folders
                            } else {
                                ActiveSection::Viewer
                            }
                        }
                    }
                };
                true
            }
            KeyCode::BackTab => { // Shift + Tab
                self.active_section = match self.active_section {
                    ActiveSection::Workspaces => ActiveSection::Viewer,
                    ActiveSection::Folders => {
                        if !self.config.pinned_workspaces.is_empty() {
                            ActiveSection::Workspaces
                        } else {
                            ActiveSection::Viewer
                        }
                    }
                    ActiveSection::Viewer => {
                        let flat_tree_empty = self.view_mode == ViewMode::Tree && self.get_flat_tree().is_empty();
                        let list_empty = self.view_mode == ViewMode::List && self.entries.is_empty();
                        if !flat_tree_empty && !list_empty {
                            ActiveSection::Folders
                        } else if !self.config.pinned_workspaces.is_empty() {
                            ActiveSection::Workspaces
                        } else {
                            ActiveSection::Viewer
                        }
                    }
                };
                true
            }
            KeyCode::Esc => {
                if self.search_query.is_some() {
                    self.search_query = None;
                    self.folder_index = 0;
                    self.clamp_folder_index();
                    true
                } else {
                    self.quit = true;
                    true
                }
            }
            KeyCode::Char('q') => {
                self.quit = true;
                true
            }
            _ => false,
        }
    }


    fn handle_key_workspaces(&mut self, key: event::KeyEvent) -> Result<()> {
        if self.handle_global_keys(key) {
            return Ok(());
        }

        let workspaces = self.get_sorted_workspaces();
        if workspaces.is_empty() {
            if key.code == KeyCode::Char('/') {
                self.search_active = true;
                self.search_input.clear();
            }
            return Ok(());
        }

        match key.code {
            KeyCode::Char('/') => {
                self.search_active = true;
                self.search_input.clear();
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.workspace_index < workspaces.len() - 1 {
                    self.workspace_index += 1;
                } else {
                    let folder_empty = match self.view_mode {
                        ViewMode::List => self.entries.is_empty(),
                        ViewMode::Tree => self.get_flat_tree().is_empty(),
                    };
                    if !folder_empty {
                        self.active_section = ActiveSection::Folders;
                        self.folder_index = 0;
                    }
                }
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.workspace_index > 0 {
                    self.workspace_index -= 1;
                }
            }
            KeyCode::Enter => {
                let has_modifier = key.modifiers.contains(KeyModifiers::SUPER)
                    || key.modifiers.contains(KeyModifiers::ALT)
                    || key.modifiers.contains(KeyModifiers::META);
                let item = &workspaces[self.workspace_index];
                let path = PathBuf::from(&item.path);
                if path.exists() {
                    if item.is_dir {
                        self.current_dir = path;
                        self.reload_directory();
                        if let Some(ref q) = self.search_query {
                            let results = self.get_search_results(q);
                            self.cached_search_results = Some(results);
                        }
                        self.active_section = ActiveSection::Folders;
                        self.folder_index = 0;
                        if self.view_mode == ViewMode::Tree {
                            self.expanded_paths.clear();
                        }
                    } else {
                        self.select_file(path);
                        if has_modifier {
                            self.active_section = ActiveSection::Viewer;
                        }
                    }
                    self.clamp_folder_index();
                } else {
                    self.error = Some("Pinned item no longer exists".to_string());
                }
            }
            KeyCode::Char('p') | KeyCode::Char('d') | KeyCode::Char('x') => {
                let removed = workspaces[self.workspace_index].path.clone();
                self.config.pinned_workspaces.retain(|x| x.path != removed);
                let _ = self.config.save();
                let workspaces = self.get_sorted_workspaces();
                if self.workspace_index >= workspaces.len() {
                    self.workspace_index = workspaces.len().saturating_sub(1);
                }
                if workspaces.is_empty() {
                    let folder_empty = match self.view_mode {
                        ViewMode::List => self.entries.is_empty(),
                        ViewMode::Tree => self.get_flat_tree().is_empty(),
                    };
                    if !folder_empty {
                        self.active_section = ActiveSection::Folders;
                        self.folder_index = 0;
                    } else {
                        self.active_section = ActiveSection::Viewer;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn handle_key_folders(&mut self, key: event::KeyEvent) -> Result<()> {
        if self.handle_global_keys(key) {
            return Ok(());
        }

        if let Some(ref results) = self.cached_search_results {
            match key.code {
                KeyCode::Char('/') => {
                    self.search_active = true;
                    self.search_input.clear();
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    let max_idx = results.len().saturating_sub(1);
                    if self.folder_index < max_idx {
                        self.folder_index += 1;
                    }
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    if self.folder_index > 0 {
                        self.folder_index -= 1;
                    }
                }
                KeyCode::Enter | KeyCode::Right | KeyCode::Char('l') => {
                    let has_modifier = key.modifiers.contains(KeyModifiers::SUPER)
                        || key.modifiers.contains(KeyModifiers::ALT)
                        || key.modifiers.contains(KeyModifiers::META);
                    if !results.is_empty() {
                        let entry = &results[self.folder_index];
                        let path = PathBuf::from(&entry.path);
                        if entry.is_dir {
                            self.current_dir = path;
                            self.reload_directory();
                            self.search_query = None;
                            self.cached_search_results = None;
                            self.folder_index = 0;
                        } else {
                            self.select_file(path);
                            if has_modifier {
                                self.active_section = ActiveSection::Viewer;
                            }
                        }
                    }
                }
                KeyCode::Left | KeyCode::Char('h') | KeyCode::Backspace | KeyCode::Char('u') => {
                    self.search_query = None;
                    self.go_up_directory();
                }
                KeyCode::Char('p') => {
                    if !results.is_empty() {
                        let entry = &results[self.folder_index];
                        let path_to_pin = entry.path.clone();
                        let is_dir = entry.is_dir;
                        if let Some(pos) = self.config.pinned_workspaces.iter().position(|x| x.path == path_to_pin) {
                            self.config.pinned_workspaces.remove(pos);
                        } else {
                            self.config.pinned_workspaces.push(PinnedItem {
                                path: path_to_pin,
                                is_dir,
                            });
                        }
                        let _ = self.config.save();
                    }
                }
                KeyCode::Char('e') => {
                    if !results.is_empty() {
                        let entry = &results[self.folder_index];
                        if !entry.is_dir {
                            let path = PathBuf::from(&entry.path);
                            if !is_media_file(&path.to_string_lossy()) {
                                self.select_file(path);
                                return self.edit_current_file();
                            }
                        }
                    }
                }
                KeyCode::Char('o') => {
                    if !results.is_empty() {
                        let entry = &results[self.folder_index];
                        if !entry.is_dir {
                            let _ = open_system_default(&entry.path);
                        }
                    }
                }
                KeyCode::Char('g') => {
                    if !results.is_empty() {
                        let entry = &results[self.folder_index];
                        if !entry.is_dir {
                            let path = entry.path.clone();
                            self.open_gui(&path);
                        }
                    }
                }
                KeyCode::Char('f') => {
                    if !results.is_empty() {
                        let entry = &results[self.folder_index];
                        if !entry.is_dir {
                            let path = PathBuf::from(&entry.path);
                            self.select_file(path);
                            self.active_section = ActiveSection::Viewer;
                            self.fullscreen = FullscreenMode::Margins;
                            self.needs_clear = true;
                        }
                    }
                }
                _ => {}
            }
            return Ok(());
        }

        match key.code {
            KeyCode::Char('/') => {
                self.search_active = true;
                self.search_input.clear();
            }
            KeyCode::Char('v') => {
                // Enter the folder under the cursor (if any) before switching modes
                if let Some(path) = self.focused_path() {
                    if path.is_dir() {
                        self.current_dir = path;
                        self.reload_directory();
                        self.expanded_paths.clear();
                        self.folder_index = 0;
                    }
                }
                self.view_mode = match self.view_mode {
                    ViewMode::List => ViewMode::Tree,
                    ViewMode::Tree => ViewMode::List,
                };
                self.config.view_mode = self.view_mode;
                let _ = self.config.save();
                self.clamp_folder_index();
            }
            KeyCode::Down | KeyCode::Char('j') => {
                let max_idx = match self.view_mode {
                    ViewMode::List => self.entries.len().saturating_sub(1),
                    ViewMode::Tree => self.get_flat_tree().len().saturating_sub(1),
                };
                if self.folder_index < max_idx {
                    self.folder_index += 1;
                }
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.folder_index > 0 {
                    self.folder_index -= 1;
                } else {
                    let workspaces = self.get_sorted_workspaces();
                    if !workspaces.is_empty() {
                        self.active_section = ActiveSection::Workspaces;
                        self.workspace_index = workspaces.len() - 1;
                    }
                }
            }
            KeyCode::Enter => {
                let has_modifier = key.modifiers.contains(KeyModifiers::SUPER)
                    || key.modifiers.contains(KeyModifiers::ALT)
                    || key.modifiers.contains(KeyModifiers::META);
                match self.view_mode {
                    ViewMode::List => {
                        if !self.entries.is_empty() {
                            let entry = self.entries[self.folder_index].clone();
                            let path = PathBuf::from(&entry.path);
                            if entry.is_dir {
                                self.current_dir = path;
                                self.reload_directory();
                                self.folder_index = 0;
                            } else {
                                self.select_file(path);
                                if has_modifier {
                                    self.active_section = ActiveSection::Viewer;
                                }
                            }
                        }
                    }
                    ViewMode::Tree => {
                        let flat_tree = self.get_flat_tree();
                        if !flat_tree.is_empty() {
                            let node = &flat_tree[self.folder_index];
                            if node.is_dir {
                                if self.expanded_paths.contains(&node.path) {
                                    self.expanded_paths.remove(&node.path);
                                } else {
                                    self.expanded_paths.insert(node.path.clone());
                                }
                            } else {
                                self.select_file(node.path.clone());
                                if has_modifier {
                                    self.active_section = ActiveSection::Viewer;
                                }
                            }
                        }
                    }
                }
            }
            KeyCode::Right | KeyCode::Char('l') => {
                match self.view_mode {
                    ViewMode::List => {
                        if !self.entries.is_empty() {
                            let entry = &self.entries[self.folder_index];
                            if entry.is_dir {
                                let path = PathBuf::from(&entry.path);
                                self.current_dir = path;
                                self.reload_directory();
                                self.folder_index = 0;
                            }
                        }
                    }
                    ViewMode::Tree => {
                        let flat_tree = self.get_flat_tree();
                        if !flat_tree.is_empty() {
                            let node = &flat_tree[self.folder_index];
                            if node.is_dir && !self.expanded_paths.contains(&node.path) {
                                self.expanded_paths.insert(node.path.clone());
                            }
                        }
                    }
                }
            }
            KeyCode::Left | KeyCode::Char('h') => {
                match self.view_mode {
                    ViewMode::List => self.go_up_directory(),
                    ViewMode::Tree => {
                        let flat_tree = self.get_flat_tree();
                        if flat_tree.is_empty() {
                            self.go_up_directory();
                        } else {
                            let node = flat_tree[self.folder_index].clone();
                            if node.is_dir && self.expanded_paths.contains(&node.path) {
                                // Collapse an expanded directory in place
                                self.expanded_paths.remove(&node.path);
                            } else if let Some(parent_idx) = node
                                .parent_path
                                .as_ref()
                                .and_then(|pp| flat_tree.iter().position(|n| &n.path == pp))
                            {
                                // Jump to the parent node visible within the tree
                                self.folder_index = parent_idx;
                            } else {
                                // Top-level node: leave the tree root and go up a directory
                                self.go_up_directory();
                            }
                        }
                    }
                }
            }
            KeyCode::Char(' ') => {
                if self.view_mode == ViewMode::Tree {
                    let flat_tree = self.get_flat_tree();
                    if !flat_tree.is_empty() {
                        let node = &flat_tree[self.folder_index];
                        if node.is_dir {
                            if self.expanded_paths.contains(&node.path) {
                                self.expanded_paths.remove(&node.path);
                            } else {
                                self.expanded_paths.insert(node.path.clone());
                            }
                        }
                    }
                }
            }
            KeyCode::Backspace | KeyCode::Char('u') => {
                self.go_up_directory();
            }
            KeyCode::Char('p') => {
                let (path_to_pin, is_dir) = match self.view_mode {
                    ViewMode::List => {
                        if !self.entries.is_empty() {
                            let entry = &self.entries[self.folder_index];
                            (entry.path.clone(), entry.is_dir)
                        } else {
                            (self.current_dir.to_string_lossy().into_owned(), true)
                        }
                    }
                    ViewMode::Tree => {
                        let flat_tree = self.get_flat_tree();
                        if !flat_tree.is_empty() {
                            let node = &flat_tree[self.folder_index];
                            (node.path.to_string_lossy().into_owned(), node.is_dir)
                        } else {
                            (self.current_dir.to_string_lossy().into_owned(), true)
                        }
                    }
                };
                
                if let Some(pos) = self.config.pinned_workspaces.iter().position(|x| x.path == path_to_pin) {
                    self.config.pinned_workspaces.remove(pos);
                } else {
                    self.config.pinned_workspaces.push(PinnedItem {
                        path: path_to_pin,
                        is_dir,
                    });
                }
                let _ = self.config.save();
            }
            KeyCode::Char('e') => {
                let node_opt = match self.view_mode {
                    ViewMode::List => {
                        if !self.entries.is_empty() {
                            let entry = &self.entries[self.folder_index];
                            if !entry.is_dir {
                                Some((PathBuf::from(&entry.path), entry.name.clone()))
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                    ViewMode::Tree => {
                        let flat_tree = self.get_flat_tree();
                        if !flat_tree.is_empty() {
                            let node = &flat_tree[self.folder_index];
                            if !node.is_dir {
                                Some((node.path.clone(), node.name.clone()))
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                };

                if let Some((path, _name)) = node_opt {
                    if !is_media_file(&path.to_string_lossy()) {
                        self.select_file(path);
                        return self.edit_current_file();
                    }
                }
            }
            KeyCode::Char('o') => {
                let path_opt = match self.view_mode {
                    ViewMode::List => {
                        if !self.entries.is_empty() {
                            let entry = &self.entries[self.folder_index];
                            if !entry.is_dir {
                                Some(entry.path.clone())
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                    ViewMode::Tree => {
                        let flat_tree = self.get_flat_tree();
                        if !flat_tree.is_empty() {
                            let node = &flat_tree[self.folder_index];
                            if !node.is_dir {
                                Some(node.path.to_string_lossy().into_owned())
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                };

                if let Some(path) = path_opt {
                    let _ = open_system_default(&path);
                }
            }
            KeyCode::Char('g') => {
                let path_opt = match self.view_mode {
                    ViewMode::List => {
                        if !self.entries.is_empty() {
                            let entry = &self.entries[self.folder_index];
                            if !entry.is_dir {
                                Some(entry.path.clone())
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                    ViewMode::Tree => {
                        let flat_tree = self.get_flat_tree();
                        if !flat_tree.is_empty() {
                            let node = &flat_tree[self.folder_index];
                            if !node.is_dir {
                                Some(node.path.to_string_lossy().into_owned())
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                };

                if let Some(path) = path_opt {
                    self.open_gui(&path);
                }
            }
            KeyCode::Char('f') => {
                let node_opt = match self.view_mode {
                    ViewMode::List => {
                        if !self.entries.is_empty() {
                            let entry = &self.entries[self.folder_index];
                            if !entry.is_dir {
                                Some(PathBuf::from(&entry.path))
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                    ViewMode::Tree => {
                        let flat_tree = self.get_flat_tree();
                        if !flat_tree.is_empty() {
                            let node = &flat_tree[self.folder_index];
                            if !node.is_dir {
                                Some(node.path.clone())
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                };

                if let Some(path) = node_opt {
                    self.select_file(path);
                    self.active_section = ActiveSection::Viewer;
                    self.fullscreen = FullscreenMode::Margins;
                    self.needs_clear = true;
                }
            }
            _ => {}
        }
        Ok(())
    }


    fn handle_key_viewer(&mut self, key: event::KeyEvent) -> Result<()> {
        // 'f' cycles Normal -> Margins -> NoMargins -> Normal; Esc always
        // returns straight to Normal. Handle these before the global keys so
        // Esc doesn't quit the app while in a fullscreen reading mode.
        if self.fullscreen != FullscreenMode::Off {
            match key.code {
                KeyCode::Char('f') => {
                    self.fullscreen = self.fullscreen.next();
                    self.needs_clear = true;
                    return Ok(());
                }
                KeyCode::Esc => {
                    self.fullscreen = FullscreenMode::Off;
                    self.needs_clear = true;
                    return Ok(());
                }
                _ => {}
            }
        } else if key.code == KeyCode::Char('f') && self.selected_file.is_some() {
            self.fullscreen = FullscreenMode::Margins;
            self.needs_clear = true;
            return Ok(());
        }

        if self.handle_global_keys(key) {
            return Ok(());
        }

        match key.code {
            KeyCode::Char('?') => self.help_active = !self.help_active,
            KeyCode::Down | KeyCode::Char('j') => {
                self.scroll_offset = self.scroll_offset.saturating_add(1);
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.scroll_offset = self.scroll_offset.saturating_sub(1);
            }
            KeyCode::PageDown | KeyCode::Char(' ') => {
                self.scroll_offset = self.scroll_offset.saturating_add(15);
            }
            KeyCode::PageUp | KeyCode::Backspace => {
                self.scroll_offset = self.scroll_offset.saturating_sub(15);
            }
            KeyCode::Char('e') => {
                if let Some(ref file_path) = self.selected_file {
                    let path_str = file_path.to_string_lossy();
                    if !is_media_file(&path_str) {
                        return self.edit_current_file();
                    }
                }
            }
            KeyCode::Char('o') | KeyCode::Enter => {
                if let Some(ref file_path) = self.selected_file {
                    let _ = open_system_default(&file_path.to_string_lossy());
                }
            }
            KeyCode::Char('g') => {
                if let Some(file_path) = self.selected_file.clone() {
                    self.open_gui(&file_path.to_string_lossy());
                }
            }
            KeyCode::Char('w') | KeyCode::Char('c') => {
                if let Some(ref file_path) = self.selected_file {
                    let path = file_path.clone();
                    self.close_file(path);
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Spawn `$EDITOR` (falling back to vim, then nano) attached to a real
    /// PTY and embed it inline in the viewer pane, instead of leaving the
    /// alternate screen and blocking on a foreground child process. The
    /// session is torn down automatically once the child process exits (see
    /// the `pty_session` exited-check at the top of `draw`).
    fn edit_current_file(&mut self) -> Result<()> {
        let file_path = match &self.selected_file {
            Some(p) => p.clone(),
            None => return Ok(()),
        };
        if self.pty_session.is_some() {
            return Ok(());
        }

        let area = self.last_content_area;
        let cols = area.width.saturating_sub(2).max(10);
        let rows = area.height.saturating_sub(2).max(3);

        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;

        let editor = std::env::var("EDITOR").unwrap_or_else(|_| "nano".to_string());
        let cwd = file_path.parent().map(|p| p.to_path_buf());
        let build_cmd = |program: &str| {
            let mut cmd = CommandBuilder::new(program);
            cmd.arg(&file_path);
            if let Some(dir) = &cwd {
                cmd.cwd(dir);
            }
            cmd
        };

        let child = pair
            .slave
            .spawn_command(build_cmd(&editor))
            .or_else(|_| pair.slave.spawn_command(build_cmd("vim")))
            .or_else(|_| pair.slave.spawn_command(build_cmd("nano")));
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                self.error = Some(format!("Failed to launch editor: {}", e));
                return Ok(());
            }
        };
        drop(pair.slave);

        let exited = Arc::new(AtomicBool::new(false));
        {
            let exited = exited.clone();
            std::thread::spawn(move || {
                let _ = child.wait();
                exited.store(true, Ordering::SeqCst);
            });
        }

        let parser = Arc::new(RwLock::new(vt100::Parser::new(rows, cols, 0)));
        let mut reader = pair.master.try_clone_reader()?;
        {
            let parser = parser.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Ok(mut p) = parser.write() {
                                p.process(&buf[..n]);
                            }
                        }
                    }
                }
            });
        }

        let writer = pair.master.take_writer()?;

        self.pty_session = Some(PtySession {
            master: pair.master,
            writer,
            parser,
            exited,
            cols,
            rows,
        });
        self.fullscreen = FullscreenMode::Off;
        self.needs_clear = true;

        Ok(())
    }

    /// Forward a key event to the active PTY editor session as raw bytes.
    fn handle_pty_key(&mut self, key: event::KeyEvent) -> Result<()> {
        if key.kind != event::KeyEventKind::Press {
            return Ok(());
        }
        let bytes = pty_input_bytes(key);
        if bytes.is_empty() {
            return Ok(());
        }
        if let Some(session) = self.pty_session.as_mut() {
            let _ = session.writer.write_all(&bytes);
            let _ = session.writer.flush();
        }
        Ok(())
    }

    pub fn draw(&mut self, f: &mut Frame<'_>) {
        // The PTY's exit is only observed asynchronously by a background
        // thread; poll for it once per frame so we reliably fall back to the
        // normal viewer shortly after the editor process exits.
        if matches!(&self.pty_session, Some(session) if session.exited.load(Ordering::SeqCst)) {
            self.pty_session = None;
            if let Some(path) = self.selected_file.clone() {
                self.select_file(path);
            }
            self.needs_clear = true;
        }

        let rect = f.area();

        // Paint an explicit background for the whole frame so the app looks
        // consistent regardless of the host terminal's own theme, instead of
        // relying on the terminal's default background showing through.
        f.render_widget(
            Block::default().style(Style::default().bg(self.palette.bg)),
            rect,
        );

        let border_active_color = self.palette.border_active;
        let border_inactive_color = self.palette.border_inactive;
        let text_primary_color = self.palette.text_primary;
        let text_secondary_color = self.palette.text_secondary;
        let accent_color = self.palette.accent;
        let accent_soft_color = self.palette.accent_soft;

        // Fullscreen reading modes: no sidebar, no borders, no status bar — just
        // the file content filling the whole terminal.
        if self.fullscreen != FullscreenMode::Off {
            self.draw_fullscreen(f, rect, text_primary_color, text_secondary_color, accent_color);
            return;
        }

        let main_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(0),
                Constraint::Length(1),
            ])
            .split(rect);

        let pane_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(30),
                Constraint::Percentage(70),
            ])
            .split(main_chunks[0]);

        let sidebar_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Percentage(65),
                Constraint::Percentage(35),
            ])
            .split(pane_chunks[0]);

        // Render Pinned Workspaces
        let workspaces_border_color = if self.active_section == ActiveSection::Workspaces {
            border_active_color
        } else {
            border_inactive_color
        };

        let workspaces = self.get_sorted_workspaces();
        let mut list_items = Vec::new();
        
        for (i, item) in workspaces.iter().enumerate() {
            let path = Path::new(&item.path);
            let name = path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| item.path.clone());

            let is_selected = i == self.workspace_index && self.active_section == ActiveSection::Workspaces;
            
            let style = if is_selected {
                Style::default().bg(accent_color).fg(Color::White)
            } else {
                Style::default().fg(text_primary_color)
            };

            let icon = if item.is_dir { "📌 " } else { "📄 " };
            list_items.push(ListItem::new(vec![
                Line::from(vec![
                    Span::styled(icon, Style::default().fg(accent_color)),
                    Span::styled(name, Style::default().add_modifier(Modifier::BOLD)),
                ]),
                Line::from(vec![
                    Span::styled(format!("  {}", item.path), Style::default().fg(text_secondary_color)),
                ]),
            ]).style(style));
        }

        let workspaces_block = Block::default()
            .borders(Borders::ALL)
            .title("📌 Workspaces")
            .border_style(Style::default().fg(workspaces_border_color));

        let workspaces_list = List::new(list_items)
            .block(workspaces_block);
            
        self.workspace_list_state.select(Some(self.workspace_index));
        f.render_stateful_widget(workspaces_list, sidebar_chunks[1], &mut self.workspace_list_state);

        // Render Directory Folders
        let folders_border_color = if self.active_section == ActiveSection::Folders {
            border_active_color
        } else {
            border_inactive_color
        };

        let mut folder_items = Vec::new();
        let path_str = self.current_dir.to_string_lossy().into_owned();
        
        if let Some(ref results) = self.cached_search_results {
            for (i, entry) in results.iter().enumerate() {
                let is_selected = i == self.folder_index && self.active_section == ActiveSection::Folders;
                let is_currently_open = self.selected_file.as_ref()
                    .map(|p| p.to_string_lossy() == entry.path)
                    .unwrap_or(false);

                let style = if is_selected {
                    Style::default().bg(accent_color).fg(Color::White)
                } else if is_currently_open {
                    Style::default().bg(self.palette.open_bg).fg(accent_color).add_modifier(Modifier::BOLD)
                } else {
                    let fg = if entry.is_dir || is_markdown_file(&entry.name) || is_media_file(&entry.path) {
                        text_primary_color
                    } else {
                        self.palette.text_dimmed
                    };
                    Style::default().fg(fg)
                };

                let icon = if entry.is_dir {
                    "📁 "
                } else if is_media_file(&entry.path) {
                    if is_video_file(&entry.name) { "🎥 " } else { "🖼️ " }
                } else if is_markdown_file(&entry.name) {
                    "📄 "
                } else {
                    "   "
                };

                let rel_path = Path::new(&entry.path)
                    .strip_prefix(&self.current_dir)
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| entry.path.clone());

                folder_items.push(ListItem::new(vec![
                    Line::from(vec![
                        Span::styled(icon, Style::default().fg(text_secondary_color)),
                        Span::styled(entry.name.clone(), Style::default().add_modifier(Modifier::BOLD)),
                    ]),
                    Line::from(vec![
                        Span::styled(format!("  {}", rel_path), Style::default().fg(text_secondary_color)),
                    ]),
                ]).style(style));
            }
            if folder_items.is_empty() {
                folder_items.push(ListItem::new(Line::from(vec![
                    Span::styled("  No results found.", Style::default().fg(self.palette.text_dimmed))
                ])));
            }
        } else {
            match self.view_mode {
                ViewMode::List => {
                for (i, entry) in self.entries.iter().enumerate() {
                    let is_selected = i == self.folder_index && self.active_section == ActiveSection::Folders;
                    let is_currently_open = self.selected_file.as_ref()
                        .map(|p| p.to_string_lossy() == entry.path)
                        .unwrap_or(false);

                    let style = if is_selected {
                        Style::default().bg(accent_color).fg(Color::White)
                    } else if is_currently_open {
                        Style::default().bg(self.palette.open_bg).fg(accent_color).add_modifier(Modifier::BOLD)
                    } else {
                        let fg = if entry.is_dir || is_markdown_file(&entry.name) || is_media_file(&entry.path) {
                            text_primary_color
                        } else {
                            self.palette.text_dimmed
                        };
                        Style::default().fg(fg)
                    };

                    let icon = if entry.is_dir {
                        "📁 "
                    } else if is_media_file(&entry.path) {
                        if is_video_file(&entry.name) { "🎥 " } else { "🖼️ " }
                    } else if is_markdown_file(&entry.name) {
                        "📄 "
                    } else {
                        "   "
                    };

                    folder_items.push(ListItem::new(Line::from(vec![
                        Span::styled(icon, Style::default().fg(text_secondary_color)),
                        Span::styled(entry.name.clone(), Style::default()),
                    ])).style(style));
                }
            }
            ViewMode::Tree => {
                let flat_tree = self.get_flat_tree();
                for (i, node) in flat_tree.iter().enumerate() {
                    let is_selected = i == self.folder_index && self.active_section == ActiveSection::Folders;
                    let is_currently_open = self.selected_file.as_ref()
                        .map(|p| p == &node.path)
                        .unwrap_or(false);

                    let style = if is_selected {
                        Style::default().bg(accent_color).fg(Color::White)
                    } else if is_currently_open {
                        Style::default().bg(self.palette.open_bg).fg(accent_color).add_modifier(Modifier::BOLD)
                    } else {
                        let fg = if node.is_dir || is_markdown_file(&node.name) || is_media_file(&node.path.to_string_lossy()) {
                            text_primary_color
                        } else {
                            self.palette.text_dimmed
                        };
                        Style::default().fg(fg)
                    };

                    let indent = "  ".repeat(node.depth);
                    let is_expanded = self.expanded_paths.contains(&node.path);
                    
                    let (chevron, icon) = if node.is_dir {
                        let chev = if is_expanded { "▼ " } else { "▶ " };
                        (chev, "📁 ")
                    } else {
                        let name_str = node.name.clone();
                        let path_str = node.path.to_string_lossy();
                        let ic = if is_media_file(&path_str) {
                            if is_video_file(&name_str) { "🎥 " } else { "🖼️ " }
                        } else if is_markdown_file(&name_str) {
                            "📄 "
                        } else {
                            "   "
                        };
                        ("  ", ic)
                    };

                    folder_items.push(ListItem::new(Line::from(vec![
                        Span::raw(indent),
                        Span::styled(chevron, Style::default().fg(text_secondary_color)),
                        Span::styled(icon, Style::default().fg(text_secondary_color)),
                        Span::styled(node.name.clone(), Style::default()),
                    ])).style(style));
                }
            }
        }
        }

        let folders_title = if let Some(ref query) = self.search_query {
            format!("🔍 Search: \"{}\" in {}", query, path_str)
        } else {
            let mode_str = match self.view_mode {
                ViewMode::List => "List",
                ViewMode::Tree => "Tree",
            };
            format!("📁 Folders ({}) ( 'v' mode ): {}", mode_str, path_str)
        };

        let folders_block = Block::default()
            .borders(Borders::ALL)
            .title(folders_title)
            .border_style(Style::default().fg(folders_border_color));

        let folders_list = List::new(folder_items)
            .block(folders_block);

        self.folder_list_state.select(Some(self.folder_index));
        f.render_stateful_widget(folders_list, sidebar_chunks[0], &mut self.folder_list_state);

        // Render Tabs and Content area
        let content_area = if !self.open_files.is_empty() {
            let right_chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(3),
                    Constraint::Min(0),
                ])
                .split(pane_chunks[1]);
            
            // Draw tabs in right_chunks[0]
            let mut tab_spans = Vec::new();
            for (i, path) in self.open_files.iter().enumerate() {
                let name = path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string_lossy().into_owned());
                
                let is_active = self.selected_file.as_ref() == Some(path);
                
                if i > 0 {
                    tab_spans.push(Span::styled(" │ ", Style::default().fg(border_inactive_color)));
                }

                if is_active {
                    tab_spans.push(Span::styled(
                        format!(" ◉ {} ", name),
                        Style::default().bg(accent_soft_color).fg(text_primary_color).add_modifier(Modifier::BOLD)
                    ));
                } else {
                    tab_spans.push(Span::styled(
                        format!(" ○ {} ", name),
                        Style::default().fg(text_secondary_color)
                    ));
                }
            }

            let tabs_block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(border_inactive_color))
                .title(Span::styled("📂 Open Tabs ( [ / ] cycle, w/c close )", Style::default().fg(accent_color).add_modifier(Modifier::BOLD)));
            
            let tabs_paragraph = Paragraph::new(Line::from(tab_spans))
                .block(tabs_block);
            f.render_widget(tabs_paragraph, right_chunks[0]);

            right_chunks[1]
        } else {
            pane_chunks[1]
        };

        // Render Content Viewer
        let viewer_border_color = if self.active_section == ActiveSection::Viewer {
            border_active_color
        } else {
            border_inactive_color
        };

        let viewer_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(viewer_border_color));

        self.last_content_area = content_area;
        if let Some(session) = self.pty_session.as_mut() {
            session.resize(
                content_area.width.saturating_sub(2),
                content_area.height.saturating_sub(2),
            );
        }

        if let Some(session) = self.pty_session.as_ref() {
            let title = self
                .selected_file
                .as_ref()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let editing_block = viewer_block.title(format!("✏️  Editing: {} (quit the editor to return)", title));
            if let Ok(parser) = session.parser.read() {
                let pseudo_term = PseudoTerminal::new(parser.screen()).block(editing_block);
                f.render_widget(pseudo_term, content_area);
            }
        } else if let Some(ref file_path) = self.selected_file {
            let path_str = file_path.to_string_lossy();
            let title = file_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            
            let viewer_block = viewer_block.title(format!("📄 Viewer: {} ({})", title, path_str));

            if is_media_file(&path_str) {
                let is_video = is_video_file(&title);
                if !is_video && self.image_protocol.is_some() {
                    let inner = viewer_block.inner(content_area);
                    f.render_widget(viewer_block, content_area);
                    if let Some(protocol) = self.image_protocol.as_mut() {
                        f.render_stateful_widget(StatefulImage::new().resize(Resize::Fit(None)), inner, protocol);
                    }
                } else {
                    let media_type = if is_video { "Video" } else { "Image" };
                    let media_lines = vec![
                        Line::from(""),
                        Line::from(vec![
                            Span::styled(format!("  🎞️ Media File: {}", title), Style::default().add_modifier(Modifier::BOLD).fg(self.palette.code))
                        ]),
                        Line::from(vec![
                            Span::styled(format!("  Type: {}", media_type), Style::default().fg(text_secondary_color))
                        ]),
                        Line::from(vec![
                            Span::styled(format!("  Location: {}", path_str), Style::default().fg(text_secondary_color))
                        ]),
                        Line::from(""),
                        Line::from(vec![
                            Span::styled("  Press ", Style::default().fg(text_secondary_color)),
                            Span::styled("Enter", Style::default().add_modifier(Modifier::BOLD).fg(accent_color)),
                            Span::styled(" or ", Style::default().fg(text_secondary_color)),
                            Span::styled("o", Style::default().add_modifier(Modifier::BOLD).fg(accent_color)),
                            Span::styled(" to open this media file in your system default GUI application.", Style::default().fg(text_secondary_color)),
                        ]),
                        Line::from(""),
                    ];
                    let paragraph = Paragraph::new(media_lines)
                        .block(viewer_block);
                    f.render_widget(paragraph, content_area);
                }
            } else if let Some(ref text) = self.file_content {
                let paragraph = Paragraph::new(text.clone())
                    .block(viewer_block)
                    .scroll((self.scroll_offset as u16, 0))
                    .wrap(Wrap { trim: false });
                f.render_widget(paragraph, content_area);
            } else {
                let paragraph = Paragraph::new(vec![Line::from("  No content loaded.")])
                    .block(viewer_block);
                f.render_widget(paragraph, content_area);
            }
        } else if self.help_active || self.gui_missing_active {
            // A notice will be overlaid below; keep a plain backdrop so we don't
            // show the welcome text twice.
            f.render_widget(viewer_block, content_area);
        } else {
            let viewer_block = viewer_block.title("📄 Welcome");

            let landing_text = self.get_welcome_text(accent_color, border_inactive_color, text_primary_color, text_secondary_color);
            let paragraph = Paragraph::new(landing_text)
                .block(viewer_block);
            f.render_widget(paragraph, content_area);
        }

        // Overlay notices (help, GUI-missing) as a distinct floating panel on
        // top of whatever is in the viewer, so they don't look like files.
        if self.gui_missing_active {
            self.render_notice(
                f,
                content_area,
                "🖥️  MarkDown Commander GUI not installed",
                self.get_gui_missing_text(accent_color, text_primary_color, text_secondary_color),
            );
        } else if self.help_active {
            self.render_notice(
                f,
                content_area,
                "❔ Help & Keyboard Shortcuts",
                self.get_welcome_text(accent_color, border_inactive_color, text_primary_color, text_secondary_color),
            );
        }

        // Render Help/Status Bar at bottom
        let help_bg = self.palette.code_bg;
        let help_fg = text_primary_color;
        let key_color = accent_color;

        if self.create_active {
            let create_line = Line::from(vec![
                Span::styled(" 📝 New file: ", Style::default().fg(accent_color).add_modifier(Modifier::BOLD)),
                Span::styled(self.create_input.clone(), Style::default().fg(text_primary_color)),
                Span::styled("█", Style::default().fg(accent_color)),
                Span::styled("  (Enter to create & edit, Esc to cancel)", Style::default().fg(text_secondary_color)),
            ]);
            let help_paragraph = Paragraph::new(create_line).style(Style::default().bg(help_bg));
            f.render_widget(help_paragraph, main_chunks[1]);
        } else if self.search_active {
            let search_line = Line::from(vec![
                Span::styled(" 🔍 Search: ", Style::default().fg(accent_color).add_modifier(Modifier::BOLD)),
                Span::styled(self.search_input.clone(), Style::default().fg(text_primary_color)),
                Span::styled("█", Style::default().fg(accent_color)),
                Span::styled("  (Enter to search, Esc to cancel)", Style::default().fg(text_secondary_color)),
            ]);
            let help_paragraph = Paragraph::new(search_line).style(Style::default().bg(help_bg));
            f.render_widget(help_paragraph, main_chunks[1]);
        } else if let Some(ref msg) = self.status_message {
            let msg_span = Span::styled(format!("  ✅ {} ", msg), Style::default().bg(help_bg).fg(accent_color).add_modifier(Modifier::BOLD));
            f.render_widget(Paragraph::new(Line::from(vec![msg_span])).style(Style::default().bg(help_bg)), main_chunks[1]);
        } else if let Some(ref err) = self.error {
            let error_span = Span::styled(format!("  ⚠️ Error: {} ", err), Style::default().bg(Color::Red).fg(Color::White).add_modifier(Modifier::BOLD));
            f.render_widget(Paragraph::new(Line::from(vec![error_span])).style(Style::default().bg(help_bg)), main_chunks[1]);
        } else {
            let help_spans = vec![
                Span::styled(" Tab", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Focus |", Style::default().fg(help_fg)),
                Span::styled(" [ / ] / Ctrl-1..9", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Tabs |", Style::default().fg(help_fg)),
                Span::styled(" Ctrl-Shift-1..9", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Workspaces |", Style::default().fg(help_fg)),
                Span::styled(" t", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Term |", Style::default().fg(help_fg)),
                Span::styled(" n", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" New |", Style::default().fg(help_fg)),
                Span::styled(" y/Y", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Copy path/name |", Style::default().fg(help_fg)),
                Span::styled(" Enter", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Open/Expand |", Style::default().fg(help_fg)),
                Span::styled(" Backspace/u", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Up |", Style::default().fg(help_fg)),
                Span::styled(" p", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Pin |", Style::default().fg(help_fg)),
                Span::styled(" v", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" ViewMode |", Style::default().fg(help_fg)),
                Span::styled(" e", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Edit |", Style::default().fg(help_fg)),
                Span::styled(" o", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Open Ext |", Style::default().fg(help_fg)),
                Span::styled(" g", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Open GUI |", Style::default().fg(help_fg)),
                Span::styled(" q/Esc", Style::default().fg(key_color).add_modifier(Modifier::BOLD)),
                Span::styled(" Quit", Style::default().fg(help_fg)),
            ];
            let help_line = Line::from(help_spans);
            let help_paragraph = Paragraph::new(help_line).style(Style::default().bg(help_bg));
            f.render_widget(help_paragraph, main_chunks[1]);
        }
    }

    /// Render the currently selected file's content across the entire terminal
    /// with no sidebar, borders or status bar (see the `f` key in the viewer).
    fn draw_fullscreen(
        &mut self,
        f: &mut Frame<'_>,
        area: ratatui::layout::Rect,
        text_primary_color: Color,
        text_secondary_color: Color,
        accent_color: Color,
    ) {
        // Margins mode: cap the content to a comfortable reading width and
        // center it in the terminal, with a small padding for breathing room.
        // NoMargins mode: use the full terminal, no padding — text wraps only
        // where the terminal itself forces a line break.
        const READING_WIDTH: u16 = 100;
        let (area, block) = if self.fullscreen == FullscreenMode::Margins {
            let content_width = area.width.min(READING_WIDTH);
            let margin_x = area.width.saturating_sub(content_width) / 2;
            let centered = Rect::new(area.x + margin_x, area.y, content_width, area.height);
            (centered, Block::default().padding(Padding::new(2, 2, 1, 0)))
        } else {
            (area, Block::default().padding(Padding::new(0, 0, 0, 0)))
        };

        let path_str = self
            .selected_file
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let title = self
            .selected_file
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        if is_media_file(&path_str) {
            let is_video = is_video_file(&title);
            if !is_video {
                if let Some(protocol) = self.image_protocol.as_mut() {
                    let inner = block.inner(area);
                    f.render_stateful_widget(StatefulImage::new().resize(Resize::Fit(None)), inner, protocol);
                    return;
                }
            }
            let media_type = if is_video { "Video" } else { "Image" };
            let media_lines = vec![
                Line::from(""),
                Line::from(vec![Span::styled(
                    format!("🎞️ Media File: {}", title),
                    Style::default().add_modifier(Modifier::BOLD).fg(self.palette.code),
                )]),
                Line::from(vec![Span::styled(
                    format!("Type: {}", media_type),
                    Style::default().fg(text_secondary_color),
                )]),
                Line::from(vec![Span::styled(
                    format!("Location: {}", path_str),
                    Style::default().fg(text_secondary_color),
                )]),
                Line::from(""),
                Line::from(vec![
                    Span::styled("Press ", Style::default().fg(text_secondary_color)),
                    Span::styled("f", Style::default().add_modifier(Modifier::BOLD).fg(accent_color)),
                    Span::styled(" to cycle reading modes, ", Style::default().fg(text_secondary_color)),
                    Span::styled("Esc", Style::default().add_modifier(Modifier::BOLD).fg(accent_color)),
                    Span::styled(" to exit fullscreen.", Style::default().fg(text_secondary_color)),
                ]),
            ];
            f.render_widget(Paragraph::new(media_lines).block(block), area);
        } else if let Some(ref text) = self.file_content {
            let paragraph = Paragraph::new(text.clone())
                .block(block)
                .scroll((self.scroll_offset as u16, 0))
                .wrap(Wrap { trim: false });
            f.render_widget(paragraph, area);
        } else {
            let paragraph = Paragraph::new(vec![Line::from(Span::styled(
                "No content loaded.",
                Style::default().fg(text_primary_color),
            ))])
            .block(block);
            f.render_widget(paragraph, area);
        }
    }

    /// Render a "notice" (help, GUI-missing, …) as a centered floating panel,
    /// styled distinctly from the file viewer: a double-lined accent border and
    /// a filled background, drawn on top of the current viewer content.
    fn render_notice(&self, f: &mut Frame<'_>, area: Rect, title: &str, lines: Vec<Line<'static>>) {
        let accent = self.palette.accent;
        let bg = self.palette.code_bg;

        // Size the box to its content, capped to the available area.
        let content_h = lines.len() as u16 + 4; // borders + vertical padding
        let box_h = content_h.min(area.height).max(3);
        let box_w = ((area.width * 8) / 10).clamp(20, 84).min(area.width);
        let x = area.x + area.width.saturating_sub(box_w) / 2;
        let y = area.y + area.height.saturating_sub(box_h) / 2;
        let popup = Rect::new(x, y, box_w, box_h);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Double)
            .border_style(Style::default().fg(accent).add_modifier(Modifier::BOLD))
            .title(Span::styled(
                format!(" {} ", title),
                Style::default().fg(accent).add_modifier(Modifier::BOLD),
            ))
            .style(Style::default().bg(bg))
            .padding(Padding::symmetric(2, 1));

        f.render_widget(Clear, popup);
        f.render_widget(
            Paragraph::new(lines).block(block).wrap(Wrap { trim: false }),
            popup,
        );
    }

    /// Info panel shown when the user presses `g` but the MarkDown Commander
    /// desktop app isn't installed: points at the GitHub releases page and
    /// summarises how to install per platform.
    pub fn get_gui_missing_text(&self, accent_color: Color, text_primary_color: Color, text_secondary_color: Color) -> Vec<Line<'static>> {
        let bold = Style::default().fg(text_primary_color).add_modifier(Modifier::BOLD);
        let body = Style::default().fg(text_secondary_color);
        let key = Style::default().fg(accent_color).add_modifier(Modifier::BOLD);
        vec![
            Line::from(""),
            Line::from(vec![
                Span::styled("  The MarkDown Commander desktop (GUI) app doesn't appear to be installed.", bold),
            ]),
            Line::from(vec![
                Span::styled("  The ", body),
                Span::styled("g", key),
                Span::styled(" shortcut opens the selected file in that app.", body),
            ]),
            Line::from(""),
            Line::from(vec![
                Span::styled("  Download the latest release from:", body),
            ]),
            Line::from(vec![
                Span::styled("    https://github.com/apstrand/mdcmd/releases", key),
            ]),
            Line::from(""),
            Line::from(vec![
                Span::styled("  Install:", bold),
            ]),
            Line::from(vec![
                Span::styled("    • macOS:   ", key),
                Span::styled("open the .dmg and drag \"MarkDown Commander\" to /Applications", body),
            ]),
            Line::from(vec![
                Span::styled("    • Windows: ", key),
                Span::styled("run the .msi / .exe installer", body),
            ]),
            Line::from(vec![
                Span::styled("    • Linux:   ", key),
                Span::styled("install the .AppImage/.deb, or run `cargo install mdcmd`", body),
            ]),
            Line::from(""),
            Line::from(vec![
                Span::styled("  Press any key to dismiss.", body),
            ]),
        ]
    }

    pub fn get_welcome_text(&self, accent_color: Color, border_inactive_color: Color, text_primary_color: Color, text_secondary_color: Color) -> Vec<Line<'static>> {
        vec![
            Line::from(""),
            Line::from(vec![
                Span::styled("    MarkDown Commander (mdc) TUI", Style::default().fg(accent_color).add_modifier(Modifier::BOLD))
            ]),
            Line::from(vec![
                Span::styled("    ──────────────────────", Style::default().fg(border_inactive_color))
            ]),
            Line::from(vec![
                Span::styled(
                    format!(
                        "    v{}  ·  commit {}  ·  {}",
                        env!("CARGO_PKG_VERSION"),
                        env!("GIT_HASH"),
                        env!("GIT_COMMIT_DATE"),
                    ),
                    Style::default().fg(text_secondary_color),
                )
            ]),
            Line::from(""),
            Line::from(vec![
                Span::styled("    No File Open.", Style::default().fg(text_primary_color).add_modifier(Modifier::BOLD))
            ]),
            Line::from("    Select a Markdown (.md) or Media file from the folders list to view it."),
            Line::from(""),
            Line::from(vec![
                Span::styled("    Keybindings:", Style::default().add_modifier(Modifier::BOLD).fg(self.palette.code))
            ]),
            Line::from(vec![
                Span::styled("    ?               : ", Style::default().fg(text_secondary_color)),
                Span::styled("Toggle this help screen", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    Tab / Shift-Tab : ", Style::default().fg(text_secondary_color)),
                Span::styled("Cycle focus between panels", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    [ / ]           : ", Style::default().fg(text_secondary_color)),
                Span::styled("Cycle active tabs", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    Ctrl-1..9       : ", Style::default().fg(text_secondary_color)),
                Span::styled("Switch active file tabs (1-9)", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    Ctrl-Shift-1..9 : ", Style::default().fg(text_secondary_color)),
                Span::styled("Activate pinned workspace item (1-9)", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    w / c           : ", Style::default().fg(text_secondary_color)),
                Span::styled("Close active file/tab (Viewer)", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    t               : ", Style::default().fg(text_secondary_color)),
                Span::styled("Open terminal in current directory", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    n               : ", Style::default().fg(text_secondary_color)),
                Span::styled("Create a new file in current directory", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    y / Y           : ", Style::default().fg(text_secondary_color)),
                Span::styled("Copy selected file path / name to clipboard", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    j / k / Arrows  : ", Style::default().fg(text_secondary_color)),
                Span::styled("Navigate lists and scroll viewer", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    Enter           : ", Style::default().fg(text_secondary_color)),
                Span::styled("Navigate folder / Expand node / Open file", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    Cmd/Alt-Enter   : ", Style::default().fg(text_secondary_color)),
                Span::styled("Open and focus file", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    Backspace / u   : ", Style::default().fg(text_secondary_color)),
                Span::styled("Navigate to parent directory", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    p               : ", Style::default().fg(text_secondary_color)),
                Span::styled("Pin/Unpin current folder/file to Workspaces", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    /               : ", Style::default().fg(text_secondary_color)),
                Span::styled("Search current folder", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    e               : ", Style::default().fg(text_secondary_color)),
                Span::styled("Edit current Markdown file (opens external editor)", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    o               : ", Style::default().fg(text_secondary_color)),
                Span::styled("Open file in external default application", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    g               : ", Style::default().fg(text_secondary_color)),
                Span::styled("Open file in MarkDown Commander GUI", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    v               : ", Style::default().fg(text_secondary_color)),
                Span::styled("Toggle Folder view mode (List/Tree)", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    f               : ", Style::default().fg(text_secondary_color)),
                Span::styled("Cycle fullscreen reading modes: normal/margins/no margins (Viewer; Esc to exit)", Style::default().fg(text_primary_color))
            ]),
            Line::from(vec![
                Span::styled("    Ctrl-q          : ", Style::default().fg(text_secondary_color)),
                Span::styled("Quit application", Style::default().fg(text_primary_color))
            ]),
        ]
    }
}

/// Encode a crossterm key event as the raw bytes a real terminal would send
/// for it, so it can be written straight into a PTY's input. Covers the
/// keys interactive editors (vim, nano, ...) actually rely on: control
/// chars (via Ctrl+letter), Alt as an Esc prefix, and standard xterm CSI/SS3
/// sequences for cursor/function keys.
fn pty_input_bytes(key: event::KeyEvent) -> Vec<u8> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);

    let mut bytes: Vec<u8> = match key.code {
        KeyCode::Char(c) if ctrl => match c.to_ascii_lowercase() {
            lower @ 'a'..='z' => vec![(lower as u8) - b'a' + 1],
            _ => match c {
                '[' => vec![0x1b],
                '\\' => vec![0x1c],
                ']' => vec![0x1d],
                '^' => vec![0x1e],
                '_' | '?' => vec![0x1f],
                '@' | ' ' => vec![0x00],
                _ => c.to_string().into_bytes(),
            },
        },
        KeyCode::Char(c) => c.to_string().into_bytes(),
        KeyCode::Enter => vec![b'\r'],
        KeyCode::Backspace => vec![0x7f],
        KeyCode::Tab => vec![0x09],
        KeyCode::BackTab => b"\x1b[Z".to_vec(),
        KeyCode::Esc => vec![0x1b],
        KeyCode::Left => b"\x1b[D".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(),
        KeyCode::Up => b"\x1b[A".to_vec(),
        KeyCode::Down => b"\x1b[B".to_vec(),
        KeyCode::Home => b"\x1b[H".to_vec(),
        KeyCode::End => b"\x1b[F".to_vec(),
        KeyCode::PageUp => b"\x1b[5~".to_vec(),
        KeyCode::PageDown => b"\x1b[6~".to_vec(),
        KeyCode::Delete => b"\x1b[3~".to_vec(),
        KeyCode::Insert => b"\x1b[2~".to_vec(),
        KeyCode::F(n) => f_key_bytes(n),
        _ => Vec::new(),
    };

    if alt && !bytes.is_empty() {
        bytes.insert(0, 0x1b);
    }

    bytes
}

fn f_key_bytes(n: u8) -> Vec<u8> {
    match n {
        1 => b"\x1bOP".to_vec(),
        2 => b"\x1bOQ".to_vec(),
        3 => b"\x1bOR".to_vec(),
        4 => b"\x1bOS".to_vec(),
        5 => b"\x1b[15~".to_vec(),
        6 => b"\x1b[17~".to_vec(),
        7 => b"\x1b[18~".to_vec(),
        8 => b"\x1b[19~".to_vec(),
        9 => b"\x1b[20~".to_vec(),
        10 => b"\x1b[21~".to_vec(),
        11 => b"\x1b[23~".to_vec(),
        12 => b"\x1b[24~".to_vec(),
        _ => Vec::new(),
    }
}

pub fn is_media_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".svg")
        || lower.ends_with(".bmp")
        || lower.ends_with(".ico")
        || lower.ends_with(".mp4")
        || lower.ends_with(".webm")
        || lower.ends_with(".ogg")
        || lower.ends_with(".mov")
        || lower.ends_with(".mkv")
}

pub fn is_markdown_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".qmd")
}

pub fn is_video_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".mp4")
        || lower.ends_with(".webm")
        || lower.ends_with(".ogg")
        || lower.ends_with(".mov")
        || lower.ends_with(".mkv")
}

pub fn open_system_default(path: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).status()?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(&["/C", "start", "", path]).status()?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::process::Command::new("xdg-open").arg(path).status()?;
    }
    Ok(())
}

/// Best-effort check for whether the MarkDown Commander desktop (GUI) app is
/// installed, so we can point the user at the download page if it isn't.
pub fn is_gui_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![PathBuf::from("/Applications/MarkDown Commander.app")];
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join("Applications/MarkDown Commander.app"));
        }
        candidates.iter().any(|p| p.exists())
    }
    #[cfg(target_os = "windows")]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(var) {
                candidates.push(
                    PathBuf::from(&base)
                        .join("MarkDown Commander")
                        .join("MarkDown Commander.exe"),
                );
            }
        }
        candidates.iter().any(|p| p.exists())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // On Linux the GUI is launched via the `mdcmd` binary on PATH.
        if let Ok(path) = std::env::var("PATH") {
            std::env::split_paths(&path).any(|dir| dir.join("mdcmd").exists())
        } else {
            false
        }
    }
}

pub fn open_in_gui(path: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(&["-a", "MarkDown Commander", path]).status()?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(&["/C", "start", "", "MarkDown Commander.exe", path]).status()?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::process::Command::new("mdcmd").arg(path).status()?;
    }
    Ok(())
}

/// Launch the MarkDown Commander GUI with no file (used by `mdc --gui`).
pub fn launch_gui() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(&["-a", "MarkDown Commander"]).status()?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(&["/C", "start", "", "MarkDown Commander.exe"]).status()?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::process::Command::new("mdcmd").status()?;
    }
    Ok(())
}

pub fn list_directory(path: &Path) -> Result<Vec<FileEntry>> {
    if !path.exists() {
        return Err(anyhow::anyhow!("Directory does not exist: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(anyhow::anyhow!("Path is not a directory: {}", path.display()));
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(path)?;

    for entry in read_dir {
        if let Ok(entry) = entry {
            let file_path = entry.path();
            let is_dir = file_path.is_dir();
            let name = entry.file_name().to_string_lossy().into_owned();

            // Skip hidden files/directories
            if name.starts_with('.') {
                continue;
            }

            entries.push(FileEntry {
                name,
                path: file_path.to_string_lossy().into_owned(),
                is_dir,
            });
        }
    }

    // Sort: directories first, then alphabetically by name (case-insensitive)
    entries.sort_by(|a, b| {
        if a.is_dir && !b.is_dir {
            std::cmp::Ordering::Less
        } else if !a.is_dir && b.is_dir {
            std::cmp::Ordering::Greater
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(entries)
}




pub fn symbol_to_digit(c: char) -> Option<char> {
    match c {
        '!' => Some('1'),
        '@' => Some('2'),
        '#' => Some('3'),
        '$' => Some('4'),
        '%' => Some('5'),
        '^' => Some('6'),
        '&' => Some('7'),
        '*' => Some('8'),
        '(' => Some('9'),
        _ => None,
    }
}
