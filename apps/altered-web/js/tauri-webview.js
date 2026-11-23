// SPDX-License-Identifier: GPL-3.0-or-later
// @tauri-apps/api/webview for Playground's browser build of Altered Audio Editor (patches/audition.yaml in
// github.com/daijro/openplayground): files dropped from the computer (kept in Files, playground.js), and
// files Playground opens in the app, as the window's drag-and-drop events. Positions are in device pixels, as
// Tauri gives them.
import { dropped, whenOpened } from './playground.js'

const at = (e) => ({ x: e.clientX * devicePixelRatio, y: e.clientY * devicePixelRatio })
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files')

const webview = {
  size: async () => ({ width: Math.round(innerWidth * devicePixelRatio), height: Math.round(innerHeight * devicePixelRatio) }),
  async onDragDropEvent(handler) {
    const send = (payload) => handler({ event: 'tauri://drag-drop', id: 0, payload })
    let depth = 0
    const enter = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (depth++ === 0) send({ type: 'enter', paths: [], position: at(e) })
    }
    const over = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      send({ type: 'over', position: at(e) })
    }
    const leave = (e) => {
      if (!hasFiles(e)) return
      if (--depth <= 0) {
        depth = 0
        send({ type: 'leave' })
      }
    }
    const drop = async (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      const position = at(e)
      const paths = await dropped([...e.dataTransfer.files])
      send({ type: 'drop', paths, position })
    }
    addEventListener('dragenter', enter)
    addEventListener('dragover', over)
    addEventListener('dragleave', leave)
    addEventListener('drop', drop)
    // Outside every panel, so the app opens sessions and imports audio as it does for files dropped anywhere.
    whenOpened((paths) => {
      send({ type: 'enter', paths, position: { x: -1, y: -1 } })
      send({ type: 'drop', paths, position: { x: -1, y: -1 } })
    })
    return () => {
      removeEventListener('dragenter', enter)
      removeEventListener('dragover', over)
      removeEventListener('dragleave', leave)
      removeEventListener('drop', drop)
      whenOpened(null)
    }
  },
}

export const getCurrentWebview = () => webview
