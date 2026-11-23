// SPDX-License-Identifier: GPL-3.0-or-later
// @tauri-apps/api/event for Playground's browser build of Altered Audio Editor (patches/audition.yaml in
// github.com/daijro/openplayground): the back end's events (playground.js).
import { dispatch, on } from './playground.js'

export const listen = async (event, handler) => on(event, handler)

export const once = async (event, handler) => {
  const off = on(event, (e) => {
    off()
    handler(e)
  })
  return off
}

export const emit = async (event, payload) => dispatch(event, payload)
