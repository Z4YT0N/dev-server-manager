/**
 * Dev Server Manager — Neutralinojs renderer.
 *
 * Single-file app: there is no separate main process. Neutralino's
 * `os`, `filesystem`, and `events` modules give the renderer direct
 * access to OS primitives, so we keep ALL logic here and avoid the
 * IPC bridge dance Electron required.
 *
 * Major sections:
 *   1. Persistence (load / save projects + ignored folders to disk)
 *   2. Detection (netstat + WMI cmd-line scrape + classifier)
 *   3. Auto-add (detected projects → saved entries)
 *   4. Process control (spawn / kill / log capture)
 *   5. UI rendering (sidebar + detail panel + modals)
 */

// ── Bootstrap ─────────────────────────────────────────────────────────

Neutralino.init();

Neutralino.events.on('windowClose', async () => {
  // Kill every dev server WE started before quitting.
  for (const id of [...running.keys()]) {
    await killSpawned(id);
  }
  Neutralino.app.exit();
});

// ── Globals ───────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const isWin = NL_OS === 'Windows';

let DATA_DIR = '';            // resolved at startup
let projects = [];            // persisted saved projects
const running = new Map();    // id → { processId, pid, startedAt, logs[] }
let detected = [];            // external dev servers we found running
let selectedId = null;
let editingId = null;

const LOG_LIMIT = 400;
const POLL_MS = 5000;

// ── Path helpers ──────────────────────────────────────────────────────

function projectsFile() { return `${DATA_DIR}/projects.json`; }
function ignoredFile()  { return `${DATA_DIR}/ignored-folders.json`; }

function normalizeFolder(folder) {
  if (!folder) return '';
  let f = folder.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (isWin) f = f.toLowerCase();
  return f;
}

// ── Persistence ──────────────────────────────────────────────────────

async function loadProjects() {
  try {
    const text = await Neutralino.filesystem.readFile(projectsFile());
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveProjects() {
  try { await Neutralino.filesystem.createDirectory(DATA_DIR); } catch { /* exists */ }
  await Neutralino.filesystem.writeFile(
    projectsFile(),
    JSON.stringify(projects, null, 2),
  );
}

async function loadIgnoredFolders() {
  try {
    const text = await Neutralino.filesystem.readFile(ignoredFile());
    const arr = JSON.parse(text);
    return new Set(Array.isArray(arr) ? arr.map(normalizeFolder) : []);
  } catch {
    return new Set();
  }
}

// ── Detection: listening ports ────────────────────────────────────────

async function getListeningPorts() {
  if (!isWin) return [];
  const ns = await Neutralino.os.execCommand('netstat -ano -p TCP');
  const rows = [];
  for (const line of (ns.stdOut || '').split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (!m) continue;
    rows.push({ host: m[1], port: Number(m[2]), pid: Number(m[3]) });
  }
  const tl = await Neutralino.os.execCommand('tasklist /FO CSV /NH');
  const byPid = new Map();
  for (const line of (tl.stdOut || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]*)","([^"]*)"/);
    if (m) byPid.set(Number(m[2]), m[1]);
  }
  for (const row of rows) row.exe = byPid.get(row.pid) || '?';
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.port)) seen.set(r.port, r);
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

// ── Detection: node command lines via WMI ─────────────────────────────

function utf16leBase64(str) {
  const buf = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[i * 2] = code & 0xff;
    buf[i * 2 + 1] = (code >> 8) & 0xff;
  }
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

async function fetchNodeCommandLines() {
  if (!isWin) return new Map();
  const psScript =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    'Select-Object ProcessId, CommandLine | ' +
    'ConvertTo-Json -Compress';
  const encoded = utf16leBase64(psScript);
  const r = await Neutralino.os.execCommand(
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
  );
  try {
    const raw = JSON.parse(r.stdOut || 'null');
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const map = new Map();
    for (const r of arr) {
      if (r && r.ProcessId) map.set(Number(r.ProcessId), r.CommandLine || '');
    }
    return map;
  } catch {
    return new Map();
  }
}

function classifyDevCommand(cmd) {
  if (!cmd) return null;
  const c = cmd.toLowerCase().replace(/\\/g, '/');
  if (
    /\bnext\b.*\bdev\b/.test(c) ||
    /next\/dist\/server\/lib\/start-server\.js/.test(c) ||
    /next\/dist\/bin\/next/.test(c)
  ) return 'Next.js';
  if (
    (/\bvite\b/.test(c) || /vite\/(bin|dist)\//.test(c)) &&
    !c.includes('vite build') && !c.includes('vite preview')
  ) return 'Vite';
  if (/\bwebpack-dev-server\b|\bwebpack serve\b|webpack-dev-server\/bin/.test(c)) return 'Webpack';
  if (/\bnuxt\b.*\bdev\b/.test(c) || /nuxt\/bin\/nuxt(-cli)?\.mjs/.test(c)) return 'Nuxt';
  if (
    /\b(remix|astro|svelte-kit|sveltekit)\b.*\bdev\b/.test(c) ||
    /(astro|@remix-run\/dev|svelte-kit)\/dist/.test(c)
  ) return 'Framework';
  if (/\bnpm(\.cmd)?\b.*\brun\b.*\bdev\b/.test(c)) return 'npm run dev';
  if (/\bpnpm(\.cmd)?\b.*\bdev\b/.test(c)) return 'pnpm dev';
  if (/\byarn(\.cmd)?\b.*\bdev\b/.test(c)) return 'yarn dev';
  if (/\bnodemon\b/.test(c)) return 'nodemon';
  return null;
}

function extractProjectFolder(cmd) {
  if (!cmd) return null;
  const candidates = [];
  for (const m of cmd.matchAll(/"([^"]+?)[\\/]node_modules[\\/]/g))
    candidates.push(m[1]);
  for (const m of cmd.matchAll(/([A-Za-z]:[\\/](?:[^"\s]+?))[\\/]node_modules[\\/]/g))
    candidates.push(m[1]);
  for (const raw of candidates) {
    const folder = raw.trim();
    if (/[\\/](nodejs|npm)$/i.test(folder)) continue;
    if (/[\\/]Program Files([\\/]|$)/i.test(folder) && /[\\/]nodejs([\\/]|$)/i.test(folder))
      continue;
    return folder;
  }
  return null;
}

async function readPackageName(folder) {
  try {
    const text = await Neutralino.filesystem.readFile(`${folder}/package.json`);
    const pkg = JSON.parse(text);
    return typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name : null;
  } catch {
    return null;
  }
}

async function detectDevServers() {
  const [ports, cmds] = await Promise.all([
    getListeningPorts(),
    fetchNodeCommandLines(),
  ]);
  const out = [];
  for (const p of ports) {
    if (!p.pid || !/node/i.test(p.exe || '')) continue;
    const cmd = cmds.get(p.pid);
    if (!cmd) continue;
    const kind = classifyDevCommand(cmd);
    if (!kind) continue;
    const folder = extractProjectFolder(cmd);
    const name = folder ? await readPackageName(folder) : null;
    out.push({
      pid: p.pid,
      port: p.port,
      kind,
      command: cmd.length > 200 ? cmd.slice(0, 197) + '…' : cmd,
      exe: p.exe,
      folder,
      name,
    });
  }
  const seen = new Map();
  for (const row of out) {
    const existing = seen.get(row.pid);
    if (!existing || row.port < existing.port) seen.set(row.pid, row);
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

// ── Auto-add detected projects ────────────────────────────────────────

async function autoAddProjects(rows) {
  const ignored = await loadIgnoredFolders();
  const existing = new Set(projects.map((p) => normalizeFolder(p.folder)));
  let changed = false;
  for (const d of rows) {
    if (!d.folder) continue;
    const key = normalizeFolder(d.folder);
    if (existing.has(key) || ignored.has(key)) continue;
    projects.push({
      id: crypto.randomUUID(),
      name: d.name || d.folder.split(/[\\/]/).filter(Boolean).pop() || 'project',
      folder: d.folder,
      command: 'npm run dev',
      port: d.port,
      createdAt: Date.now(),
      autoAdded: true,
    });
    existing.add(key);
    changed = true;
  }
  if (changed) await saveProjects();
  return changed;
}

// ── Process control ───────────────────────────────────────────────────

function appendLog(id, line) {
  const r = running.get(id);
  if (!r) return;
  r.logs.push(line);
  if (r.logs.length > LOG_LIMIT) r.logs.splice(0, r.logs.length - LOG_LIMIT);
  if (id === selectedId) appendLogLineToDOM(line);
}

async function startProject(id) {
  if (running.has(id)) return;
  const project = projects.find((p) => p.id === id);
  if (!project || !project.folder) return;

  try { await Neutralino.filesystem.getStats(project.folder); }
  catch { alert(`Folder does not exist: ${project.folder}`); return; }

  const cmd = project.command || 'npm run dev';
  const fullCmd = isWin
    ? `cmd /c "set PORT=${project.port} && ${cmd}"`
    : `bash -lc 'PORT=${project.port} ${cmd}'`;

  let info;
  try { info = await Neutralino.os.spawnProcess(fullCmd, project.folder); }
  catch (err) { alert(`Spawn failed: ${err.message || err}`); return; }

  running.set(id, {
    processId: info.id,
    pid: info.pid,
    startedAt: Date.now(),
    logs: [
      `> Started: ${cmd}`,
      `  cwd: ${project.folder}`,
      `  PORT: ${project.port}`,
      '',
    ],
  });
  render();
}

async function killSpawned(id) {
  const r = running.get(id);
  if (!r) return;
  try { await Neutralino.os.updateSpawnedProcess(r.processId, 'exit'); } catch {}
  if (isWin) {
    try { await Neutralino.os.execCommand(`taskkill /pid ${r.pid} /T /F`); } catch {}
  }
  running.delete(id);
}

async function stopProject(id) { await killSpawned(id); render(); }

async function killExternalPid(pid) {
  if (!pid) return;
  if (isWin) {
    try { await Neutralino.os.execCommand(`taskkill /pid ${pid} /T /F`); } catch {}
  } else {
    try { await Neutralino.os.execCommand(`kill -TERM ${pid}`); } catch {}
  }
}

Neutralino.events.on('spawnedProcess', (evt) => {
  const { id: processId, action, data } = evt.detail;
  let projectId = null;
  for (const [pid, r] of running.entries()) {
    if (r.processId === processId) { projectId = pid; break; }
  }
  if (!projectId) return;
  if (action === 'stdOut' || action === 'stdErr') {
    for (const line of String(data).split(/\r?\n/)) if (line) appendLog(projectId, line);
  } else if (action === 'exit') {
    appendLog(projectId, `> Process exited (code: ${data})`);
    running.delete(projectId);
    render();
  }
});

// ── Detected dev-server polling ──────────────────────────────────────

async function refreshDetected() {
  try {
    const next = await detectDevServers();
    await autoAddProjects(next);
    const projChanged = await maybeReloadProjects();
    if (JSON.stringify(next) !== JSON.stringify(detected) || projChanged) {
      detected = next;
      render();
    }
  } catch (err) {
    console.error('Detect failed:', err);
  }
}

async function maybeReloadProjects() {
  const fresh = await loadProjects();
  if (JSON.stringify(fresh) !== JSON.stringify(projects)) {
    projects = fresh;
    return true;
  }
  return false;
}

// ── UI rendering ──────────────────────────────────────────────────────

function buildDetectedByFolder() {
  const map = new Map();
  for (const d of detected) if (d.folder) map.set(normalizeFolder(d.folder), d);
  return map;
}

function render() {
  $('#project-count').textContent = String(projects.length);
  const list = $('#project-list');
  list.innerHTML = '';

  const byFolder = buildDetectedByFolder();
  const savedFolders = new Set(projects.map((p) => normalizeFolder(p.folder)));
  const unsavedDetected = detected.filter(
    (d) => !d.folder || !savedFolders.has(normalizeFolder(d.folder)),
  );

  if (unsavedDetected.length > 0) {
    list.appendChild(makeSection('Detected', unsavedDetected.length));
    for (const d of unsavedDetected) list.appendChild(renderDetected(d));
  }
  if (projects.length > 0) {
    list.appendChild(makeSection('Saved', projects.length));
    for (const p of projects) list.appendChild(renderSaved(p, byFolder));
  }

  renderDetail(byFolder);
}

function makeSection(label, count) {
  const li = document.createElement('li');
  li.className = 'section-label';
  li.innerHTML = `<span></span><span class="muted"></span>`;
  li.children[0].textContent = label;
  li.children[1].textContent = String(count);
  return li;
}

function renderDetected(d) {
  const li = document.createElement('li');
  li.className = 'detected';
  li.innerHTML = `
    <div class="row">
      <span class="name"></span>
      <span class="status">
        <span class="dot running"></span>
        <span class="kind"></span>
      </span>
    </div>
    <div class="folder mono"></div>
    <div class="detected-meta"></div>
    <div class="detected-actions">
      <button class="btn small" data-act="open"></button>
      <button class="btn small danger" data-act="stop">Stop</button>
    </div>
  `;
  const displayName =
    d.name ||
    (d.folder && d.folder.split(/[\\/]/).filter(Boolean).pop()) ||
    `Port ${d.port}`;
  li.querySelector('.name').textContent = displayName;
  li.querySelector('.kind').textContent = d.kind;
  li.querySelector('.folder').textContent =
    d.folder || `${d.exe || 'node'}  · PID ${d.pid}`;
  li.querySelector('.detected-meta').textContent = `port ${d.port}  ·  pid ${d.pid}`;
  const openBtn = li.querySelector('[data-act="open"]');
  openBtn.textContent = `Open :${d.port}`;
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    Neutralino.os.open(`http://localhost:${d.port}`);
  });
  li.querySelector('[data-act="stop"]').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Kill PID ${d.pid} on port ${d.port}?`)) return;
    await killExternalPid(d.pid);
    await refreshDetected();
  });
  return li;
}

function renderSaved(p, byFolder) {
  const ext = p.folder ? byFolder.get(normalizeFolder(p.folder)) : null;
  const isRunningManaged = running.has(p.id);
  const isRunningExternal = !!ext && !isRunningManaged;
  const isRunning = isRunningManaged || isRunningExternal;

  const li = document.createElement('li');
  if (p.id === selectedId) li.classList.add('active');
  li.dataset.id = p.id;
  li.innerHTML = `
    <div class="row">
      <span class="name"></span>
      <span class="status">
        <span class="dot ${isRunning ? 'running' : ''}"></span>
        <span class="status-text"></span>
      </span>
    </div>
    <div class="folder"></div>
  `;
  li.querySelector('.name').textContent = p.name || '(unnamed)';
  li.querySelector('.folder').textContent = p.folder || '';
  li.querySelector('.status-text').textContent = isRunningExternal
    ? `Running · :${ext.port}`
    : isRunningManaged ? 'Running' : 'Stopped';
  li.addEventListener('click', () => {
    selectedId = p.id;
    render();
  });
  return li;
}

function renderDetail(byFolder) {
  const detail = $('#detail');
  const project = projects.find((p) => p.id === selectedId);
  if (!project) {
    detail.innerHTML = `
      <div class="empty">
        <p>No project selected.</p>
        <p class="muted small">Click <b>+ Add Project</b> to register a folder, then select it here.</p>
      </div>`;
    return;
  }

  const r = running.get(project.id);
  const ext = project.folder ? byFolder.get(normalizeFolder(project.folder)) : null;
  const isRunningManaged = !!r;
  const isRunningExternal = !!ext && !isRunningManaged;
  const isRunning = isRunningManaged || isRunningExternal;
  const uptime = isRunningManaged ? formatUptime(Date.now() - r.startedAt) : '';
  const displayPort = isRunningExternal ? ext.port : project.port;
  const displayPid = isRunningManaged ? r.pid : isRunningExternal ? ext.pid : null;

  detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">
        <h1></h1>
        <div class="actions">
          <button class="btn small" id="d-edit">Edit</button>
          <button class="btn small danger" id="d-delete">Delete</button>
          ${
            isRunning
              ? '<button class="btn small danger" id="d-stop">Stop</button>'
              : '<button class="btn small success" id="d-start">Start</button>'
          }
        </div>
      </div>
      <div class="meta">
        <span><b>Port:</b> ${displayPort}${isRunningExternal && displayPort !== project.port ? ` <span class="muted">(saved: ${project.port})</span>` : ''}</span>
        <span><b>Command:</b> <code></code></span>
        <span><b>Folder:</b> <a id="d-open-folder"></a></span>
        ${displayPid ? `<span><b>PID:</b> ${displayPid}${isRunningExternal ? ' <span class="muted">(external)</span>' : ''}</span>` : ''}
        ${isRunningManaged ? `<span><b>Uptime:</b> ${uptime}</span>` : ''}
        ${isRunning ? `<span><b>URL:</b> <a id="d-open-url">http://localhost:${displayPort}</a></span>` : ''}
      </div>
    </div>
    <pre class="logs" id="d-logs"></pre>
  `;

  detail.querySelector('h1').textContent = project.name || '(unnamed)';
  detail.querySelector('.meta code').textContent = project.command;
  const folderLink = detail.querySelector('#d-open-folder');
  folderLink.textContent = project.folder;
  folderLink.addEventListener('click', () => Neutralino.os.open(project.folder));

  if (isRunning) {
    const openUrl = detail.querySelector('#d-open-url');
    if (openUrl) openUrl.addEventListener('click', () =>
      Neutralino.os.open(`http://localhost:${displayPort}`),
    );
  }

  detail.querySelector('#d-edit').addEventListener('click', () => openModal(project.id));
  detail.querySelector('#d-delete').addEventListener('click', () => deleteProject(project.id));
  if (isRunning) {
    detail.querySelector('#d-stop').addEventListener('click', async () => {
      if (isRunningExternal) {
        if (!confirm(`Stop external process PID ${ext.pid} on port ${ext.port}?`)) return;
        await killExternalPid(ext.pid);
        await refreshDetected();
      } else {
        stopProject(project.id);
      }
    });
  } else {
    detail.querySelector('#d-start').addEventListener('click', () => startProject(project.id));
  }

  const logsEl = detail.querySelector('#d-logs');
  if (isRunningManaged && r?.logs) {
    logsEl.textContent = r.logs.join('\n') + '\n';
  } else if (isRunningExternal) {
    logsEl.textContent =
      '> This dev server is running externally (started outside this app).\n' +
      '> Logs are written to the terminal where it was launched.\n' +
      `> PID ${ext.pid}  ·  port ${ext.port}  ·  framework ${ext.kind}\n`;
  } else {
    logsEl.textContent = '';
  }
  logsEl.scrollTop = logsEl.scrollHeight;
}

function appendLogLineToDOM(line) {
  const logsEl = document.querySelector('#d-logs');
  if (!logsEl) return;
  const text = logsEl.textContent + line + '\n';
  const lines = text.split('\n');
  if (lines.length > 500) lines.splice(0, lines.length - 500);
  logsEl.textContent = lines.join('\n');
  logsEl.scrollTop = logsEl.scrollHeight;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Modal handlers (add/edit) ────────────────────────────────────────

async function pickFolder() {
  try {
    const folder = await Neutralino.os.showFolderDialog('Pick project folder');
    return folder || null;
  } catch {
    return null;
  }
}

function openModal(id) {
  editingId = id;
  const p = projects.find((x) => x.id === id);
  $('#modal-title').textContent = p ? 'Edit Project' : 'Add Project';
  $('#f-name').value = p?.name ?? '';
  $('#f-folder').value = p?.folder ?? '';
  $('#f-command').value = p?.command ?? 'npm run dev';
  $('#f-port').value = p?.port ?? 3000;
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
  editingId = null;
}

async function saveProjectFromModal() {
  const data = {
    name: $('#f-name').value.trim(),
    folder: $('#f-folder').value.trim(),
    command: $('#f-command').value.trim() || 'npm run dev',
    port: Number($('#f-port').value) || 3000,
  };
  if (!data.folder) { alert('Please choose a folder.'); return; }
  if (!data.name) data.name = data.folder.split(/[\\/]/).pop() || 'project';

  if (editingId) {
    const idx = projects.findIndex((p) => p.id === editingId);
    if (idx !== -1) projects[idx] = { ...projects[idx], ...data };
  } else {
    const created = { id: crypto.randomUUID(), createdAt: Date.now(), ...data };
    projects.push(created);
    selectedId = created.id;
  }
  await saveProjects();
  closeModal();
  render();
}

async function deleteProject(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`Remove "${p.name}"? Will stop it if running.`)) return;
  await killSpawned(id);
  projects = projects.filter((x) => x.id !== id);
  await saveProjects();
  if (selectedId === id) selectedId = null;
  render();
}

// ── Ports modal ──────────────────────────────────────────────────────

async function openPortsModal() {
  $('#ports-modal').classList.remove('hidden');
  await refreshPortsList();
}

function closePortsModal() {
  $('#ports-modal').classList.add('hidden');
}

async function refreshPortsList() {
  const tbody = $('#ports-tbody');
  tbody.innerHTML = '<tr><td colspan="4" class="muted">Scanning…</td></tr>';
  const rows = await getListeningPorts();
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">No listening TCP ports found.</td></tr>';
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><b></b></td><td></td><td></td><td></td>';
    tr.children[0].querySelector('b').textContent = r.port;
    tr.children[1].textContent = r.exe || '?';
    tr.children[2].textContent = r.pid;
    tr.children[3].textContent = r.host || '';
    tbody.appendChild(tr);
  }
}

// ── Global UI wiring ─────────────────────────────────────────────────

function bindGlobalUI() {
  $('#add-btn').addEventListener('click', () => openModal(null));
  $('#ports-btn').addEventListener('click', openPortsModal);
  $('#f-cancel').addEventListener('click', closeModal);
  $('#f-save').addEventListener('click', saveProjectFromModal);
  $('#f-pick').addEventListener('click', async () => {
    const folder = await pickFolder();
    if (folder) {
      $('#f-folder').value = folder;
      if (!$('#f-name').value) {
        $('#f-name').value = folder.split(/[\\/]/).pop();
      }
    }
  });
  $('#ports-close').addEventListener('click', closePortsModal);
  $('#ports-refresh').addEventListener('click', refreshPortsList);
}

// ── Boot ──────────────────────────────────────────────────────────────

(async function init() {
  DATA_DIR = await Neutralino.os.getPath('data');
  projects = await loadProjects();
  bindGlobalUI();
  render();
  refreshDetected();
  setInterval(refreshDetected, POLL_MS);
})();
