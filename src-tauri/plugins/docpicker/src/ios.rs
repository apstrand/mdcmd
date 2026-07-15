use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

tauri::ios_plugin_binding!(init_plugin_docpicker);

pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<Docpicker<R>> {
  let handle = api.register_ios_plugin(init_plugin_docpicker)?;
  Ok(Docpicker(handle))
}

/// Access to the docpicker APIs, backed by the Swift `DocpickerPlugin`.
pub struct Docpicker<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Docpicker<R> {
  pub fn pick_folder(&self) -> crate::Result<Option<PickedFolder>> {
    let res: PickFolderResponse = self.0.run_mobile_plugin("pickFolder", ())?;
    Ok(res.folder)
  }

  pub fn restore_access(&self) -> crate::Result<Vec<String>> {
    let res: RestoreResponse = self.0.run_mobile_plugin("restoreAccess", ())?;
    Ok(res.paths)
  }

  pub fn release_folder(&self, path: String) -> crate::Result<()> {
    let _: EmptyResponse = self
      .0
      .run_mobile_plugin("releaseFolder", ReleaseRequest { path })?;
    Ok(())
  }
}
