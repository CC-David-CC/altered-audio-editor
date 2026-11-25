// SPDX-License-Identifier: GPL-3.0-or-later

const revision = /^[a-f0-9]{64}$/;
const invalidName = /[/\\:\u0000-\u001f]/;

function element(tag, properties) {
  return Object.assign(document.createElement(tag), properties);
}

function nameOf(path) {
  return path.split('/').at(-1);
}

function workspacePath(path, root = false) {
  if (typeof path !== 'string') throw Error('Choose a file in My files.');
  const relative = path.replace(/^(?:browser:)?\//, '');
  if (root && !relative) return '';
  if (relative.split('/').some(part => !part || part === '.' || part === '..' || invalidName.test(part))) {
    throw Error('Choose a file in My files.');
  }
  if (relative === '.app' || relative.startsWith('.app/')) throw Error('Choose a folder outside Retake settings.');
  return relative;
}

function virtual(path) {
  return 'browser:/' + path;
}

function isSession(path) {
  return path.toLowerCase().endsWith('.altaudio');
}

export function mount(host) {
  const owner = host.storage.workspaceOwner();
  const session = host.session();
  const controller = new AbortController();
  const {signal} = controller;
  const root = element('section', {className: 'window-content retake-workspace'});
  const view = element('iframe', {title: 'Retake', allow: 'autoplay; microphone'});
  const status = element('p', {textContent: 'Starting Retake…'});
  status.setAttribute('role', 'status');
  root.append(element('link', {rel: 'stylesheet', href: new URL('./workspace.css', import.meta.url).href}), view, status);

  const revisions = new Map();
  const folders = new Set(['']);
  let context, openFile, unregister, binding;
  let dirty = false;
  let transferring = false;
  let writes = Promise.resolve();
  let welcomePreference = Promise.resolve();
  let startResolve, startReject;
  const start = new Promise((resolve, reject) => {
    startResolve = resolve;
    startReject = reject;
  });
  const timer = setTimeout(() => startReject(Error('Retake took too long to start.')), 90000);
  signal.addEventListener('abort', () => startReject(signal.reason), {once: true});
  start.catch(() => {});

  function check() {
    if (signal.aborted || host.session() !== session || host.storage.workspaceOwner() !== owner || !context?.valid()) {
      throw new DOMException('This Files session ended.', 'AbortError');
    }
    if (transferring) throw Error('Files are being transferred.');
  }

  async function list(path) {
    check();
    const result = await context.files.list(path, {signal});
    check();
    return result.entries.filter(entry => !entry.deleted);
  }

  async function listFiles(base) {
    const result = [];
    const queue = [base];
    for (let i = 0; i < queue.length; i++) {
      const folder = queue[i];
      for (const entry of await list(folder)) {
        const path = folder ? folder + '/' + entry.name : entry.name;
        if (path === '.app' || path.startsWith('.app/')) continue;
        if (entry.directory) {
          folders.add(path);
          queue.push(path);
        } else {
          result.push(virtual(path));
        }
      }
    }
    return result;
  }

  async function read(path) {
    check();
    const result = await context.files.read(path, {signal});
    check();
    if (!revision.test(result.sha256)) throw Error('Files returned an invalid revision.');
    revisions.set(path, result.sha256);
    return {name: nameOf(path), path: virtual(path), bytes: result.data, sha256: result.sha256};
  }

  async function ensureFolders(path) {
    let folder = '';
    for (const part of path.split('/').slice(0, -1)) {
      const parent = folder;
      folder = folder ? folder + '/' + part : part;
      if (folders.has(folder)) continue;
      const found = async () => (await list(parent)).some(entry => entry.directory && entry.name === part);
      if (!await found()) {
        try {
          await context.files.mkdir(folder, {signal});
        } catch (error) {
          if (error?.status !== 409 || !await found()) throw error;
        }
      }
      folders.add(folder);
    }
  }

  function commit(changes) {
    const files = changes.map(({path, bytes}) => ({path: workspacePath(path), bytes}));
    files.sort((a, b) => Number(isSession(a.path)) - Number(isSession(b.path)));
    const receipt = writes.then(async () => {
      for (const {path, bytes} of files) {
        check();
        await ensureFolders(path);
        const mime = isSession(path) ? 'application/json' : 'application/octet-stream';
        let result;
        try {
          result = await context.files.write(path, new Blob([bytes], {type: mime}), revisions.get(path) ?? null, {signal});
        } catch (error) {
          if (error?.status === 409) throw Error('This file already exists or changed. Save as a new file to keep both copies.');
          throw error;
        }
        check();
        if (!revision.test(result.sha256)) throw Error('Files did not confirm the save.');
        revisions.set(path, result.sha256);
      }
    });
    writes = receipt.catch(error => {
      if (!signal.aborted) status.textContent = error.message;
    });
    return receipt;
  }

  view.retakeFiles = {
    scope: owner,
    onOpen(callback) { openFile = callback; },
    ready() { startResolve(); },
    failed(message) { startReject(Error(message)); },
    setUnsaved(value) { dirty = value; },
    waitForWelcomePreference(write) { welcomePreference = write; },
    status(message) { if (!signal.aborted) status.textContent = message; },
    close() { host.desktop.requestWindowClose?.(host.w); },
    files(path) { return listFiles(workspacePath(path, true)); },
    async read(path) { return (await read(workspacePath(path))).bytes; },
    async open({types}) {
      check();
      const extensions = types.length ? types.map(type => '.' + type) : undefined;
      const selected = await host.storage.pickWorkspaceFile({extensions, signal});
      return selected ? [await read(workspacePath(selected))] : null;
    },
    async saveAs({name, types, folder}) {
      check();
      const selected = await host.storage.pickWorkspaceFile({foldersOnly: true, signal});
      if (!selected) return null;
      if (folder) return {path: virtual(workspacePath(selected, true))};
      const choice = await host.ui.prompt('File name', {title: 'Save Retake file', value: name, confirmLabel: 'Save', signal});
      if (choice == null) return null;
      let filename = choice.trim();
      if (!filename || invalidName.test(filename) || filename === '.' || filename === '..') throw Error('Enter a file name.');
      if (types.length && !types.some(type => filename.toLowerCase().endsWith('.' + type))) filename += '.' + types[0];
      const parent = workspacePath(selected, true);
      return {path: virtual(workspacePath(parent ? parent + '/' + filename : filename))};
    },
    commit,
    session(path, command) {
      check();
      const target = path == null ? null : workspacePath(path);
      const sha256 = revisions.get(target);
      binding = sha256 ? {path: target, sha256} : undefined;
      host.desktop.updateAccountFileBinding(host.w, {owner, path: binding?.path ?? null, sha256: sha256 ?? null});
      status.textContent = binding
        ? (command === 'session_save' ? 'Saved ' : 'Opened ') + nameOf(target)
        : 'Retake is ready';
    },
  };

  const ready = (async () => {
    context = await host.storage.workspaceFileContext();
    check();
    if (context.owner !== owner) throw Error('This editor belongs to another Files workspace.');
    view.src = new URL('./native/index.html', import.meta.url).href;
    await start;
    check();
    unregister = context.registerFileWriter?.(async () => {
      await writes;
      if (dirty) throw Error('Save the Retake session before transferring Files.');
      transferring = true;
      view.inert = true;
      return () => {
        transferring = false;
        view.inert = false;
      };
    });
    status.textContent = 'Retake is ready';
    const launch = host.w.launchContext;
    if (launch) {
      if (launch.storage !== 'account' || launch.owner !== owner) throw Error('Open the session from My files.');
      const loaded = await read(workspacePath(launch.path));
      if (!launch.restore && launch.sha256 && launch.sha256 !== loaded.sha256) throw Error('The session changed in Files. Open its current revision.');
      openFile(loaded);
    }
  })().finally(() => clearTimeout(timer));
  ready.catch(error => { if (!signal.aborted) status.textContent = error.message; });

  return {
    element: root,
    ready,
    focus: () => view.focus(),
    inspect: () => ({path: binding?.path ?? null, dirty}),
    async requestClose() {
      await welcomePreference;
      await writes;
      return !dirty || host.ui.confirm('Discard unsaved changes to this session?', {confirmLabel: 'Discard', signal});
    },
    dispose() {
      controller.abort();
      unregister?.();
    },
  };
}
