// SPDX-License-Identifier: GPL-3.0-or-later
//! Playground serves the newest build, so there is never an update to install (see ../tauri).
use std::future::Future;

pub struct Builder;

impl Builder {
    pub fn new() -> Self {
        Builder
    }
    pub fn build(self) -> tauri::Plugin {
        tauri::Plugin
    }
}

impl Default for Builder {
    fn default() -> Self {
        Builder
    }
}

pub struct Update {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
}

impl Update {
    pub fn download_and_install<C: FnMut(usize, Option<u64>), D: FnOnce()>(
        &self,
        _on_chunk: C,
        _on_finish: D,
    ) -> impl Future<Output = tauri::Result<()>> {
        std::future::ready(Err(tauri::Error("Playground keeps this app up to date.".into())))
    }
}

pub struct Updater;

impl Updater {
    pub fn check(&self) -> impl Future<Output = tauri::Result<Option<Update>>> {
        std::future::ready(Ok(None))
    }
}

pub trait UpdaterExt {
    fn updater(&self) -> tauri::Result<Updater>;
}

impl UpdaterExt for tauri::AppHandle {
    fn updater(&self) -> tauri::Result<Updater> {
        Ok(Updater)
    }
}
