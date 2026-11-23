// SPDX-License-Identifier: GPL-3.0-or-later
// Playground's browser build of Altered Audio Editor (patches/audition.yaml in github.com/daijro/openplayground):
// upstream's Vite config, with @tauri-apps/api's modules taken from js/ (the back end runs on the page).
import { fileURLToPath } from 'node:url'
import { mergeConfig } from 'vite'
import upstream from '../../vite.config.ts'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))

export default mergeConfig(upstream, {
  root: here('../..'),
  base: './',
  resolve: {
    alias: ['core', 'event', 'webview', 'window'].map((m) => ({ find: `@tauri-apps/api/${m}`, replacement: here(`js/tauri-${m}.js`) })),
  },
  build: { minify: true, sourcemap: false, assetsInlineLimit: 0 },
})
