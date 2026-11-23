// SPDX-License-Identifier: GPL-3.0-or-later
// @tauri-apps/api/core for Playground's browser build of Altered Audio Editor (patches/audition.yaml in
// github.com/daijro/openplayground): commands go to the back end on this page (playground.js).
export { invoke } from './playground.js'

/** The app runs as on the desktop, with this page as its window. */
export const isTauri = () => true
