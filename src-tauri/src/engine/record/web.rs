// SPDX-License-Identifier: GPL-3.0-or-later
//! Recording in Playground's browser build (patches/audition.yaml in github.com/daijro/openplayground): `run` as on
//! the desktop without its thread. The page's microphone is the one input (stereo at the page's rate); each block
//! it hands over (altered_playground::record) goes through what the desktop's disk thread does: the takes' files, the
//! meters and live waveforms, and input monitoring. Takes are finished when recording stops ([`finish`]).
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};

use rtrb::RingBuffer;

use super::{LiveTap, MonitorMix, RecordTarget, Shared, Take, TakeWriter, MONITOR_MAX_QUEUE};

thread_local! {
    /// The takes being written, finished by [`finish`].
    static WRITERS: RefCell<Vec<std::rc::Rc<RefCell<Option<TakeWriter>>>>> = RefCell::default();
}

pub(super) fn run(
    _device: Option<String>,
    targets: Vec<(RecordTarget, Vec<usize>)>,
    dir: Option<PathBuf>,
    shared: Arc<Shared>,
    first: bool,
    ready: mpsc::Sender<Result<(), String>>,
) -> Result<Vec<Take>, String> {
    let rate = altered_playground::RATE;
    let channels = altered_playground::CHANNELS;
    let writer = match dir {
        Some(d) => match TakeWriter::create(&d, &targets, rate, channels) {
            Ok(w) => Some(w),
            Err(e) => {
                let e = format!("Could not create the recording file: {e}");
                let _ = ready.send(Err(e.clone()));
                return Err(e);
            }
        },
        None => None,
    };
    let writer = std::rc::Rc::new(RefCell::new(writer));
    WRITERS.with_borrow_mut(|w| w.push(writer.clone()));
    if first {
        shared.rate.store(rate, Ordering::Relaxed);
    }
    let mut tap = LiveTap::new(&targets, channels);

    // Input monitoring: the monitored targets' mix through the page's audio.
    let mut mix = MonitorMix::new(&targets, channels, rate);
    let mut monitor = mix.as_ref().map(|_| {
        let (p, mut c) = RingBuffer::<f32>::new(rate as usize * 2);
        let s = shared.clone();
        altered_playground::play(move |out: &mut [f32]| {
            for v in out.iter_mut() {
                *v = c.pop().unwrap_or(0.0);
            }
            !s.stop.load(Ordering::SeqCst)
        });
        p
    });
    let max_queue = (MONITOR_MAX_QUEUE * f64::from(rate)) as usize * 2;
    let mut mixed: Vec<f32> = Vec::new();

    altered_playground::record(move |block: &[f32]| {
        if shared.stop.load(Ordering::SeqCst) {
            return false;
        }
        let peak = block.iter().fold(0f32, |m, v| m.max(v.abs()));
        shared.peak.fetch_max(peak.to_bits(), Ordering::Relaxed);
        if let Some(w) = writer.borrow_mut().as_mut() {
            if w.push(block).is_err() {
                shared.overruns.fetch_add(1, Ordering::Relaxed);
            }
            if first {
                shared.frames.fetch_add((block.len() / channels) as u64, Ordering::Relaxed);
            }
        }
        if let Ok(mut live) = shared.live.lock() {
            tap.push(block, &mut live);
        }
        if let (Some(m), Some(p)) = (mix.as_mut(), monitor.as_mut()) {
            mixed.clear();
            m.mix(block, &mut mixed);
            let queued = p.buffer().capacity() - p.slots();
            if queued + mixed.len() <= max_queue.max(mixed.len()) {
                for &v in &mixed {
                    if p.push(v).is_err() {
                        break;
                    }
                }
            }
        }
        true
    });
    let _ = ready.send(Ok(()));
    Ok(Vec::new())
}

/// Finishes the takes of the recording just stopped (the desktop's threads give them back when joined).
pub(super) fn finish(takes: &mut Vec<Take>, first_err: &mut Option<String>) {
    for w in WRITERS.take() {
        match w.borrow_mut().take().map(TakeWriter::finish) {
            Some(Ok(t)) => takes.extend(t),
            Some(Err(e)) => *first_err = first_err.take().or(Some(e)),
            None => {}
        }
    }
}
