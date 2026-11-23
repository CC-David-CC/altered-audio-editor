// SPDX-License-Identifier: GPL-3.0-or-later
// Altered Audio Editor in Playground (patches/audition.yaml in github.com/daijro/openplayground): the WASI calls its
// back end makes (wasm32-wasip1), on an in-memory file system. `/` is Playground's Files: what Files holds is listed
// at start as stubs (path and kind, no bytes), and a stub's bytes come in when the back end needs them (files.js
// loads them and runs the call again). What the back end writes, creates or removes is noted for files.js to mirror.

const E = { SUCCESS: 0, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55 }
const FILETYPE = { CHAR: 2, DIR: 3, FILE: 4 }
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 }
const FDFLAGS_APPEND = 1
const RIGHT_WRITE = 1n << 6n

export class WasiExit extends Error {
  constructor(code) {
    super(`exit ${code}`)
    this.code = code
  }
}

/** '/a/./b/../c/' -> '/a/c' */
export const normalize = (path) => {
  const out = []
  for (const part of String(path).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}
const parentOf = (p) => (p === '/' ? '/' : normalize(p.slice(0, p.lastIndexOf('/')) || '/'))
const now = () => BigInt(Date.now()) * 1000000n

/** The files: path -> { dir: true } or { data, size, mtime, stub } (a stub's bytes aren't loaded yet). */
export class Files {
  constructor() {
    this.entries = new Map([['/', { dir: true, mtime: now() }]])
    /** Paths written, created or removed since the last takeChanges(). */
    this.changed = new Set()
    /** Stubs the back end tried to read since the last takeNeeded(). */
    this.needed = new Set()
  }
  get(path) {
    return this.entries.get(normalize(path))
  }
  mkdirs(path, note = true) {
    path = normalize(path)
    if (this.entries.get(path)?.dir) return
    if (path !== '/') this.mkdirs(parentOf(path), note)
    this.entries.set(path, { dir: true, mtime: now() })
    if (note) this.changed.add(path)
  }
  /** Puts bytes at `path` (from Files, a drop, a picked file): no change is noted unless `note`. */
  put(path, bytes, note = false) {
    path = normalize(path)
    this.mkdirs(parentOf(path), note)
    this.entries.set(path, { data: bytes, size: bytes.length, mtime: now() })
    if (note) this.changed.add(path)
  }
  /** A file Files has, bytes not loaded. */
  stub(path) {
    path = normalize(path)
    if (this.entries.has(path)) return
    this.mkdirs(parentOf(path), false)
    this.entries.set(path, { data: new Uint8Array(0), size: 0, mtime: now(), stub: true })
  }
  bytes(path) {
    const e = this.get(path)
    return e && !e.dir && !e.stub ? e.data.subarray(0, e.size) : null
  }
  remove(path, note = true) {
    path = normalize(path)
    for (const p of [...this.entries.keys()]) {
      if (p === path || p.startsWith(path + '/')) {
        this.entries.delete(p)
        if (note) this.changed.add(p)
      }
    }
  }
  children(dir) {
    dir = normalize(dir)
    const prefix = dir === '/' ? '/' : dir + '/'
    const out = []
    for (const p of this.entries.keys()) {
      if (p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push(p.slice(prefix.length))
    }
    return out.sort()
  }
  takeChanges() {
    const c = [...this.changed]
    this.changed.clear()
    return c
  }
  takeNeeded() {
    const n = [...this.needed]
    this.needed.clear()
    return n
  }
}

/** The wasi_snapshot_preview1 imports, for `files`; call setMemory once the module is instantiated. */
export function wasi(files) {
  let memory
  const view = () => new DataView(memory.buffer)
  const bytesAt = (ptr, len) => new Uint8Array(memory.buffer, ptr, len)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const str = (ptr, len) => decoder.decode(bytesAt(ptr, len).slice())
  // fd 0-2 are the console, 3 the preopened `/`.
  const fds = new Map([
    [0, { stdio: true }],
    [1, { stdio: true, out: console.log, line: '' }],
    [2, { stdio: true, out: console.warn, line: '' }],
    [3, { path: '/', dir: true }],
  ])
  let nextFd = 4
  const resolve = (dirfd, ptr, len) => {
    const base = fds.get(dirfd)
    if (!base?.dir) return null
    return normalize(`${base.path}/${str(ptr, len)}`)
  }
  const iovecs = (iovs, n) => {
    const v = view()
    const out = []
    for (let i = 0; i < n; i++) out.push([v.getUint32(iovs + i * 8, true), v.getUint32(iovs + i * 8 + 4, true)])
    return out
  }
  const writeStat = (ptr, e) => {
    const v = view()
    for (let i = 0; i < 64; i += 8) v.setBigUint64(ptr + i, 0n, true)
    v.setUint8(ptr + 16, e.dir ? FILETYPE.DIR : FILETYPE.FILE)
    v.setBigUint64(ptr + 24, 1n, true)
    v.setBigUint64(ptr + 32, BigInt(e.dir ? 0 : e.size), true)
    v.setBigUint64(ptr + 40, e.mtime, true)
    v.setBigUint64(ptr + 48, e.mtime, true)
    v.setBigUint64(ptr + 56, e.mtime, true)
  }
  const grow = (e, need) => {
    if (need <= e.data.length) return
    const next = new Uint8Array(Math.max(need, e.data.length * 2, 4096))
    next.set(e.data.subarray(0, e.size))
    e.data = next
  }

  const imports = {
    args_get: () => E.SUCCESS,
    args_sizes_get(argc, bufsize) {
      view().setUint32(argc, 0, true)
      view().setUint32(bufsize, 0, true)
      return E.SUCCESS
    },
    environ_get: () => E.SUCCESS,
    environ_sizes_get(count, bufsize) {
      view().setUint32(count, 0, true)
      view().setUint32(bufsize, 0, true)
      return E.SUCCESS
    },
    clock_res_get(id, ptr) {
      view().setBigUint64(ptr, 1000n, true)
      return E.SUCCESS
    },
    clock_time_get(id, _precision, ptr) {
      const t = id === 0 ? now() : BigInt(Math.round(performance.now() * 1e6))
      view().setBigUint64(ptr, t, true)
      return E.SUCCESS
    },
    random_get(ptr, len) {
      for (let at = 0; at < len; at += 65536) crypto.getRandomValues(bytesAt(ptr + at, Math.min(65536, len - at)))
      return E.SUCCESS
    },
    fd_close(fd) {
      if (!fds.has(fd)) return E.BADF
      if (fd > 3) fds.delete(fd)
      return E.SUCCESS
    },
    fd_fdstat_get(fd, ptr) {
      const f = fds.get(fd)
      if (!f) return E.BADF
      const v = view()
      v.setUint8(ptr, f.stdio ? FILETYPE.CHAR : f.dir ? FILETYPE.DIR : FILETYPE.FILE)
      v.setUint16(ptr + 2, f.append ? FDFLAGS_APPEND : 0, true)
      v.setBigUint64(ptr + 8, 0xffffffffffffffffn, true)
      v.setBigUint64(ptr + 16, 0xffffffffffffffffn, true)
      return E.SUCCESS
    },
    fd_fdstat_set_flags: () => E.SUCCESS,
    fd_filestat_get(fd, ptr) {
      const f = fds.get(fd)
      if (!f) return E.BADF
      if (f.stdio) {
        writeStat(ptr, { size: 0, mtime: 0n })
        view().setUint8(ptr + 16, FILETYPE.CHAR)
        return E.SUCCESS
      }
      const e = files.get(f.path)
      if (!e) return E.NOENT
      writeStat(ptr, e)
      return E.SUCCESS
    },
    fd_filestat_set_size(fd, size) {
      const f = fds.get(fd)
      const e = f && files.get(f.path)
      if (!e || e.dir) return E.BADF
      size = Number(size)
      grow(e, size)
      if (size > e.size) e.data.fill(0, e.size, size)
      e.size = size
      files.changed.add(f.path)
      return E.SUCCESS
    },
    fd_filestat_set_times: () => E.SUCCESS,
    fd_prestat_get(fd, ptr) {
      if (fd !== 3) return E.BADF
      view().setUint8(ptr, 0)
      view().setUint32(ptr + 4, 1, true)
      return E.SUCCESS
    },
    fd_prestat_dir_name(fd, ptr, len) {
      if (fd !== 3) return E.BADF
      bytesAt(ptr, len).set(encoder.encode('/').subarray(0, len))
      return E.SUCCESS
    },
    fd_read(fd, iovs, n, nread) {
      const f = fds.get(fd)
      if (!f) return E.BADF
      if (f.stdio) {
        view().setUint32(nread, 0, true)
        return E.SUCCESS
      }
      const e = files.get(f.path)
      if (!e || e.dir) return e ? E.ISDIR : E.BADF
      let total = 0
      for (const [buf, len] of iovecs(iovs, n)) {
        const pos = Number(f.pos)
        const k = Math.max(0, Math.min(len, e.size - pos))
        bytesAt(buf, k).set(e.data.subarray(pos, pos + k))
        f.pos += BigInt(k)
        total += k
        if (k < len) break
      }
      view().setUint32(nread, total, true)
      return E.SUCCESS
    },
    fd_pread(fd, iovs, n, offset, nread) {
      const f = fds.get(fd)
      if (!f || f.stdio) return E.BADF
      const keep = f.pos
      f.pos = offset
      const r = imports.fd_read(fd, iovs, n, nread)
      f.pos = keep
      return r
    },
    fd_write(fd, iovs, n, nwritten) {
      const f = fds.get(fd)
      if (!f) return E.BADF
      let total = 0
      if (f.stdio) {
        for (const [buf, len] of iovecs(iovs, n)) {
          f.line += decoder.decode(bytesAt(buf, len).slice(), { stream: true })
          total += len
        }
        const lines = f.line.split('\n')
        f.line = lines.pop()
        for (const l of lines) f.out?.(l)
        view().setUint32(nwritten, total, true)
        return E.SUCCESS
      }
      const e = files.get(f.path)
      if (!e || e.dir) return E.BADF
      if (f.append) f.pos = BigInt(e.size)
      for (const [buf, len] of iovecs(iovs, n)) {
        const pos = Number(f.pos)
        grow(e, pos + len)
        e.data.set(bytesAt(buf, len), pos)
        if (pos > e.size) e.data.fill(0, e.size, pos)
        e.size = Math.max(e.size, pos + len)
        f.pos += BigInt(len)
        total += len
      }
      e.mtime = now()
      files.changed.add(f.path)
      view().setUint32(nwritten, total, true)
      return E.SUCCESS
    },
    fd_pwrite(fd, iovs, n, offset, nwritten) {
      const f = fds.get(fd)
      if (!f || f.stdio) return E.BADF
      const keep = f.pos
      const append = f.append
      f.pos = offset
      f.append = false
      const r = imports.fd_write(fd, iovs, n, nwritten)
      f.pos = keep
      f.append = append
      return r
    },
    fd_seek(fd, offset, whence, ptr) {
      const f = fds.get(fd)
      if (!f || f.stdio || f.dir) return E.BADF
      const e = files.get(f.path)
      const base = whence === 0 ? 0n : whence === 1 ? f.pos : BigInt(e?.size ?? 0)
      const pos = base + offset
      if (pos < 0n) return E.INVAL
      f.pos = pos
      view().setBigUint64(ptr, pos, true)
      return E.SUCCESS
    },
    fd_tell(fd, ptr) {
      const f = fds.get(fd)
      if (!f || f.stdio) return E.BADF
      view().setBigUint64(ptr, f.pos, true)
      return E.SUCCESS
    },
    fd_sync: () => E.SUCCESS,
    fd_datasync: () => E.SUCCESS,
    fd_advise: () => E.SUCCESS,
    fd_allocate: () => E.SUCCESS,
    fd_readdir(fd, buf, len, cookie, used) {
      const f = fds.get(fd)
      if (!f?.dir) return E.BADF
      const names = files.children(f.path)
      let at = 0
      const v = view()
      for (let i = Number(cookie); i < names.length && at < len; i++) {
        const name = encoder.encode(names[i])
        const e = files.get(`${f.path}/${names[i]}`)
        const head = new DataView(new ArrayBuffer(24))
        head.setBigUint64(0, BigInt(i + 1), true)
        head.setBigUint64(8, BigInt(i + 1), true)
        head.setUint32(16, name.length, true)
        head.setUint8(20, e?.dir ? FILETYPE.DIR : FILETYPE.FILE)
        const entry = new Uint8Array(24 + name.length)
        entry.set(new Uint8Array(head.buffer))
        entry.set(name, 24)
        const k = Math.min(entry.length, len - at)
        bytesAt(buf + at, k).set(entry.subarray(0, k))
        at += k
      }
      v.setUint32(used, at, true)
      return E.SUCCESS
    },
    path_create_directory(fd, ptr, len) {
      const path = resolve(fd, ptr, len)
      if (!path) return E.BADF
      if (files.get(path)) return E.EXIST
      if (!files.get(parentOf(path))?.dir) return E.NOENT
      files.mkdirs(path)
      return E.SUCCESS
    },
    path_filestat_get(fd, _flags, ptr, len, out) {
      const path = resolve(fd, ptr, len)
      if (!path) return E.BADF
      const e = files.get(path)
      if (!e) return E.NOENT
      writeStat(out, e)
      return E.SUCCESS
    },
    path_filestat_set_times: () => E.SUCCESS,
    path_open(dirfd, _dirflags, ptr, len, oflags, rights, _inheriting, fdflags, out) {
      const path = resolve(dirfd, ptr, len)
      if (!path) return E.BADF
      let e = files.get(path)
      if (e && oflags & OFLAGS.EXCL && oflags & OFLAGS.CREAT) return E.EXIST
      if (!e) {
        if (!(oflags & OFLAGS.CREAT)) return E.NOENT
        if (!files.get(parentOf(path))?.dir) return E.NOENT
        files.put(path, new Uint8Array(0), true)
        e = files.get(path)
      }
      if (oflags & OFLAGS.DIRECTORY && !e.dir) return E.NOTDIR
      if (e.stub) {
        if (oflags & OFLAGS.TRUNC) {
          files.put(path, new Uint8Array(0), true)
          e = files.get(path)
        } else {
          files.needed.add(path)
          return E.IO
        }
      }
      if (!e.dir && oflags & OFLAGS.TRUNC) {
        e.size = 0
        e.mtime = now()
        files.changed.add(path)
      }
      const fd = nextFd++
      fds.set(fd, { path, dir: !!e.dir, pos: 0n, append: !!(fdflags & FDFLAGS_APPEND), write: !!(rights & RIGHT_WRITE) })
      view().setUint32(out, fd, true)
      return E.SUCCESS
    },
    path_readlink: () => E.INVAL,
    path_symlink: () => E.NOSYS,
    path_link: () => E.NOSYS,
    path_remove_directory(fd, ptr, len) {
      const path = resolve(fd, ptr, len)
      if (!path) return E.BADF
      const e = files.get(path)
      if (!e) return E.NOENT
      if (!e.dir) return E.NOTDIR
      if (files.children(path).length) return E.NOTEMPTY
      files.remove(path)
      return E.SUCCESS
    },
    path_unlink_file(fd, ptr, len) {
      const path = resolve(fd, ptr, len)
      if (!path) return E.BADF
      const e = files.get(path)
      if (!e) return E.NOENT
      if (e.dir) return E.ISDIR
      files.remove(path)
      return E.SUCCESS
    },
    path_rename(fd, ptr, len, fd2, ptr2, len2) {
      const from = resolve(fd, ptr, len)
      const to = resolve(fd2, ptr2, len2)
      if (!from || !to) return E.BADF
      const e = files.get(from)
      if (!e) return E.NOENT
      if (!files.get(parentOf(to))?.dir) return E.NOENT
      const moved = [...files.entries].filter(([p]) => p === from || p.startsWith(from + '/'))
      files.remove(to)
      files.remove(from)
      for (const [p, entry] of moved) {
        const q = to + p.slice(from.length)
        files.entries.set(q, entry)
        files.changed.add(q)
      }
      for (const f of fds.values()) {
        if (f.path === from || f.path?.startsWith(from + '/')) f.path = to + f.path.slice(from.length)
      }
      return E.SUCCESS
    },
    // Sleeps end at once: the page can't wait (the players don't sleep here; see altered-playground).
    poll_oneoff(subs, events, n, nevents) {
      const v = view()
      for (let i = 0; i < n; i++) {
        const s = subs + i * 48
        const ev = events + i * 32
        v.setBigUint64(ev, v.getBigUint64(s, true), true)
        v.setUint16(ev + 8, 0, true)
        v.setUint8(ev + 10, v.getUint8(s + 8))
      }
      v.setUint32(nevents, n, true)
      return E.SUCCESS
    },
    proc_exit(code) {
      throw new WasiExit(code)
    },
    proc_raise: () => E.NOSYS,
    sched_yield: () => E.SUCCESS,
    sock_accept: () => E.NOSYS,
    sock_recv: () => E.NOSYS,
    sock_send: () => E.NOSYS,
    sock_shutdown: () => E.NOSYS,
  }
  return { imports, setMemory: (m) => (memory = m) }
}
