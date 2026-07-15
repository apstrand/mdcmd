use serde::{Deserialize, Serialize};

/// A folder the user granted access to through the native document picker.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFolder {
  /// Absolute filesystem path of the picked folder (readable/writable while its
  /// security-scoped bookmark is active).
  pub path: String,
  /// Last path component, shown in the UI.
  pub name: String,
}

/// Result of presenting the folder picker. `folder` is `None` when the user
/// cancels the picker.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFolderResponse {
  pub folder: Option<PickedFolder>,
}

/// Result of re-activating saved bookmarks on launch: the paths that are now
/// accessible again.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResponse {
  pub paths: Vec<String>,
}

/// Payload for releasing a previously-picked folder.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseRequest {
  pub path: String,
}

/// Empty acknowledgement returned by commands that produce no data.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct EmptyResponse {}
