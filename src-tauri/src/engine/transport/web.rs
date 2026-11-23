// SPDX-License-Identifier: GPL-3.0-or-later
//! Multitrack playback in Playground's browser build (patches/audition.yaml in github.com/daijro/openplayground):
//! `run` as on the desktop without its threads. It sets up the mix as the desktop's does and returns; the page's
//! audio callback (altered_playground::play) does the render thread's work, rendering until the rings are full,
//! then the device's, mixing from them (`mix`). Stereo at the page's rate; a 3D Space session plays its stereo mix.
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};

use rtrb::RingBuffer;

use super::{has_room, mix, render_block, Jump, Routing, Shared, Ticker, AHEAD_SECONDS, BLOCK};
use crate::engine::graph::{Graph, Mix};
use crate::engine::metronome::Click;
use crate::engine::plan;
use crate::engine::render::Renderer;
use crate::session::model::Session;

pub(super) fn run(
    mut session: Session,
    from: u64,
    jump: Option<Jump>,
    shared: Arc<Shared>,
    ready: mpsc::Sender<Result<u32, String>>,
) {
    let out_rate = altered_playground::RATE;
    let channels = altered_playground::CHANNELS;
    crate::engine::scope::set_rate(out_rate);
    if session.tracks.is_empty() {
        // Keep the clock running with one silent track.
        session.tracks.push(crate::session::model::Track::new(
            "",
            crate::session::model::ChannelLayout::Stereo,
        ));
    }
    let routed = crate::session::routing::is_routed(&session);
    let start_frame = plan::to_out(from, session.sample_rate, out_rate);
    let mut renderer = Renderer::new(plan::build(&session, out_rate), start_frame);
    if let Some((at, to)) = jump.and_then(|j| j.points(from)) {
        let r = session.sample_rate;
        renderer = renderer.with_jump(plan::to_out(at, r, out_rate), plan::to_out(to, r, out_rate));
    }
    let mut mix_ = Mix::new(renderer, Graph::new(&session, out_rate, routed));
    let rings = mix_.outputs();
    let r = session.sample_rate;
    let mut click = Ticker {
        click: Click::new(&session.tempo, out_rate),
        start: start_frame,
        jump: jump.map(|j| match j {
            Jump::Loop { start, end } => Jump::Loop { start: plan::to_out(start, r, out_rate), end: plan::to_out(end, r, out_rate) },
            Jump::Skip { start, end } => Jump::Skip { start: plan::to_out(start, r, out_rate), end: plan::to_out(end, r, out_rate) },
        }),
        buf: Vec::with_capacity(BLOCK * 2),
    };

    let cap = ((f64::from(out_rate) * AHEAD_SECONDS) as usize).max(BLOCK * 2) * 2;
    let (mut producers, mut consumers): (Vec<_>, Vec<_>) = (0..rings).map(|_| RingBuffer::<f32>::new(cap)).unzip();
    let (mut click_out, mut click_in) = RingBuffer::<f32>::new(cap);
    let mut routing = Routing { stereo: [0, 1], bed: None, frame: Vec::new() };
    let mut blocks: Vec<Vec<f32>> = vec![Vec::with_capacity(BLOCK * 2); rings];
    let mut gains = vec![[0f32; 2]; rings];
    let mut peaks = vec![[0f32; 2]; rings];

    altered_playground::play(move |out: &mut [f32]| {
        if shared.stop.load(Ordering::SeqCst) {
            return false;
        }
        if let Some(update) = shared.take_chains() {
            mix_.set_chains(&update);
        }
        if let Some(levels) = shared.take_levels() {
            mix_.graph().set_levels(levels);
        }
        while has_room(&producers, &click_out, None, 0) {
            render_block(&mut mix_, &mut blocks, &mut producers, &mut click, &mut click_out, None);
            shared.push_meters(&mut mix_);
        }
        mix(out, channels, &mut consumers, &mut click_in, &shared, &mut gains, &mut peaks, &mut routing);
        true
    });
    let _ = ready.send(Ok(out_rate));
}
