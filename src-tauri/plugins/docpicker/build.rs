const COMMANDS: &[&str] = &["pick_folder", "pick_file", "restore_access", "release_folder"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .ios_path("ios")
    .build();
}
