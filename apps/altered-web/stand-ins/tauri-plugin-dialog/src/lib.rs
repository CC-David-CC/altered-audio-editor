// SPDX-License-Identifier: GPL-3.0-or-later
//! File dialogs for the page to show (see ../tauri). A dialog can't wait for the page inside a command, so the first
//! call gives the cancel answer and leaves the question in [`take_question`]; the page shows Playground's dialog and,
//! unless it was cancelled, gives the answer ([`answer`]) and calls the same command again, whose dialog now has it.
use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde::Serialize;

pub fn init() -> tauri::Plugin {
    tauri::Plugin
}

/// What a dialog asks, for the page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// open, openMany, folder or save.
    pub kind: &'static str,
    pub title: Option<String>,
    /// The extensions each filter takes ("*" for any).
    pub filters: Vec<(String, Vec<String>)>,
    pub file_name: Option<String>,
    pub directory: Option<PathBuf>,
}

thread_local! {
    static QUESTION: RefCell<Option<Question>> = const { RefCell::new(None) };
    static ANSWERS: RefCell<VecDeque<Vec<PathBuf>>> = const { RefCell::new(VecDeque::new()) };
}

/// The question a dialog asked since the last call.
pub fn take_question() -> Option<Question> {
    QUESTION.take()
}

/// The paths the next dialog gives (one for open, folder and save).
pub fn answer(paths: Vec<PathBuf>) {
    ANSWERS.with_borrow_mut(|a| a.push_back(paths));
}

/// Answers left unused (a command that no longer asks).
pub fn forget_answers() {
    ANSWERS.with_borrow_mut(VecDeque::clear);
}

#[derive(Debug, Clone)]
pub struct FilePath(PathBuf);

impl FilePath {
    pub fn as_path(&self) -> Option<&Path> {
        Some(&self.0)
    }
    pub fn into_path(self) -> tauri::Result<PathBuf> {
        Ok(self.0)
    }
}

impl std::fmt::Display for FilePath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.display().fmt(f)
    }
}

pub struct Dialog;

impl Dialog {
    pub fn file(&self) -> FileDialogBuilder {
        FileDialogBuilder(Question { kind: "open", title: None, filters: Vec::new(), file_name: None, directory: None })
    }
}

pub trait DialogExt {
    fn dialog(&self) -> Dialog;
}

impl DialogExt for tauri::AppHandle {
    fn dialog(&self) -> Dialog {
        Dialog
    }
}

pub struct FileDialogBuilder(Question);

impl FileDialogBuilder {
    pub fn set_title(mut self, title: impl Into<String>) -> Self {
        self.0.title = Some(title.into());
        self
    }
    pub fn add_filter(mut self, name: impl Into<String>, extensions: &[&str]) -> Self {
        self.0.filters.push((name.into(), extensions.iter().map(|e| e.to_string()).collect()));
        self
    }
    pub fn set_parent<W>(self, _parent: &W) -> Self {
        self
    }
    pub fn set_directory(mut self, directory: impl AsRef<Path>) -> Self {
        self.0.directory = Some(directory.as_ref().to_path_buf());
        self
    }
    pub fn set_file_name(mut self, name: impl Into<String>) -> Self {
        self.0.file_name = Some(name.into());
        self
    }

    fn ask(mut self, kind: &'static str) -> Option<Vec<FilePath>> {
        if let Some(paths) = ANSWERS.with_borrow_mut(VecDeque::pop_front) {
            return Some(paths.into_iter().map(FilePath).collect());
        }
        self.0.kind = kind;
        QUESTION.set(Some(self.0));
        None
    }

    pub fn blocking_pick_file(self) -> Option<FilePath> {
        self.ask("open")?.into_iter().next()
    }
    pub fn blocking_pick_files(self) -> Option<Vec<FilePath>> {
        self.ask("openMany").filter(|p| !p.is_empty())
    }
    pub fn blocking_pick_folder(self) -> Option<FilePath> {
        self.ask("folder")?.into_iter().next()
    }
    pub fn blocking_save_file(self) -> Option<FilePath> {
        self.ask("save")?.into_iter().next()
    }
}
