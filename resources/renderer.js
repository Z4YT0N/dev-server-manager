/**
 * Dev Server Manager — Neutralinojs renderer (v0.2.0).
 *
 * Single-file app: no separate main process. Neutralino's `os`,
 * `filesystem`, and `events` modules give the renderer direct OS access
 * so we keep ALL logic here and avoid the IPC bridge dance Electron
 * required.
 *
 * Sections (search for ── to jump):
 *   1. Bootstrap, globals, persistence
 *   2. Detection (netstat + WMI cmd-line scrape + classifier + custom patterns)
 *   3. Auto-add (detected projects → saved entries)
 *   4. Process control (spawn / kill / log capture / auto-restart watchdog)
 *   5. CPU/RAM polling
 *   6. System tray + window lifecycle
 *   7. UI rendering (sidebar + detail + modals)
 *
 * Platform note: detection currently relies on Windows tooling
 * (netstat, tasklist, Get-CimInstance). All detection guards run only
 * when isWin is true; on macOS/Linux you can still use Saved-project
 * Start/Stop manually, you just won't get auto-discovery yet.
 */

// ── Bootstrap & globals ──────────────────────────────────────────────

Neutralino.init();

const $ = (sel) => document.querySelector(sel);
const isWin = NL_OS === 'Windows';

let DATA_DIR = '';
let projects = [];
const running = new Map();   // id → { processId, pid, startedAt, logs[], restartCount, lastReadyNotified, cpu, mem }
const watchdog = new Map();  // id → setTimeout handle for pending restart
const exitedLogs = new Map(); // id → string[]  (kept after process exit so user can still read)
let detected = [];
let selectedId = null;
let editingId = null;
let customPatterns = [];     // [{ id, name, regex, framework }]
let filterText = '';
let trayEnabled = true;      // user can toggle from tray menu

const LOG_LIMIT = 400;
const POLL_MS = 5000;
const PERF_POLL_MS = 6000;
const RESTART_DELAY_MS = 2000;
const RESTART_BACKOFF_LIMIT = 3;

// ── Path & format helpers ────────────────────────────────────────────

function projectsFile()   { return `${DATA_DIR}/projects.json`; }
function ignoredFile()    { return `${DATA_DIR}/ignored-folders.json`; }
function patternsFile()   { return `${DATA_DIR}/custom-patterns.json`; }
function logFileFor(id)   { return `${DATA_DIR}/logs/${id}.log`; }
function settingsFile()   { return `${DATA_DIR}/settings.json`; }

function normalizeFolder(folder) {
  if (!folder) return '';
  let f = folder.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (isWin) f = f.toLowerCase();
  return f;
}

function shellEscape(s) {
  return String(s).replace(/[`$"\\]/g, '\\$&');
}

// ── Persistence ──────────────────────────────────────────────────────

async function ensureDataDir() {
  try { await Neutralino.filesystem.createDirectory(DATA_DIR); } catch { /* exists */ }
  try { await Neutralino.filesystem.createDirectory(`${DATA_DIR}/logs`); } catch { /* exists */ }
}

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
  await ensureDataDir();
  await Neutralino.filesystem.writeFile(projectsFile(), JSON.stringify(projects, null, 2));
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

async function loadCustomPatterns() {
  try {
    const text = await Neutralino.filesystem.readFile(patternsFile());
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveCustomPatterns() {
  await ensureDataDir();
  await Neutralino.filesystem.writeFile(patternsFile(), JSON.stringify(customPatterns, null, 2));
}

async function loadSettings() {
  try {
    const text = await Neutralino.filesystem.readFile(settingsFile());
    const s = JSON.parse(text);
    if (typeof s.trayEnabled === 'boolean') trayEnabled = s.trayEnabled;
  } catch { /* defaults */ }
}

async function saveSettings() {
  await ensureDataDir();
  await Neutralino.filesystem.writeFile(
    settingsFile(),
    JSON.stringify({ trayEnabled }, null, 2),
  );
}

/** Persist last N log lines so they remain visible after a stop/crash. */
async function persistLogs(id) {
  const r = running.get(id);
  if (!r) return;
  try {
    await ensureDataDir();
    await Neutralino.filesystem.writeFile(logFileFor(id), r.logs.join('\n'));
  } catch { /* nbd */ }
}

async function loadPersistedLogs(id) {
  try {
    const text = await Neutralino.filesystem.readFile(logFileFor(id));
    return text.split('\n');
  } catch {
    return null;
  }
}

// ── Detection: listening ports ───────────────────────────────────────

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

// ── Detection: node command lines via WMI ────────────────────────────

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

  // User-defined patterns first — they win over built-ins so the user
  // can override or extend detection for in-house frameworks.
  for (const p of customPatterns) {
    if (!p.regex) continue;
    try {
      if (new RegExp(p.regex, 'i').test(c)) return p.framework || p.name || 'Custom';
    } catch { /* invalid user regex, skip */ }
  }

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

// ── Auto-add detected projects ───────────────────────────────────────

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
      autoRestart: false,
      createdAt: Date.now(),
      autoAdded: true,
    });
    existing.add(key);
    changed = true;
  }
  if (changed) await saveProjects();
  return changed;
}

// ── Process control + auto-restart ───────────────────────────────────

function appendLog(id, line) {
  const r = running.get(id);
  if (!r) return;
  r.logs.push(line);
  if (r.logs.length > LOG_LIMIT) r.logs.splice(0, r.logs.length - LOG_LIMIT);

  // Notify on first "ready"-like line from this process.
  if (!r.lastReadyNotified && /ready|started|listening|local:|compiled successfully/i.test(line)) {
    r.lastReadyNotified = true;
    const p = projects.find((p) => p.id === id);
    if (p) {
      try {
        Neutralino.os.showNotification(
          `${p.name} is ready`,
          `Listening on port ${p.port}. ${line.trim().slice(0, 80)}`,
          'INFO',
        );
      } catch { /* notifications optional */ }
    }
  }

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
    : `bash -lc 'PORT=${project.port} ${shellEscape(cmd)}'`;

  let info;
  try { info = await Neutralino.os.spawnProcess(fullCmd, project.folder); }
  catch (err) { alert(`Spawn failed: ${err.message || err}`); return; }

  // Carry over restart count if this is part of a watchdog chain.
  const prevRestartCount = exitedLogs.has(id)
    ? exitedLogs.get(id).restartCount || 0
    : 0;

  running.set(id, {
    processId: info.id,
    pid: info.pid,
    startedAt: Date.now(),
    logs: [
      `> Started: ${cmd}`,
      `  cwd: ${project.folder}`,
      `  PORT: ${project.port}`,
      prevRestartCount > 0 ? `  (auto-restart #${prevRestartCount})` : '',
      '',
    ].filter((l) => l !== ''),
    restartCount: prevRestartCount,
    lastReadyNotified: false,
    cpu: null,
    mem: null,
  });
  exitedLogs.delete(id);
  render();
}

async function killSpawned(id) {
  const r = running.get(id);
  if (!r) return;
  // Mark as intentional so the spawned-exit handler skips auto-restart,
  // and cancel any pending watchdog for this id before killing.
  r.intentionallyStopped = true;
  cancelWatchdog(id);

  try { await Neutralino.os.updateSpawnedProcess(r.processId, 'exit'); } catch {}
  if (isWin) {
    try { await Neutralino.os.execCommand(`taskkill /pid ${r.pid} /T /F`); } catch {}
  } else {
    try { await Neutralino.os.execCommand(`kill -TERM -${r.pid}`); } catch {}
  }
  await persistLogs(id);
  running.delete(id);
}

async function stopProject(id) {
  // User-initiated stop should clear the restart chain entirely.
  exitedLogs.delete(id);
  await killSpawned(id);
  render();
}

async function killExternalPid(pid) {
  if (!pid) return;
  if (isWin) {
    try { await Neutralino.os.execCommand(`taskkill /pid ${pid} /T /F`); } catch {}
  } else {
    try { await Neutralino.os.execCommand(`kill -TERM ${pid}`); } catch {}
  }
}

function cancelWatchdog(id) {
  const t = watchdog.get(id);
  if (t) {
    clearTimeout(t);
    watchdog.delete(id);
  }
}

function scheduleAutoRestart(id, exitCode) {
  const project = projects.find((p) => p.id === id);
  if (!project || !project.autoRestart) return;

  const prev = exitedLogs.get(id) || {};
  const restartCount = (prev.restartCount || 0) + 1;
  exitedLogs.set(id, { ...prev, restartCount });

  if (restartCount > RESTART_BACKOFF_LIMIT) {
    appendExitedLog(
      id,
      `> Auto-restart limit (${RESTART_BACKOFF_LIMIT}) reached — giving up. Fix the underlying error and restart manually.`,
    );
    return;
  }

  appendExitedLog(
    id,
    `> Auto-restart in ${RESTART_DELAY_MS}ms (attempt ${restartCount}/${RESTART_BACKOFF_LIMIT}, exit ${exitCode})`,
  );
  cancelWatchdog(id);
  watchdog.set(id, setTimeout(() => {
    watchdog.delete(id);
    startProject(id).catch((e) => console.error('Watchdog restart failed', e));
  }, RESTART_DELAY_MS));
}

function appendExitedLog(id, line) {
  const entry = exitedLogs.get(id) || { lines: [] };
  entry.lines = entry.lines || [];
  entry.lines.push(line);
  if (entry.lines.length > LOG_LIMIT) entry.lines.splice(0, entry.lines.length - LOG_LIMIT);
  exitedLogs.set(id, entry);
  if (id === selectedId) render();
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
    const r = running.get(projectId);
    const code = Number(data);
    const intentional = r?.intentionallyStopped === true;
    // Snapshot logs into exitedLogs so they remain visible after stop.
    if (r) {
      const prev = exitedLogs.get(projectId) || {};
      exitedLogs.set(projectId, {
        ...prev,
        lines: [...r.logs, `> Process exited (code: ${code})`],
        exitedAt: Date.now(),
      });
    }
    appendLog(projectId, `> Process exited (code: ${code})`);
    persistLogs(projectId).catch(() => {});
    running.delete(projectId);

    // Auto-restart on abnormal exit only — but skip if the user (or tray
    // "Stop all", or quit) deliberately killed the process.
    if (!intentional && code !== 0 && !watchdog.has(projectId)) {
      scheduleAutoRestart(projectId, code);
    }
    render();
  }
});

// ── CPU / RAM polling ────────────────────────────────────────────────

async function pollPerf() {
  if (!isWin) return;
  const pids = [...running.values()].map((r) => r.pid).filter(Boolean);
  if (pids.length === 0) return;

  // CIM filter: "ProcessId=A OR ProcessId=B OR ...". Joining all PIDs into
  // one PowerShell call keeps the overhead at one spawn per poll.
  const filter = pids.map((p) => `ProcessId=${p}`).join(' OR ');
  const psScript =
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    'Select-Object ProcessId, WorkingSetSize, KernelModeTime, UserModeTime | ' +
    'ConvertTo-Json -Compress';
  const encoded = utf16leBase64(psScript);
  let stats = new Map();
  try {
    const r = await Neutralino.os.execCommand(
      `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    );
    const raw = JSON.parse(r.stdOut || 'null');
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const row of arr) {
      if (!row || !row.ProcessId) continue;
      stats.set(Number(row.ProcessId), {
        mem: Number(row.WorkingSetSize) || 0,
        cpuTicks: (Number(row.KernelModeTime) || 0) + (Number(row.UserModeTime) || 0),
      });
    }
  } catch { /* skip this tick */ }

  const now = Date.now();
  let changed = false;
  for (const [id, r] of running.entries()) {
    const s = stats.get(r.pid);
    if (!s) continue;
    // CPU % from delta in 100ns ticks between polls, normalized by elapsed wall time.
    if (r.lastCpuTicks != null && r.lastCpuAt) {
      const dTicks = s.cpuTicks - r.lastCpuTicks;
      const dMs = now - r.lastCpuAt;
      const cpu = dMs > 0 ? Math.min(100, (dTicks / 10000) / dMs * 100) : 0;
      r.cpu = Math.round(cpu * 10) / 10;
    }
    r.mem = s.mem;
    r.lastCpuTicks = s.cpuTicks;
    r.lastCpuAt = now;
    changed = true;
  }
  if (changed) render();
}

function fmtMem(bytes) {
  if (!bytes) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

// ── System tray + window lifecycle ───────────────────────────────────

async function setupTray() {
  if (!trayEnabled) {
    try { await Neutralino.os.setTray({ icon: '', menuItems: [] }); } catch {}
    return;
  }
  try {
    await Neutralino.os.setTray({
      icon: '/resources/icon.png',
      menuItems: [
        { id: 'show', text: 'Show window' },
        { id: 'hide', text: 'Hide window' },
        { id: 'sep1', text: '-' },
        { id: 'stopAll', text: 'Stop all running' },
        { id: 'sep2', text: '-' },
        { id: 'quit', text: 'Quit' },
      ],
    });
  } catch (e) {
    console.error('Tray setup failed:', e);
  }
}

Neutralino.events.on('trayMenuItemClicked', async (evt) => {
  const id = evt?.detail?.id;
  if (id === 'show') {
    await Neutralino.window.show();
    await Neutralino.window.focus();
  } else if (id === 'hide') {
    await Neutralino.window.hide();
  } else if (id === 'stopAll') {
    for (const pid of [...running.keys()]) await killSpawned(pid);
    render();
  } else if (id === 'quit') {
    await quitApp();
  }
});

Neutralino.events.on('windowClose', async () => {
  if (trayEnabled) {
    // Minimise-to-tray: keep dev servers alive.
    await Neutralino.window.hide();
  } else {
    await quitApp();
  }
});

async function quitApp() {
  for (const id of [...running.keys()]) await killSpawned(id);
  Neutralino.app.exit();
}

async function toggleTray() {
  trayEnabled = !trayEnabled;
  await saveSettings();
  await setupTray();
  render();
}

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

// ── UI rendering ─────────────────────────────────────────────────────

function buildDetectedByFolder() {
  const map = new Map();
  for (const d of detected) if (d.folder) map.set(normalizeFolder(d.folder), d);
  return map;
}

function projectMatchesFilter(p) {
  if (!filterText) return true;
  const t = filterText.toLowerCase();
  return (
    (p.name || '').toLowerCase().includes(t) ||
    (p.folder || '').toLowerCase().includes(t) ||
    (p.command || '').toLowerCase().includes(t) ||
    String(p.port).includes(t)
  );
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
  const visibleSaved = projects.filter(projectMatchesFilter);

  if (unsavedDetected.length > 0 && !filterText) {
    list.appendChild(makeSection('Detected', unsavedDetected.length));
    for (const d of unsavedDetected) list.appendChild(renderDetected(d));
  }
  if (visibleSaved.length > 0) {
    list.appendChild(makeSection(filterText ? 'Matches' : 'Saved', visibleSaved.length));
    for (const p of visibleSaved) list.appendChild(renderSaved(p, byFolder));
  } else if (filterText) {
    const empty = document.createElement('li');
    empty.className = 'section-label';
    empty.innerHTML = '<span class="muted small">No projects match this filter.</span>';
    list.appendChild(empty);
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
  const r = running.get(p.id);
  const isRunningManaged = !!r;
  const isRunningExternal = !!ext && !isRunningManaged;
  const isRunning = isRunningManaged || isRunningExternal;
  const port = isRunningExternal ? ext.port : p.port;

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
    <div class="saved-meta"></div>
  `;
  li.querySelector('.name').textContent = p.name || '(unnamed)';
  li.querySelector('.folder').textContent = p.folder || '';
  li.querySelector('.status-text').textContent = isRunningExternal
    ? `Running · :${ext.port}`
    : isRunningManaged ? 'Running' : 'Stopped';

  const meta = li.querySelector('.saved-meta');
  if (isRunningManaged && (r.cpu != null || r.mem != null)) {
    const cpu = r.cpu != null ? `${r.cpu.toFixed(1)}% CPU` : '';
    const mem = r.mem != null ? fmtMem(r.mem) : '';
    meta.textContent = [cpu, mem].filter(Boolean).join('  ·  ');
  } else if (p.autoRestart && !isRunning) {
    meta.textContent = 'auto-restart ON';
  } else {
    meta.textContent = '';
  }

  // Quick "Open in browser" button when running.
  if (isRunning) {
    const openBtn = document.createElement('button');
    openBtn.className = 'btn-icon';
    openBtn.title = `Open http://localhost:${port}`;
    openBtn.textContent = '↗';
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Neutralino.os.open(`http://localhost:${port}`);
    });
    li.querySelector('.row').appendChild(openBtn);
  }

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
  const exited = exitedLogs.get(project.id);
  const willRestart = exited && watchdog.has(project.id);

  detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">
        <h1></h1>
        <div class="actions">
          <button class="btn small" id="d-env">.env</button>
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
        ${isRunningManaged && r.cpu != null ? `<span><b>CPU:</b> ${r.cpu.toFixed(1)}%</span>` : ''}
        ${isRunningManaged && r.mem != null ? `<span><b>RAM:</b> ${fmtMem(r.mem)}</span>` : ''}
        ${isRunning ? `<span><b>URL:</b> <a id="d-open-url">http://localhost:${displayPort}</a></span>` : ''}
        <span class="meta-toggle">
          <label class="checkbox">
            <input type="checkbox" id="d-autorestart" ${project.autoRestart ? 'checked' : ''}>
            <span>Auto-restart on crash</span>
          </label>
        </span>
        ${willRestart ? '<span class="meta-pill">Restarting…</span>' : ''}
      </div>
      <div class="log-toolbar">
        <input type="text" id="log-filter" placeholder="Filter logs…" />
        <button class="btn small" id="log-clear">Clear</button>
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

  detail.querySelector('#d-env').addEventListener('click', () => openEnvModal(project));
  detail.querySelector('#d-edit').addEventListener('click', () => openModal(project.id));
  detail.querySelector('#d-delete').addEventListener('click', () => deleteProject(project.id));
  detail.querySelector('#d-autorestart').addEventListener('change', async (e) => {
    project.autoRestart = e.target.checked;
    await saveProjects();
    render();
  });
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

  // Logs: live, or replay from exitedLogs after a stop/crash.
  const logsEl = detail.querySelector('#d-logs');
  let logText = '';
  if (isRunningManaged && r?.logs) {
    logText = r.logs.join('\n');
  } else if (isRunningExternal) {
    logText =
      '> This dev server is running externally (started outside this app).\n' +
      '> Logs are written to the terminal where it was launched.\n' +
      `> PID ${ext.pid}  ·  port ${ext.port}  ·  framework ${ext.kind}`;
  } else if (exited && exited.lines) {
    logText = exited.lines.join('\n');
  } else {
    // Try persisted logs from disk as a last resort.
    loadPersistedLogs(project.id).then((lines) => {
      if (lines && logsEl.textContent === '') {
        logsEl.textContent = lines.join('\n');
        logsEl.scrollTop = logsEl.scrollHeight;
      }
    });
  }
  logsEl.textContent = logText;
  logsEl.scrollTop = logsEl.scrollHeight;

  // Log filter — purely client-side; doesn't mutate stored logs.
  const filterInput = detail.querySelector('#log-filter');
  filterInput.addEventListener('input', () => {
    const q = filterInput.value.toLowerCase();
    if (!q) {
      logsEl.textContent = logText;
    } else {
      logsEl.textContent = logText
        .split('\n')
        .filter((line) => line.toLowerCase().includes(q))
        .join('\n');
    }
    logsEl.scrollTop = logsEl.scrollHeight;
  });
  detail.querySelector('#log-clear').addEventListener('click', () => {
    if (isRunningManaged && r) r.logs = [];
    exitedLogs.delete(project.id);
    render();
  });
}

function appendLogLineToDOM(line) {
  const logsEl = document.querySelector('#d-logs');
  if (!logsEl) return;
  const text = logsEl.textContent + (logsEl.textContent ? '\n' : '') + line;
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

// ── Add / Edit project modal ─────────────────────────────────────────

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
  $('#f-autorestart').checked = !!p?.autoRestart;
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
    autoRestart: $('#f-autorestart').checked,
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
  if (running.has(id)) {
    if (!confirm('This project is running. Stop it and delete?')) return;
    await killSpawned(id);
  } else if (!confirm('Delete this project?')) {
    return;
  }
  projects = projects.filter((p) => p.id !== id);
  if (selectedId === id) selectedId = null;
  exitedLogs.delete(id);
  await saveProjects();
  render();
}

// ── .env preview modal ──────────────────────────────────────────────

const SECRET_KEY_RE = /(secret|password|token|key|api|auth|private|signing|salt|dsn)/i;

function parseEnv(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    const isSecret = SECRET_KEY_RE.test(m[1]);
    out.push({
      key: m[1],
      value: isSecret ? '••• ' + (val.length ? `(${val.length} chars)` : 'empty') : val,
      isSecret,
    });
  }
  return out;
}

async function openEnvModal(project) {
  if (!project.folder) return;
  const candidates = ['.env', '.env.local', '.env.development', '.env.development.local'];
  let foundPath = null;
  let foundText = '';
  for (const c of candidates) {
    try {
      const text = await Neutralino.filesystem.readFile(`${project.folder}/${c}`);
      foundPath = c;
      foundText = text;
      break;
    } catch { /* try next */ }
  }
  $('#env-modal').classList.remove('hidden');
  if (!foundPath) {
    $('#env-modal-body').innerHTML =
      '<p class="muted">No <code>.env</code> file found in this project folder.</p>' +
      '<p class="muted small">Looked for: ' + candidates.join(', ') + '</p>';
    return;
  }
  const rows = parseEnv(foundText);
  if (rows.length === 0) {
    $('#env-modal-body').innerHTML =
      `<p class="muted">Found <code>${foundPath}</code> but no variables to display.</p>`;
    return;
  }
  $('#env-modal-body').innerHTML = `
    <p class="muted small">Showing <code>${foundPath}</code>. Values matching <code>secret|password|token|key|api</code> are masked.</p>
    <div class="env-table">
      ${rows.map((r) => `
        <div class="env-row${r.isSecret ? ' secret' : ''}">
          <span class="env-key"></span>
          <span class="env-val"></span>
        </div>
      `).join('')}
    </div>
  `;
  const keyEls = $('#env-modal-body').querySelectorAll('.env-key');
  const valEls = $('#env-modal-body').querySelectorAll('.env-val');
  rows.forEach((r, i) => {
    keyEls[i].textContent = r.key;
    valEls[i].textContent = r.value;
  });
}

function closeEnvModal() {
  $('#env-modal').classList.add('hidden');
}

// ── Custom framework patterns modal ─────────────────────────────────

function openPatternsModal() {
  $('#patterns-modal').classList.remove('hidden');
  renderPatternsTable();
}

function closePatternsModal() {
  $('#patterns-modal').classList.add('hidden');
}

function renderPatternsTable() {
  const body = $('#patterns-tbody');
  body.innerHTML = '';
  if (customPatterns.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="3" class="muted small" style="padding:14px;">
      No custom patterns yet. Add one to detect frameworks not in the built-in list
      (e.g. <code>fastify dev</code>, internal CLIs, etc.).
    </td>`;
    body.appendChild(tr);
    return;
  }
  for (const p of customPatterns) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono"></td>
      <td><code></code></td>
      <td><button class="btn small danger" data-id="${p.id}">Remove</button></td>
    `;
    tr.children[0].textContent = p.framework || p.name;
    tr.children[1].querySelector('code').textContent = p.regex;
    tr.children[2].querySelector('button').addEventListener('click', async () => {
      customPatterns = customPatterns.filter((x) => x.id !== p.id);
      await saveCustomPatterns();
      renderPatternsTable();
    });
    body.appendChild(tr);
  }
}

async function addPatternFromForm() {
  const framework = $('#pattern-name').value.trim();
  const regex = $('#pattern-regex').value.trim();
  if (!framework || !regex) { alert('Both fields are required.'); return; }
  try { new RegExp(regex, 'i'); }
  catch (e) { alert(`Invalid regex: ${e.message}`); return; }
  customPatterns.push({
    id: crypto.randomUUID(),
    framework,
    regex,
  });
  await saveCustomPatterns();
  $('#pattern-name').value = '';
  $('#pattern-regex').value = '';
  renderPatternsTable();
  // Re-run detection so newly-matched servers appear immediately.
  refreshDetected();
}

// ── Ports modal ──────────────────────────────────────────────────────

async function openPortsModal() {
  $('#ports-modal').classList.remove('hidden');
  await refreshPortsModal();
}

function closePortsModal() {
  $('#ports-modal').classList.add('hidden');
}

async function refreshPortsModal() {
  const rows = await getListeningPorts();
  const body = $('#ports-tbody');
  body.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td></td><td></td><td class="mono"></td>`;
    tr.children[0].textContent = r.port;
    tr.children[1].textContent = r.exe;
    tr.children[2].textContent = r.pid;
    tr.children[3].textContent = r.host;
    body.appendChild(tr);
  }
}

// ── Wire up DOM events ───────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  $('#add-btn').addEventListener('click', () => openModal(null));
  $('#ports-btn').addEventListener('click', openPortsModal);
  $('#patterns-btn').addEventListener('click', openPatternsModal);
  $('#tray-btn').addEventListener('click', toggleTray);

  $('#filter-input').addEventListener('input', (e) => {
    filterText = e.target.value;
    render();
  });

  $('#f-pick').addEventListener('click', async () => {
    const folder = await pickFolder();
    if (folder) $('#f-folder').value = folder;
  });
  $('#f-cancel').addEventListener('click', closeModal);
  $('#f-save').addEventListener('click', saveProjectFromModal);
  $('#env-close').addEventListener('click', closeEnvModal);
  $('#patterns-close').addEventListener('click', closePatternsModal);
  $('#pattern-add').addEventListener('click', addPatternFromForm);
  $('#ports-close').addEventListener('click', closePortsModal);
  $('#ports-refresh').addEventListener('click', refreshPortsModal);
});

// ── Startup ──────────────────────────────────────────────────────────

(async () => {
  try {
    const info = await Neutralino.os.getEnv('APPDATA');
    DATA_DIR = `${info}/DevServerManager`;
  } catch {
    DATA_DIR = '.';
  }

  await loadSettings();
  projects = await loadProjects();
  customPatterns = await loadCustomPatterns();

  await setupTray();
  await refreshDetected();
  render();

  setInterval(refreshDetected, POLL_MS);
  setInterval(pollPerf, PERF_POLL_MS);
  setInterval(() => {
    if (selectedId && running.has(selectedId)) render();
  }, 1000);
})();
