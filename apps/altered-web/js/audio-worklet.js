// SPDX-License-Identifier: GPL-3.0-or-later
// Altered Audio Editor in Playground (patches/audition.yaml in github.com/daijro/openplayground): the speakers and the
// microphone, on the audio thread. Blocks come from the back end's worker (worker.js) through the port the page hands
// over, about a tenth of a second ahead; the microphone's go back to it in blocks of 2048 frames. The page wakes it
// ({ wake }) when something starts playing or recording.
const AHEAD = 4096
const MIC = 2048

class Altered extends AudioWorkletProcessor {
  constructor() {
    super()
    this.worker = null
    this.queue = []
    this.at = 0
    this.buffered = 0
    this.asked = false
    this.idle = true
    this.mic = new Float32Array(MIC * 2)
    this.micAt = 0
    this.port.onmessage = ({ data }) => {
      if (data.worker) {
        this.worker = data.worker
        this.worker.onmessage = ({ data }) => this.fromWorker(data)
      }
      if (data.wake) this.idle = false
    }
  }
  fromWorker(data) {
    this.asked = false
    if (data.block) {
      this.queue.push(data.block)
      this.buffered += data.block.length / 2
    }
    if (data.idle) this.idle = true
  }
  process(inputs, outputs) {
    const out = outputs[0]
    const frames = out[0].length
    // The microphone, when it is connected.
    const input = inputs[0]
    if (input?.length && this.worker) {
      const l = input[0]
      const r = input[1] ?? l
      for (let i = 0; i < l.length; i++) {
        this.mic[this.micAt++] = l[i]
        this.mic[this.micAt++] = r[i]
        if (this.micAt === this.mic.length) {
          this.worker.postMessage({ mic: this.mic }, [this.mic.buffer])
          this.mic = new Float32Array(MIC * 2)
          this.micAt = 0
        }
      }
    }
    for (let i = 0; i < frames; i++) {
      const block = this.queue[0]
      if (!block) {
        out[0][i] = 0
        out[1][i] = 0
        continue
      }
      out[0][i] = block[this.at++]
      out[1][i] = block[this.at++]
      this.buffered--
      if (this.at === block.length) {
        this.queue.shift()
        this.at = 0
      }
    }
    if (!this.idle && !this.asked && this.worker && this.buffered < AHEAD) {
      this.asked = true
      this.worker.postMessage({ need: AHEAD - this.buffered })
    }
    return true
  }
}

registerProcessor('altered', Altered)
