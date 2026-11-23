// SPDX-License-Identifier: GPL-3.0-or-later
//! Tauri 2 as Altered Audio Editor's back end uses it, for Playground's browser build (patches/audition.yaml in
//! github.com/daijro/openplayground). The back end compiles unchanged against it: `Builder::run` keeps the command
//! handler and the managed state instead of opening a window, and the page calls commands through [`__private::invoke`]
//! (apps/altered-web/src/lib.rs). What a window would do (events, titles, links, quitting) goes to the page through
//! [`__private::set_host`].
//!
//! Files: `/` is Playground's Files (the page mirrors what changes there); the app's own folders are under `/.app`.
use std::any::{Any, TypeId};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

pub use playground_tauri_macros::{command, generate_context, generate_handler};

#[derive(Debug, Clone)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

thread_local! {
    static STATES: RefCell<HashMap<TypeId, &'static dyn Any>> = RefCell::default();
}

/// A managed value, as a command or [`Manager::state`] gets it.
pub struct State<'r, T: 'static>(&'r T);

impl<'r, T: 'static> State<'r, T> {
    pub fn inner(&self) -> &'r T {
        self.0
    }
}

impl<T: 'static> std::ops::Deref for State<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0
    }
}

impl<T: 'static> Clone for State<'_, T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T: 'static> Copy for State<'_, T> {}

/// The one app (and its one window).
#[derive(Clone, Copy, Debug, Default)]
pub struct AppHandle;
pub type App = AppHandle;

#[derive(Clone, Copy, Debug, Default)]
pub struct WebviewWindow;
pub type Window = WebviewWindow;

impl WebviewWindow {
    pub fn set_title(&self, title: &str) -> Result<()> {
        __private::host("set-title", &serde_json::Value::from(title));
        Ok(())
    }
    pub fn minimize(&self) -> Result<()> {
        Ok(())
    }
    pub fn label(&self) -> &str {
        "main"
    }
}

/// The app's folders, in the page's file system.
pub struct PathResolver;

impl PathResolver {
    fn at(p: &str) -> Result<PathBuf> {
        Ok(PathBuf::from(p))
    }
    fn none(what: &str) -> Result<PathBuf> {
        Err(Error(format!("no {what} folder in the browser")))
    }
    pub fn app_config_dir(&self) -> Result<PathBuf> {
        Self::at("/.app/config")
    }
    pub fn app_data_dir(&self) -> Result<PathBuf> {
        Self::at("/.app/data")
    }
    pub fn app_local_data_dir(&self) -> Result<PathBuf> {
        Self::at("/.app/data")
    }
    pub fn app_cache_dir(&self) -> Result<PathBuf> {
        Self::at("/.app/cache")
    }
    pub fn app_log_dir(&self) -> Result<PathBuf> {
        Self::at("/.app/logs")
    }
    pub fn temp_dir(&self) -> Result<PathBuf> {
        Self::at("/.app/tmp")
    }
    /// Files' top level.
    pub fn home_dir(&self) -> Result<PathBuf> {
        Self::at("/")
    }
    pub fn document_dir(&self) -> Result<PathBuf> {
        Self::none("Documents")
    }
    pub fn desktop_dir(&self) -> Result<PathBuf> {
        Self::none("Desktop")
    }
    pub fn audio_dir(&self) -> Result<PathBuf> {
        Self::none("Music")
    }
    pub fn download_dir(&self) -> Result<PathBuf> {
        Self::none("Downloads")
    }
}

static PATHS: PathResolver = PathResolver;

pub trait Manager {
    fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        self.try_state().unwrap_or_else(|| panic!("{} is not managed", std::any::type_name::<T>()))
    }
    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
        STATES.with_borrow(|s| s.get(&TypeId::of::<T>()).and_then(|v| v.downcast_ref::<T>()).map(State))
    }
    fn manage<T: Send + Sync + 'static>(&self, value: T) -> bool {
        let v: &'static T = Box::leak(Box::new(value));
        STATES.with_borrow_mut(|s| s.insert(TypeId::of::<T>(), v).is_none())
    }
    fn get_webview_window(&self, _label: &str) -> Option<WebviewWindow> {
        Some(WebviewWindow)
    }
    fn path(&self) -> &PathResolver {
        &PATHS
    }
}

impl Manager for AppHandle {}

/// What `package_info()` answers: the settings backup (commands/backup.rs) tags its snapshots with the app's version, and the
/// page keeps them for the page's session only, so one name for every build will do.
pub struct PackageInfo {
    pub version: Version,
}
pub struct Version(pub &'static str);
impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
static PACKAGE_INFO: PackageInfo = PackageInfo { version: Version("web") };

impl AppHandle {
    /// `App::handle` (an App is an AppHandle here).
    pub fn handle(&self) -> &AppHandle {
        self
    }
    pub fn package_info(&self) -> &PackageInfo {
        &PACKAGE_INFO
    }
    /// File > Exit: the page goes back to Playground.
    pub fn exit(&self, code: i32) {
        __private::host("exit", &serde_json::Value::from(code));
    }
    pub fn restart(&self) -> ! {
        __private::host("restart", &serde_json::Value::Null);
        std::process::exit(0)
    }
}

pub trait Emitter {
    fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> Result<()>;
}

impl Emitter for AppHandle {
    fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> Result<()> {
        let payload = serde_json::to_value(payload).map_err(|e| Error(e.to_string()))?;
        __private::host(&format!("event:{event}"), &payload);
        Ok(())
    }
}

#[derive(Default)]
pub struct Context;

/// What a plug-in's `init()` gives; nothing here needs one.
pub struct Plugin;

type Setup = Box<dyn FnOnce(&mut App) -> std::result::Result<(), Box<dyn std::error::Error>>>;

#[derive(Default)]
pub struct Builder {
    setups: Vec<Setup>,
    handler: Option<__private::Handler>,
}

impl Builder {
    pub fn manage<T: Send + Sync + 'static>(self, value: T) -> Self {
        AppHandle.manage(value);
        self
    }
    pub fn setup<F>(mut self, f: F) -> Self
    where
        F: FnOnce(&mut App) -> std::result::Result<(), Box<dyn std::error::Error>> + 'static,
    {
        self.setups.push(Box::new(f));
        self
    }
    pub fn plugin<P>(self, _plugin: P) -> Self {
        self
    }
    pub fn invoke_handler(mut self, handler: __private::Handler) -> Self {
        self.handler = Some(handler);
        self
    }
    /// Keeps the handler for the page's calls and runs the setup; returns at once.
    pub fn run(self, _context: Context) -> Result<()> {
        __private::HANDLER.set(self.handler);
        for setup in self.setups {
            setup(&mut AppHandle).map_err(|e| Error(e.to_string()))?;
        }
        Ok(())
    }
}

pub mod ipc {
    /// Raw bytes for the page (an `ArrayBuffer` there).
    pub struct Response(Vec<u8>);

    impl Response {
        pub fn new(bytes: impl Into<Vec<u8>>) -> Self {
            Self(bytes.into())
        }
        pub fn into_bytes(self) -> Vec<u8> {
            self.0
        }
    }
}

pub mod async_runtime {
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    /// Done already: the page has one thread, so blocking work runs as it is handed over.
    pub struct JoinHandle<T>(Option<T>);

    impl<T> Unpin for JoinHandle<T> {}

    impl<T> Future for JoinHandle<T> {
        type Output = crate::Result<T>;
        fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
            Poll::Ready(self.0.take().ok_or_else(|| crate::Error("polled twice".into())))
        }
    }

    pub fn spawn_blocking<F: FnOnce() -> R, R>(f: F) -> JoinHandle<R> {
        JoinHandle(Some(f()))
    }

    pub fn block_on<F: Future>(f: F) -> F::Output {
        crate::__private::block_on(f)
    }
}

#[doc(hidden)]
pub mod __private {
    use super::AppHandle;
    use std::cell::RefCell;
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    pub use serde_json::Value;

    pub type Handler = fn(&str, &AppHandle, &Value) -> Option<Reply>;

    thread_local! {
        pub(crate) static HANDLER: RefCell<Option<Handler>> = const { RefCell::new(None) };
        static HOST: RefCell<Option<Box<dyn Fn(&str, &Value)>>> = RefCell::new(None);
    }

    pub enum Reply {
        Json(Value),
        Bytes(Vec<u8>),
        Err(Value),
    }

    impl Reply {
        pub fn json<T: serde::Serialize>(v: &T) -> Reply {
            serde_json::to_value(v).map_or_else(|e| Reply::Err(e.to_string().into()), Reply::Json)
        }
        pub fn error<E: serde::Serialize>(e: E) -> Reply {
            Reply::Err(serde_json::to_value(e).unwrap_or_else(|e| e.to_string().into()))
        }
    }

    /// One argument, by its name in the call's object; a missing one reads as null (an `Option` is then `None`).
    pub fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
        T::deserialize(args.get(key).unwrap_or(&Value::Null))
            .map_err(|e| format!("invalid args `{key}` for command: {e}"))
    }

    /// Runs a command's future to its end: nothing in it waits for anything but blocking work, which is done
    /// already ([`super::async_runtime::spawn_blocking`]).
    pub fn block_on<F: Future>(f: F) -> F::Output {
        let mut f = std::pin::pin!(f);
        let mut cx = Context::from_waker(Waker::noop());
        for _ in 0..1000 {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
        }
        panic!("a command waited for something that never came")
    }

    /// Calls a command; None when there is no such command.
    pub fn invoke(cmd: &str, args: &Value) -> Option<Reply> {
        let handler = HANDLER.with_borrow(|h| *h)?;
        handler(cmd, &AppHandle, args)
    }

    /// Where events, titles, links and quitting go (the page).
    pub fn set_host(f: impl Fn(&str, &Value) + 'static) {
        HOST.set(Some(Box::new(f)));
    }

    pub fn host(what: &str, payload: &Value) {
        HOST.with_borrow(|h| {
            if let Some(h) = h {
                h(what, payload)
            }
        });
    }
}
