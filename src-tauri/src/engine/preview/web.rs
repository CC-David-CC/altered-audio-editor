// SPDX-License-Identifier: GPL-3.0-or-later
//! File preview in Playground's browser build (patches/audition.yaml in github.com/daijro/openplayground): `run` as
//! on the desktop without its threads. The page's audio callback (altered_playground::play) does the decode
//! thread's work, decoding until the ring is full, then the device's (`fill`). Stereo at the page's rate.
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};

use rtrb::RingBuffer;

use super::{file_fill, fill, Fill, Input, Shared, BUFFER_SECONDS};

pub(super) fn run(input: Input, shared: Arc<Shared>, ready: mpsc::Sender<Result<u32, String>>) {
    let rate = altered_playground::RATE;
    let channels = altered_playground::CHANNELS;
    let source: Result<Fill, String> = match input {
        Input::File(path, start) => file_fill(&path, start, channels, rate),
        Input::Made(make) => make(channels, rate),
    };
    let mut source = match source {
        Ok(s) => s,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let capacity = ((f64::from(rate) * BUFFER_SECONDS) as usize).max(4096) * channels;
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(capacity);
    let mut block: Vec<f32> = Vec::with_capacity(8192);
    let mut at = 0;
    altered_playground::play(move |out: &mut [f32]| {
        if shared.stop.load(Ordering::SeqCst) || shared.finished.load(Ordering::SeqCst) {
            return false;
        }
        // The decode thread's turn: whole blocks while they fit.
        while !shared.decoded_all.load(Ordering::SeqCst) {
            if at == block.len() {
                block.clear();
                at = 0;
                if !source(&mut block) {
                    shared.decoded_all.store(true, Ordering::SeqCst);
                    break;
                }
            }
            let (_, left) = producer.push_partial_slice(&block[at..]);
            at = block.len() - left.len();
            if at < block.len() {
                break;
            }
        }
        fill(out, &mut consumer, &shared, channels);
        true
    });
    let _ = ready.send(Ok(rate));
}
