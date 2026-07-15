use tauri::{
  plugin::{Builder, TauriPlugin},
  AppHandle, Manager, Runtime,
};

pub use models::*;

// iOS is the only platform with a real implementation. Every other target
// (desktop and Android for now) compiles a stub that reports "unsupported", so
// the crate stays consistent regardless of what it is built for.
#[cfg(target_os = "ios")]
mod ios;
#[cfg(not(target_os = "ios"))]
mod stub;

mod error;
mod models;

pub use error::{Error, Result};

#[cfg(target_os = "ios")]
use ios::Docpicker;
#[cfg(not(target_os = "ios"))]
use stub::Docpicker;

/// Extension trait to reach the docpicker APIs from any [`Manager`].
pub trait DocpickerExt<R: Runtime> {
  fn docpicker(&self) -> &Docpicker<R>;
}

impl<R: Runtime, T: Manager<R>> crate::DocpickerExt<R> for T {
  fn docpicker(&self) -> &Docpicker<R> {
    self.state::<Docpicker<R>>().inner()
  }
}

/// Present the native folder picker. Resolves to the picked folder, or `None`
/// when the user cancels.
#[tauri::command]
async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<PickedFolder>> {
  app.docpicker().pick_folder()
}

/// Re-activate every saved security-scoped bookmark so previously-picked folders
/// are readable again after an app relaunch. Returns the paths now accessible.
#[tauri::command]
async fn restore_access<R: Runtime>(app: AppHandle<R>) -> Result<Vec<String>> {
  app.docpicker().restore_access()
}

/// Release access to (and forget the bookmark for) a previously-picked folder.
#[tauri::command]
async fn release_folder<R: Runtime>(app: AppHandle<R>, path: String) -> Result<()> {
  app.docpicker().release_folder(path)
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("docpicker")
    .invoke_handler(tauri::generate_handler![
      pick_folder,
      restore_access,
      release_folder
    ])
    .setup(|app, api| {
      #[cfg(target_os = "ios")]
      let docpicker = ios::init(app, api)?;
      #[cfg(not(target_os = "ios"))]
      let docpicker = stub::init(app, api)?;
      app.manage(docpicker);
      Ok(())
    })
    .build()
}
