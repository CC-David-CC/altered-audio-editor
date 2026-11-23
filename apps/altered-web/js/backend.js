// SPDX-License-Identifier: GPL-3.0-or-later
// Altered Audio Editor in Playground (patches/audition.yaml in github.com/daijro/openplayground): the back end, a
// WASI module (apps/altered-web/src/lib.rs), started on the page's files (wasi.js). `call` runs one command at once.
import { Files, WasiExit, wasi } from './wasi.js'

export const files = new Files()

/** Starts the back end from the module (compiled, its bytes or a fetch Response); `host(what, payload)` gets its events. */
export async function start(source, host) {
  const { imports, setMemory } = wasi(files)
  const decoder = new TextDecoder()
  let exports
  const text = (ptr, len) => decoder.decode(new Uint8Array(exports.memory.buffer, ptr, len).slice())
  const env = {
    wasi_snapshot_preview1: imports,
    playground: {
      host: (w, wl, j, jl) => host(text(w, wl), JSON.parse(text(j, jl) || 'null')),
    },
  }
  source = await source
  const instance =
    source instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(source, env)
      : (source instanceof Response ? await WebAssembly.instantiateStreaming(source, env) : await WebAssembly.instantiate(source, env)).instance
  exports = instance.exports
  setMemory(exports.memory)
  exports._initialize?.()
  exports.pg_start()
  return new Backend(exports)
}

class Backend {
  constructor(exports) {
    this.x = exports
    this.encoder = new TextEncoder()
    this.decoder = new TextDecoder()
  }
  /** `bytes` in the module's memory for `f(ptr, len)`. */
  with(bytes, f) {
    const ptr = this.x.pg_alloc(bytes.length)
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes)
    try {
      return f(ptr, bytes.length)
    } finally {
      this.x.pg_free(ptr, bytes.length)
    }
  }
  reply() {
    return new Uint8Array(this.x.memory.buffer, this.x.pg_reply_ptr(), this.x.pg_reply_len()).slice()
  }
  /** One command (its arguments as an object or JSON): { ok, value } (JSON, or an ArrayBuffer for bytes) or
   * { ok: false, error }; null if unknown. */
  call(cmd, args) {
    const c = this.encoder.encode(cmd)
    const a = this.encoder.encode(typeof args === 'string' ? args : JSON.stringify(args ?? {}))
    let tag
    try {
      tag = this.with(c, (cp, cl) => this.with(a, (ap, al) => this.x.pg_invoke(cp, cl, ap, al)))
    } catch (e) {
      if (e instanceof WasiExit) throw e
      // A panic (or any trap) leaves the module unusable: say so rather than carry on with half-done state.
      throw new Error(`${cmd} crashed: ${e.message}`, { cause: e })
    }
    const bytes = this.reply()
    if (tag === 3) return null
    if (tag === 1) return { ok: true, value: bytes.buffer }
    const value = bytes.length ? JSON.parse(this.decoder.decode(bytes)) : null
    return tag === 0 ? { ok: true, value } : { ok: false, error: value }
  }
  /** The file dialog the last call asked for, or null. */
  question() {
    return this.x.pg_question() ? JSON.parse(this.decoder.decode(this.reply())) : null
  }
  answer(paths) {
    this.with(this.encoder.encode(JSON.stringify(paths)), (p, l) => this.x.pg_answer(p, l))
  }
  forgetAnswers() {
    this.x.pg_forget_answers()
  }
  playing() {
    return !!this.x.pg_playing()
  }
  recording() {
    return !!this.x.pg_recording()
  }
  /** Hands the back end a block of the microphone: `fill(view)` writes `frames` interleaved stereo frames. */
  capture(frames, fill) {
    const ptr = this.x.pg_capture(frames)
    fill(new Float32Array(this.x.memory.buffer, ptr, frames * 2))
    this.x.pg_captured()
  }
  /** The next `frames` of audio, interleaved stereo (a view into the module's memory: copy it out at once). */
  render(frames) {
    const ptr = this.x.pg_render(frames)
    return new Float32Array(this.x.memory.buffer, ptr, frames * 2)
  }
}
