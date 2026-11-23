// SPDX-License-Identifier: GPL-3.0-or-later
//! Altered Audio Editor's back end for Playground's browser build (patches/audition.yaml in
//! github.com/daijro/openplayground): a WASI module the page (apps/altered-web/js/backend.ts) runs. Its exports:
//!
//!   pg_start()                          the app's setup (src-tauri's `run`, against the stand-in `tauri` crate)
//!   pg_alloc(len) / pg_free(ptr, len)   memory for the page's bytes
//!   pg_invoke(cmd, len, args, len)      a command, its arguments as JSON; 0 JSON, 1 bytes, 2 an error (JSON), 3 no
//!                                       such command; the reply is at pg_reply_ptr(), pg_reply_len() bytes long
//!   pg_question()                       the file dialog a command asked for since (JSON, or 0 bytes), see
//!                                       stand-ins/tauri-plugin-dialog
//!   pg_answer(json, len)                the paths the next dialog gives
//!   pg_render(frames) -> ptr            the next block of audio, interleaved stereo f32
//!   pg_capture(frames) -> ptr           room for the microphone's next block (same layout); then pg_captured()
//!
//! and its import: `playground.host(what, len, json, len)` for events, titles, links and quitting.
use std::cell::RefCell;
use std::path::PathBuf;

use tauri::__private::{Reply, Value};

#[link(wasm_import_module = "playground")]
extern "C" {
    fn host(what: *const u8, what_len: usize, json: *const u8, json_len: usize);
}

thread_local! {
    static REPLY: RefCell<Vec<u8>> = RefCell::default();
    static AUDIO: RefCell<Vec<f32>> = RefCell::default();
    static MIC: RefCell<Vec<f32>> = RefCell::default();
}

#[no_mangle]
pub extern "C" fn pg_start() {
    tauri::__private::set_host(|what, payload| {
        let json = payload.to_string();
        // SAFETY: both point at live bytes for the call; the page copies them before returning.
        unsafe { host(what.as_ptr(), what.len(), json.as_ptr(), json.len()) }
    });
    altered_audio_editor_lib::run();
}

#[no_mangle]
pub extern "C" fn pg_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` came from one [`pg_alloc`].
#[no_mangle]
pub unsafe extern "C" fn pg_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

/// # Safety
/// The page's bytes, from [`pg_alloc`].
unsafe fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
    std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).unwrap_or("")
}

fn set_reply(bytes: Vec<u8>) {
    REPLY.set(bytes);
}

/// # Safety
/// The page's bytes, from [`pg_alloc`].
#[no_mangle]
pub unsafe extern "C" fn pg_invoke(cmd: *const u8, cmd_len: usize, args: *const u8, args_len: usize) -> u32 {
    let cmd = text(cmd, cmd_len);
    let args: Value = serde_json::from_str(text(args, args_len)).unwrap_or(Value::Null);
    match tauri::__private::invoke(cmd, &args) {
        Some(Reply::Json(v)) => {
            set_reply(v.to_string().into_bytes());
            0
        }
        Some(Reply::Bytes(b)) => {
            set_reply(b);
            1
        }
        Some(Reply::Err(e)) => {
            set_reply(e.to_string().into_bytes());
            2
        }
        None => {
            set_reply(Vec::new());
            3
        }
    }
}

#[no_mangle]
pub extern "C" fn pg_reply_ptr() -> *const u8 {
    REPLY.with_borrow(|r| r.as_ptr())
}

#[no_mangle]
pub extern "C" fn pg_reply_len() -> usize {
    REPLY.with_borrow(|r| r.len())
}

#[no_mangle]
pub extern "C" fn pg_question() -> usize {
    let q = tauri_plugin_dialog::take_question()
        .and_then(|q| serde_json::to_vec(&q).ok())
        .unwrap_or_default();
    let n = q.len();
    set_reply(q);
    n
}

/// # Safety
/// The page's bytes, from [`pg_alloc`].
#[no_mangle]
pub unsafe extern "C" fn pg_answer(json: *const u8, len: usize) {
    let paths: Vec<PathBuf> = serde_json::from_str(text(json, len)).unwrap_or_default();
    tauri_plugin_dialog::answer(paths);
}

#[no_mangle]
pub extern "C" fn pg_forget_answers() {
    tauri_plugin_dialog::forget_answers();
}

#[no_mangle]
pub extern "C" fn pg_playing() -> u32 {
    u32::from(altered_playground::playing())
}

#[no_mangle]
pub extern "C" fn pg_render(frames: usize) -> *const f32 {
    AUDIO.with_borrow_mut(|buf| {
        buf.resize(frames * altered_playground::CHANNELS, 0.0);
        altered_playground::render(buf);
        buf.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn pg_recording() -> u32 {
    u32::from(altered_playground::recording())
}

#[no_mangle]
pub extern "C" fn pg_capture(frames: usize) -> *mut f32 {
    MIC.with_borrow_mut(|buf| {
        buf.resize(frames * altered_playground::CHANNELS, 0.0);
        buf.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn pg_captured() {
    MIC.with_borrow(|buf| altered_playground::capture(buf));
}
