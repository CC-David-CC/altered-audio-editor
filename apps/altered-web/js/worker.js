// SPDX-License-Identifier: GPL-3.0-or-later
// Altered Audio Editor in Playground (patches/audition.yaml in github.com/daijro/openplayground): the back end in a
// worker, so the page stays responsive through long work (an hour's export, an effect on a whole file). Messages:
//
//   from the page                                     back
//   { start, module, stubs, puts }                    { started } once running, or { failed }
//   { call, id, cmd, args, answer? }                  { id, reply, question, needed, changes, playing, recording }
//   { put, path, bytes, note } or { put, path, dir }  files for the back end (picked, dropped, loaded) and folders
//   { remove: path }                                  a file the page has downloaded
//   { audio: port }                                   the AudioWorklet's port (audio-worklet.js), below
//   and the back end's events, as { event, payload }
//
// Audio goes between this worker and the AudioWorklet directly, not through the page: the worklet asks for blocks
// ({ need }) and gets them ({ block }, or { idle } when nothing plays), and sends the microphone's ({ mic }).
import { files, start } from './backend.js'

let be = null
const post = (msg, transfer = []) => postMessage(msg, transfer)

/** What the last call changed in the files, for the page to mirror: each path with its bytes, or null when gone. */
function changes() {
  return files.takeChanges().map((path) => {
    const e = files.get(path)
    return { path, dir: !!e?.dir, bytes: e && !e.dir && !e.stub ? files.bytes(path).slice() : null }
  })
}

function call({ id, cmd, args, answer }) {
  let reply
  try {
    if (answer) be.answer(answer)
    reply = be.call(cmd, args)
  } catch (e) {
    reply = { ok: false, error: String(e.message ?? e), crashed: true }
  }
  const out = { id, reply, question: be.question(), needed: files.takeNeeded(), changes: changes(), playing: be.playing(), recording: be.recording() }
  be.forgetAnswers()
  post(out, [...(reply?.value instanceof ArrayBuffer ? [reply.value] : []), ...out.changes.flatMap((c) => (c.bytes ? [c.bytes.buffer] : []))])
}

const BLOCK = 2048
function audio(port) {
  port.onmessage = ({ data }) => {
    if (!be) return
    if (data.mic) {
      be.capture(data.mic.length / 2, (view) => view.set(data.mic))
      // Nothing listens any more (stopped, or the meters closed): the page lets the microphone go.
      if (!be.recording()) post({ recording: false })
    }
    if (data.need) {
      if (!be.playing()) return port.postMessage({ idle: true, recording: be.recording() })
      for (let n = 0; n < data.need; n += BLOCK) {
        const block = be.render(BLOCK).slice()
        port.postMessage({ block }, [block.buffer])
      }
    }
  }
}

onmessage = async ({ data }) => {
  if (data.start) {
    try {
      for (const p of data.stubs) files.stub(p)
      for (const [p, bytes] of data.puts) files.put(p, bytes)
      be = await start(data.module, (what, payload) => post({ host: what, payload }))
      post({ started: true })
    } catch (e) {
      post({ failed: String(e.message ?? e) })
    }
  } else if (data.call) call(data)
  else if (data.put) data.dir ? files.mkdirs(data.path, false) : files.put(data.path, data.bytes, data.note)
  else if (data.remove) files.remove(data.remove, false)
  else if (data.audio) audio(data.audio)
}
