// SPDX-License-Identifier: GPL-3.0-or-later
// Altered Audio Editor in Playground (patches/audition.yaml in github.com/daijro/openplayground): the page's side of
// the back end, which runs in a worker (worker.js). The tauri-*.js modules stand in for @tauri-apps/api and come here.
//
//   Files      `/` in the back end is Playground's Files (globalThis.playgroundFiles): listed at start, a file's bytes
//              loaded when a command reaches for them (the command then runs again), and what a command writes,
//              creates or removes there mirrored back. Files is one flat list, and the app keeps sessions in folders
//              (their media, recordings and exports beside them), so a path's folders go in the name: /Show/Audio/a.wav
//              is "Show › Audio › a.wav" in Files. /.app is the app's own: its settings (/.app/config) are kept in
//              this browser's localStorage, its cache and autosaves only while the page is open. What is saved in
//              /Download to device (Save As > Download to device) is downloaded instead, and never kept in Files.
//   Dialogs    a command's file dialog is Playground's Open or Save As; the command then runs again with the answer
//              (stand-ins/tauri-plugin-dialog). Files from the computer, opened or dropped, are kept in Files, so a
//              session that uses them still finds them next time.
//   Audio      one AudioContext at the back end's rate, whose AudioWorklet (audio-worklet.js) gets its blocks from the
//              worker and gives it the microphone's while something records or meters an armed track (the browser
//              asks for the microphone the first time).

const CONFIG = '/.app/config'
const DOWNLOADS = '/Download to device'
import './workspace-frame.css'

const workspace = window.frameElement?.retakeFiles
const CONFIG_KEY = workspace ? 'retake:config:' + workspace.scope : 'altered-audio-editor:config'
const RATE = 48000

const pg = () => workspace ?? globalThis.playgroundFiles
const normalize = (p) => '/' + String(p).split('/').filter((s) => s && s !== '.').join('/')
const FOLDER = ' › '
/** A Files path (browser:/Show › a.wav) as the back end's (/Show/a.wav), or null for anything else. */
const fromApp = (p) =>
  typeof p === 'string' && p.startsWith('browser:')
    ? normalize(workspace ? p.slice(8) : p.slice(8).split(/\/|\s›\s/).join('/'))
    : null
const toApp = (p) => workspace ? `browser:${p}` : `browser:/${p.slice(1).split('/').join(FOLDER)}`
const baseName = (p) => p.split('/').pop()
const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/'

// Playground's prelude cancels the browser's own Ctrl+key actions (page-prelude.js) and leaves the key to the app, but
// this app's keymap passes over keys something else cancelled (src/keymap/dispatch.ts). Right after the prelude, the
// event says it isn't cancelled until the app cancels it itself; the browser's action stays cancelled.
addEventListener(
  'keydown',
  (e) => {
    if (!e.defaultPrevented) return
    let cancelled = false
    Object.defineProperty(e, 'defaultPrevented', { get: () => cancelled })
    Object.defineProperty(e, 'preventDefault', { value: () => ((cancelled = true), Event.prototype.preventDefault.call(e)) })
  },
  true,
)

// Below Playground's bar (shell.css sets --pg-bar), as the shell places canvas apps.


const listeners = new Map()
/** Events from the back end and the page, as Tauri's `listen` gets them. */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event).add(handler)
  return () => listeners.get(event)?.delete(handler)
}
let eventId = 0
export function dispatch(event, payload) {
  for (const h of listeners.get(event) ?? []) {
    try {
      h({ event, id: ++eventId, payload })
    } catch (e) {
      console.error(e)
    }
  }
}

function host(what, payload) {
  if (what.startsWith('event:')) return dispatch(what.slice(6), payload)
  if (what === 'set-title') {
    document.title = String(payload)
    // "<name> * - <app>" while the session has unsaved changes: Playground's leave warning follows it.
    pg()?.setUnsaved(/ \* - /.test(String(payload)))
  } else if (what === 'open-url') window.open(String(payload), '_blank', 'noopener')
  else if (what === 'exit') {
    if (workspace) workspace.close()
    else location.href = '/'
  } else if (what === 'restart') location.reload()
}

// Paths the back end has (stubs and files), to name new ones without clashes.
const known = new Set()
const loaded = new Set()
const loadingFiles = new Map()
let playbackFiles = []

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
const pending = new Map()
let nextId = 0
let started
const ready = new Promise((resolve, reject) => (started = { resolve, reject }))
worker.onmessage = ({ data }) => {
  if (data.id !== undefined) {
    pending.get(data.id)?.(data)
    pending.delete(data.id)
  } else if (data.host) host(data.host, data.payload)
  else if (data.started) started.resolve()
  else if (data.failed) started.reject(new Error(data.failed))
  else if (data.recording === false) microphone(false)
}
worker.onerror = (e) => started.reject(new Error(`the back end's worker failed: ${e.message}`))
const put = (path, bytes, note = false) => {
  known.add(path)
  loaded.add(path)
  worker.postMessage({ put: true, path, bytes, note })
}

function loadFile(path) {
  if (loaded.has(path)) return Promise.resolve()
  let pending = loadingFiles.get(path)
  if (!pending) {
    pending = Promise.resolve().then(async () => put(path, await pg().read(toApp(path))))
      .finally(() => loadingFiles.delete(path))
    loadingFiles.set(path, pending)
  }
  return pending
}

function updatePlaybackFiles(session) {
  const clips = (session?.tracks ?? []).flatMap((track) => track.clips ?? [])
  const used = new Set(clips.map((clip) => clip.media_id))
  playbackFiles = [...new Set((session?.media ?? [])
    .filter((media) => used.has(media.id) && media.path.startsWith('/'))
    .map((media) => normalize(media.path)))]
}

;(async () => {
  const config = []
  try {
    for (const [path, text] of Object.entries(JSON.parse(localStorage.getItem(CONFIG_KEY) ?? '{}'))) config.push([path, new TextEncoder().encode(text)])
  } catch (e) {
    console.warn('settings could not be restored', e)
  }
  const stubs = []
  for (const p of (await pg()?.files('browser:/')) ?? []) {
    const path = fromApp(p)
    if (path && !path.startsWith('/.app/')) stubs.push(path)
  }
  stubs.forEach((p) => known.add(p))
  // Compiled here, where Playground's loader unpacks the .wasm (page-prelude.js), and run in the worker.
  const module = await WebAssembly.compileStreaming(fetch(new URL('altered.wasm', document.baseURI)))
  worker.postMessage({ start: true, module, stubs, puts: config })
  await ready
  pg()?.onOpen((file) => openFile(file).catch((error) => workspace?.status(error.message)))
  workspace?.ready()
})().catch((e) => {
  console.error('the back end did not start', e)
  started.reject(e)
  workspace?.failed(e.message)
})

/** Mirrors what a command changed: Files, the app's settings and its downloads. */
function mirror(changes, staged) {
  let config = null
  for (const { path, dir, bytes } of changes) {
    if (bytes || dir) known.add(path)
    else known.delete(path)
    if (bytes) loaded.add(path)
    else if (!dir) loaded.delete(path)
    if (path === CONFIG || path.startsWith(CONFIG + '/')) {
      config ??= JSON.parse(localStorage.getItem(CONFIG_KEY) ?? '{}')
      if (bytes) config[path] = new TextDecoder().decode(bytes)
      else if (!dir) delete config[path]
    } else if (path === DOWNLOADS || path.startsWith(DOWNLOADS + '/')) {
      if (!bytes) continue
      pg()?.download(baseName(path), bytes)
      worker.postMessage({ remove: path })
    } else if (path === '/.app' || path.startsWith('/.app/') || dir) continue
    else if (workspace) {
      if (bytes) staged.set(path, bytes)
      else staged.delete(path)
    } else if (bytes) pg()?.write(toApp(path), bytes)
    else pg()?.remove(toApp(path))
  }
  if (config) {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
    } catch (e) {
      console.warn('settings could not be saved', e)
    }
  }
}

/** A free path for `name` in `dir`: "name", else "name (2)"... */
function freePath(dir, name) {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let i = 1; ; i++) {
    const p = normalize(`${dir}/${i === 1 ? name : `${stem} (${i})${ext}`}`)
    if (!known.has(p)) return p
  }
}

/** Keeps a file from the computer in Files; its path there. */
async function keepImported(name, bytes) {
  const path = freePath(workspace ? '/Retake Imports' : '/', name)
  if (workspace) await workspace.commit([{ path: toApp(path), bytes }])
  else pg()?.write(toApp(path), bytes)
  put(path, bytes)
  return path
}

const typesOf = (q) => [...new Set(q.filters.flatMap(([, exts]) => exts).filter((e) => e !== '*').map((e) => e.toLowerCase()))]

/** Shows Playground's dialog for a command's question: the paths it answers, or null when cancelled. */
async function ask(q) {
  const types = typesOf(q)
  if (q.kind === 'open' || q.kind === 'openMany') {
    const picked = await pg()?.open({ types })
    if (!picked?.length) return null
    return Promise.all(picked.map(async (f) => {
      const path = fromApp(f.path)
      if (!path) return keepImported(f.name, f.bytes)
      put(path, f.bytes)
      return path
    }))
  }
  // A folder is named like a file saved where it goes.
  const name = q.fileName ?? (q.kind === 'folder' ? q.title?.replace(/\s+to$/i, '') || 'Folder' : 'Untitled')
  const saved = await pg()?.saveAs({ name, types: q.kind === 'folder' ? [] : types, folder: q.kind === 'folder' })
  if (!saved) return null
  const path = saved.download ? `${DOWNLOADS}/${name}` : fromApp(saved.path)
  // Its folder may be new (made in the dialog, or the downloads).
  worker.postMessage({ put: true, path: q.kind === 'folder' ? path : parentOf(path), dir: true })
  return [path]
}

const send = (msg) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    // As JSON, as Tauri sends them: arguments may be the interface's state proxies, which can't be posted as they are.
    worker.postMessage({ call: true, id, ...msg, args: JSON.stringify(msg.args ?? {}) })
  })

/** Runs a command as Tauri's `invoke` does: its result, or a rejection with its error. */
export async function invoke(cmd, args) {
  await ready
  // Preserve the user gesture for AudioContext before waiting for any file reads.
  if (/^(transport_play|preview_play|wave_play|record_start|record_monitor|midi_audition)$/.test(cmd)) audio(false)
  if (workspace && cmd === 'transport_play') {
    // The worklet can request the first block as soon as the transport starts.
    // Resolve the clip paths before that first frame, even when waveform reads are still running.
    for (const path of playbackFiles) {
      if (known.has(path)) await loadFile(path)
    }
  }
  let answer
  const staged = new Map()
  for (let round = 0; ; round++) {
    const out = await send({ cmd, args, answer })
    answer = undefined
    mirror(out.changes, staged)
    if (out.question) {
      answer = await ask(out.question)
      if (answer) continue
    } else if (out.needed.length && round < 4) {
      // Files it reached for that weren't loaded yet: load them and run it again.
      await Promise.all(out.needed.map(loadFile))
      continue
    }
    const r = out.reply
    if (r === null) throw `Command ${cmd} not found`
    if (r.crashed) console.error(`${cmd} crashed: ${r.error}`)
    if (!r.ok) throw r.error
    if (workspace && staged.size) {
      await workspace.commit(Array.from(staged, ([path, bytes]) => ({ path: toApp(path), bytes })))
    }
    if (workspace && ['session_new','session_open','session_save','session_resume','session_import_sesx'].includes(cmd)) {
      updatePlaybackFiles(r.value?.session)
      workspace.session(r.value?.path ? toApp(r.value.path) : null, cmd)
    }
    if (out.playing) audio(true)
    if (out.recording) microphone(true)
    return r.value
  }
}

let opened = []
let onOpened = null
/** A file for the app from Playground (Open in, ?open=): handed to the app as a drop (tauri-webview.js), once it
 * listens for drops. */
async function openFile({ path, name, bytes }) {
  const at = fromApp(path)
  if (at) put(at, bytes)
  opened.push(at ?? await keepImported(name, bytes))
  if (onOpened) onOpened(opened.splice(0))
}
export function whenOpened(f) {
  onOpened = f
  if (f && opened.length) f(opened.splice(0))
}

/** Files dropped from the computer: kept in Files, then their paths go to the app. */
export async function dropped(list) {
  const paths = []
  for (const f of list) paths.push(await keepImported(f.name, new Uint8Array(await f.arrayBuffer())))
  return paths
}

let ctx = null
let node = null
let audioReady = null
/** The speakers (and the worklet the microphone goes through); `play` wakes the worklet. */
function audio(play) {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' })
    audioReady = ctx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url)).then(() => {
      node = new AudioWorkletNode(ctx, 'altered', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
      node.connect(ctx.destination)
      const channel = new MessageChannel()
      worker.postMessage({ audio: channel.port1 }, [channel.port1])
      node.port.postMessage({ worker: channel.port2 }, [channel.port2])
    })
  }
  if (ctx.state !== 'running') ctx.resume()
  if (play) audioReady.then(() => node.port.postMessage({ wake: true }))
}

let mic = null
/** The microphone into the worklet while the back end records or meters (stereo; a mono microphone on both sides). */
async function microphone(on) {
  if (!on) {
    mic?.source?.disconnect()
    for (const t of mic?.stream?.getTracks() ?? []) t.stop()
    mic = null
    return
  }
  if (mic) return
  mic = {}
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
    })
    audio(false)
    await audioReady
    if (!mic) return stream.getTracks().forEach((t) => t.stop())
    const source = ctx.createMediaStreamSource(stream)
    source.connect(node)
    mic = { stream, source }
  } catch (e) {
    mic = null
    console.warn('no microphone', e)
    alert(`Recording needs the microphone: ${e.message}`)
  }
}

addEventListener('pagehide', () => {
  microphone(false);
  if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
  worker.terminate();
});
