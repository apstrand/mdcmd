use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<Docpicker<R>> {
  Ok(Docpicker(app.clone()))
}

/// Stub for platforms without a native document picker (desktop, Android).
pub struct Docpicker<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> Docpicker<R> {
  pub fn pick_folder(&self) -> crate::Result<Option<PickedFolder>> {
    Err(crate::Error::Unsupported)
  }

  /// No bookmarks to restore off-iOS; report an empty set rather than erroring
  /// so a shared startup path can call this unconditionally.
  pub fn restore_access(&self) -> crate::Result<Vec<String>> {
    Ok(Vec::new())
  }

  pub fn release_folder(&self, _path: String) -> crate::Result<()> {
    Ok(())
  }
}
