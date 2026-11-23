// SPDX-License-Identifier: GPL-3.0-or-later
// @tauri-apps/api/window for Playground's browser build of Altered Audio Editor (patches/audition.yaml in
// github.com/daijro/openplayground). Closing the tab can't wait for the app's questions: Playground's leave warning
// asks instead, while the session has unsaved changes (playground.js).
const window_ = {
  onCloseRequested: async () => () => {},
  setTitle: async (title) => {
    document.title = title
    window.frameElement?.retakeFiles?.setUnsaved(/ \* - /.test(title))
  },
  minimize: async () => {},
}

export const getCurrentWindow = () => window_
