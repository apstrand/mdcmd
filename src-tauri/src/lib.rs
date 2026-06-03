use std::path::{Path, PathBuf};
use std::env;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Debug)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env::var("USERPROFILE").map(PathBuf::from).ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        env::var("HOME").map(PathBuf::from).ok()
    }
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "Could not find home directory".to_string())
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let path = Path::new(&path);
    if !path.exists() {
        return Err(format!("Directory does not exist: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(path).map_err(|e| e.to_string())?;

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

    // Sort: directories first, then alphabetically by name
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

#[tauri::command]
fn read_file_content(path: String) -> Result<String, String> {
    let path = Path::new(&path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }
    if path.is_dir() {
        return Err(format!("Path is a directory, not a file: {}", path.display()));
    }

    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file_content(path: String, content: String) -> Result<(), String> {
    let path = Path::new(&path);
    if path.is_dir() {
        return Err(format!("Path is a directory, cannot write content to it: {}", path.display()));
    }

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_home_dir,
            list_directory,
            read_file_content,
            write_file_content
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
