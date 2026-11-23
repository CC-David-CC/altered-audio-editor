# Retake in WebOS

Retake is based on Altered Audio Editor by The GeekCast Radio Network. The browser build uses upstream revision `b486f32dc2c7cc513d60aef183d315f76e551bc7`, and OpenPlayground's Retake port at `4317d6b7ec991926713fd1af1bc715c42c0e8a55`. It uses the Retake name and artwork. The original project's licensing and trademark notices are in `LICENSE` and `TRADEMARKS.md`.

Build on Linux x86-64 using Rust 1.99.1 and Node.js 24. The build script verifies the official wasi-sdk 34 archive and builds the Rust backend from `apps/altered-web/Cargo.lock`. It builds the Svelte interface from `package-lock.json`.

```sh
bash scripts/build-web.sh /path/to/retake-browser
```

Package the browser output under `native/`, `web/mount.mjs` as `index.mjs` and `web/workspace.css` beside it. Include the applicable dependency notices and the exact corresponding source link with the distributable WASI module.

The browser engine runs in a WASI worker and uses an AudioWorklet for playback. Open and Save use My files. A session keeps its editable `.altaudio` document and its media paths. Keep its media folder with it. Dropped files are imported into Retake Imports. Save As can preserve edits in a separate file when the original revision changes.
