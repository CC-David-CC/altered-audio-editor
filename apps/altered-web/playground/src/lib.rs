// SPDX-License-Identifier: GPL-3.0-or-later
//! Altered Audio Editor in the browser, for Playground (patches/audition.yaml in github.com/daijro/openplayground).
//!
//! A page has one thread, so the back end's playback and recording can't run on threads of their own. Each player
//! starts as upstream does, with its `run` in a module `web` beside it: `run` sets the player up, hands [`play`] a
//! callback that renders what the queues have room for and then plays from them, and returns. The page's audio asks
//! for each block ([`render`], through apps/altered-web's exports), at [`RATE`] in stereo. Recording is the same the
//! other way round: [`record`]'s callback gets each block of the page's microphone ([`capture`]).
//!
//! [`std`] is the standard library with a `thread` whose `spawn` runs what it's given at once (`run` returns once it
//! is set up). The players' modules take `std` from here through one line at their end; everything else in them
//! still comes from the real std.
use std::cell::RefCell;

/// The page's audio runs at this rate (the browser resamples for the device).
pub const RATE: u32 = 48_000;
/// Stereo.
pub const CHANNELS: usize = 2;

type Player = Box<dyn FnMut(&mut [f32]) -> bool>;
type Recorder = Box<dyn FnMut(&[f32]) -> bool>;

thread_local! {
    static PLAYERS: RefCell<Vec<Player>> = RefCell::default();
    static RECORDERS: RefCell<Vec<Recorder>> = RefCell::default();
    static SCRATCH: RefCell<Vec<f32>> = RefCell::default();
}

/// Gives `take` each block of the microphone (interleaved stereo at [`RATE`]) until it returns false.
pub fn record(take: impl FnMut(&[f32]) -> bool + 'static) {
    RECORDERS.with_borrow_mut(|r| r.push(Box::new(take)));
}

/// Whether anything listens to the microphone.
pub fn recording() -> bool {
    RECORDERS.with_borrow(|r| !r.is_empty())
}

/// The microphone's next block.
pub fn capture(block: &[f32]) {
    let mut recorders = RECORDERS.take();
    recorders.retain_mut(|take| take(block));
    RECORDERS.with_borrow_mut(|r| recorders.append(r));
    RECORDERS.set(recorders);
}

/// Plays `fill`'s blocks (interleaved stereo at [`RATE`], zeroed before each call) until it returns false.
pub fn play(fill: impl FnMut(&mut [f32]) -> bool + 'static) {
    PLAYERS.with_borrow_mut(|p| p.push(Box::new(fill)));
}

/// Whether anything plays.
pub fn playing() -> bool {
    PLAYERS.with_borrow(|p| !p.is_empty())
}

/// The next block: every player's, added up.
pub fn render(out: &mut [f32]) {
    out.fill(0.0);
    // Taken out while they run, so a player may start another.
    let mut players = PLAYERS.take();
    SCRATCH.with_borrow_mut(|buf| {
        buf.resize(out.len(), 0.0);
        players.retain_mut(|fill| {
            buf.fill(0.0);
            let more = fill(buf);
            for (o, s) in out.iter_mut().zip(buf.iter()) {
                *o += s;
            }
            more
        });
    });
    PLAYERS.with_borrow_mut(|p| players.append(p));
    PLAYERS.set(players);
}

pub mod std {
    pub use ::std::*;

    pub mod thread {
        pub use ::std::thread::*;

        /// What [`Builder::spawn`] ran, already finished.
        pub struct JoinHandle<T>(T);

        impl<T> JoinHandle<T> {
            pub fn join(self) -> ::std::thread::Result<T> {
                Ok(self.0)
            }
            pub fn is_finished(&self) -> bool {
                true
            }
        }

        #[derive(Default)]
        pub struct Builder;

        impl Builder {
            pub fn new() -> Self {
                Builder
            }
            pub fn name(self, _name: String) -> Self {
                self
            }
            pub fn stack_size(self, _size: usize) -> Self {
                self
            }
            /// Runs `f` now (see the crate's notes).
            pub fn spawn<F: FnOnce() -> T, T>(self, f: F) -> ::std::io::Result<JoinHandle<T>> {
                Ok(JoinHandle(f()))
            }
        }

        pub fn spawn<F: FnOnce() -> T, T>(f: F) -> JoinHandle<T> {
            JoinHandle(f())
        }
    }
}
