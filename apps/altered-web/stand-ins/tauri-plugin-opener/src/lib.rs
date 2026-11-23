// SPDX-License-Identifier: GPL-3.0-or-later
//! Links open in a new tab (see ../tauri); there is no file manager to show a file in.
use std::path::Path;

pub fn init() -> tauri::Plugin {
    tauri::Plugin
}

pub struct Opener;

impl Opener {
    pub fn open_url(&self, url: impl Into<String>, _with: Option<impl Into<String>>) -> tauri::Result<()> {
        tauri::__private::host("open-url", &tauri::__private::Value::from(url.into()));
        Ok(())
    }
}

pub trait OpenerExt {
    fn opener(&self) -> Opener;
}

impl OpenerExt for tauri::AppHandle {
    fn opener(&self) -> Opener {
        Opener
    }
}

pub fn reveal_item_in_dir(_path: impl AsRef<Path>) -> tauri::Result<()> {
    Err(tauri::Error("Files in the browser can't be shown in a file manager.".into()))
}
