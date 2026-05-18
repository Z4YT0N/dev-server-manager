/**
 * Dev Server Manager — Electron main process.
 *
 * Responsibilities:
 *   - Window lifecycle
 *   - Persisted project list (read/write JSON in app's userData dir)
 *   - Spawning `npm run dev` (or any command) per project with a chosen PORT
 *   - Killing the spawned process tree on stop / app quit
 *   - Streaming stdout/stderr back to the renderer
 *   - Scanning system listening ports (netstat) so the user can see who
 *     stole 3000 even when the app didn't start it
 *
 * Security notes:
 *   - contextIsolation: true and nodeIntegration: false in the renderer.
 *     All Node access is mediated by preload.js → IPC.
 *   - The dialog file-picker is the only way the user introduces a new
 *     command working-directory. The command string is user-editable; no
 *     untrusted input is concatenated into a shell.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, exec } = require('node:child_process');
const crypto = require('node:crypto');

// ── Persistence ────────────────────────────────────────────────────────

function projectsFile() {
  return path.join(app.getPath('userData'), 'projects.json');
}

function loadProjects() {
  try {
    const text = fs.readFileSync(projectsFile(), 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveProjects(projects) {
  try {
    fs.mkdirSync(path.dirname(projectsFile()), { recursive: true });
    fs.writeFileSync(projectsFile(), JSON.stringify(projects, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to save projects:', err);
    return false;
  }
}

// ── Runtime state (in-memory, not persisted) ───────────────────────────

/**
 * Map<projectId, {
 *   pid: number,
 *   child: ChildProcess,
 *   startedAt: number,
 *   logs: string[],    // bounded to last 400 lines
 * }>
 */
const running = new Map();
const LOG_LIMIT = 400;

function runtimeStatus() {
  const status = {};
  for (const [id, r] of running.entries()) {
    status[id] = {
      pid: r.pid,
      startedAt: r.startedAt,
      logs: r.logs.slice(-200),
    };
  }
  return status;
}

// ── Window ─────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 800,
    minHeight: 540,
    title: 'Dev Server Manager',
    backgroundColor: '#f5f5f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile('index.html');
}

// ── IPC: projects CRUD ────────────────────────────────────────────────

ipcMain.handle('projects:list', () => loadProjects());

ipcMain.handle('projects:add', (_e, partial) => {
  const projects = loadProjects();
  const project = {
    id: crypto.randomUUID(),
    name: partial.name || path.basename(partial.folder || ''),
    folder: partial.folder,
    command: partial.command || 'npm run dev',
    port: Number(partial.port) || 3000,
    createdAt: Date.now(),
  };
  projects.push(project);
  saveProjects(projects);
  return project;
});

ipcMain.handle('projects:update', (_e, id, patch) => {
  const projects = loadProjects();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  projects[idx] = { ...projects[idx], ...patch };
  saveProjects(projects);
  return projects[idx];
});

ipcMain.handle('projects:delete', (_e, id, opts) => {
  const all = loadProjects();
  const target = all.find((p) => p.id === id);

  // Stop first if running
  const r = running.get(id);
  if (r) killProcessTree(r.pid);
  running.delete(id);

  // Only remember the folder when the user explicitly opts to "don't
  // re-detect" — otherwise a normal delete on an auto-added project
  // would silently block it from ever re-appearing, which is confusing.
  if (target?.folder && opts && opts.dontRedetect) {
    const ignored = loadIgnoredFolders();
    ignored.add(normalizeFolder(target.folder));
    saveIgnoredFolders(ignored);
  }

  saveProjects(all.filter((p) => p.id !== id));
  return true;
});

ipcMain.handle('projects:resetIgnored', () => {
  saveIgnoredFolders(new Set());
  return true;
});

// ── IPC: dialogs ──────────────────────────────────────────────────────

ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('shell:openFolder', (_e, folder) => {
  shell.openPath(folder);
  return true;
});

ipcMain.handle('shell:openExternal', (_e, url) => {
  shell.openExternal(url);
  return true;
});

// ── IPC: spawn / kill ─────────────────────────────────────────────────

function broadcastStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('runtime:update', runtimeStatus());
  }
}

function appendLog(id, line) {
  const r = running.get(id);
  if (!r) return;
  r.logs.push(line);
  if (r.logs.length > LOG_LIMIT) r.logs.splice(0, r.logs.length - LOG_LIMIT);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('runtime:log', { id, line });
  }
}

ipcMain.handle('proc:start', (_e, id) => {
  if (running.has(id)) return { ok: false, error: 'already running' };

  const projects = loadProjects();
  const project = projects.find((p) => p.id === id);
  if (!project) return { ok: false, error: 'project not found' };

  if (!project.folder || !fs.existsSync(project.folder)) {
    return { ok: false, error: 'folder does not exist' };
  }

  // Windows resolves bare commands like `npm` via shell only when shell:true.
  // Pass the full command string and let the shell parse it.
  const cmd = project.command || 'npm run dev';

  let child;
  try {
    child = spawn(cmd, {
      cwd: project.folder,
      env: { ...process.env, PORT: String(project.port) },
      shell: true,
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const state = {
    pid: child.pid,
    child,
    startedAt: Date.now(),
    logs: [],
  };
  running.set(id, state);

  appendLog(id, `> Started: ${cmd}`);
  appendLog(id, `  cwd: ${project.folder}`);
  appendLog(id, `  PORT: ${project.port}`);
  appendLog(id, '');

  child.stdout.on('data', (data) => {
    String(data)
      .split(/\r?\n/)
      .forEach((line) => {
        if (line) appendLog(id, line);
      });
  });
  child.stderr.on('data', (data) => {
    String(data)
      .split(/\r?\n/)
      .forEach((line) => {
        if (line) appendLog(id, line);
      });
  });
  child.on('exit', (code, signal) => {
    appendLog(id, `> Process exited (code: ${code ?? 'null'}, signal: ${signal ?? 'null'})`);
    running.delete(id);
    broadcastStatus();
  });
  child.on('error', (err) => {
    appendLog(id, `> Spawn error: ${err.message}`);
    running.delete(id);
    broadcastStatus();
  });

  broadcastStatus();
  return { ok: true, pid: child.pid };
});

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    // /T = tree (kill children), /F = force
    try {
      exec(`taskkill /pid ${pid} /T /F`, () => {});
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
}

ipcMain.handle('proc:stop', (_e, id) => {
  const r = running.get(id);
  if (!r) return { ok: false, error: 'not running' };
  appendLog(id, '> Stopping…');
  killProcessTree(r.pid);
  return { ok: true };
});

ipcMain.handle('runtime:status', () => runtimeStatus());

// ── IPC: system port scan ─────────────────────────────────────────────

/**
 * Run netstat (or its non-Windows equivalent) and parse out IPv4 LISTEN
 * sockets together with the owning PID. On Windows the output is:
 *   TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   25712
 *
 * We then resolve each PID's executable name through `tasklist`.
 */
async function getListeningPorts() {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'netstat -ano -p TCP' : 'lsof -nP -iTCP -sTCP:LISTEN';
    exec(cmd, { maxBuffer: 4 * 1024 * 1024 }, async (err, stdout) => {
      if (err || !stdout) return resolve([]);

      const rows = [];
      if (isWin) {
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
          if (!m) continue;
          const [, host, port, pid] = m;
          rows.push({ host, port: Number(port), pid: Number(pid) });
        }
        // Resolve pid → image name in one tasklist call
        const pidsCsv = [...new Set(rows.map((r) => r.pid))].join(',');
        if (pidsCsv) {
          try {
            const tasks = await new Promise((r) =>
              exec(`tasklist /FI "PID eq ${rows[0].pid}" /FO CSV /NH`, () => r(null)),
            );
            void tasks;
          } catch {
            /* fall through */
          }
          // tasklist per-PID is expensive; use one big call without filter:
          await new Promise((r) => {
            exec('tasklist /FO CSV /NH', { maxBuffer: 8 * 1024 * 1024 }, (e, out) => {
              if (!e && out) {
                const byPid = new Map();
                for (const line of out.split(/\r?\n/)) {
                  // "image","pid","session name","sess#","mem usage"
                  const fields = line.match(/^"([^"]*)","([^"]*)"/);
                  if (fields) byPid.set(Number(fields[2]), fields[1]);
                }
                for (const row of rows) {
                  row.exe = byPid.get(row.pid) || '?';
                }
              }
              r();
            });
          });
        }
      } else {
        // Best-effort macOS/Linux parsing
        for (const line of stdout.split(/\r?\n/).slice(1)) {
          const parts = line.split(/\s+/);
          if (parts.length < 9) continue;
          const exe = parts[0];
          const pid = Number(parts[1]);
          const name = parts[8] || '';
          const m = name.match(/:(\d+)$/);
          if (!m) continue;
          rows.push({ exe, pid, port: Number(m[1]), host: '?' });
        }
      }

      // Deduplicate by port (keep first)
      const seen = new Map();
      for (const r of rows) {
        const key = r.port;
        if (!seen.has(key)) seen.set(key, r);
      }
      const out = [...seen.values()].sort((a, b) => a.port - b.port);
      resolve(out);
    });
  });
}

ipcMain.handle('ports:list', () => getListeningPorts());

// ── IPC: detect already-running dev servers ───────────────────────────

/**
 * Heuristically classify a node.exe command line as a dev server.
 * Looks for the most common framework dev runners.
 */
function classifyDevCommand(cmd) {
  if (!cmd) return null;
  // Normalize backslashes so the path matchers work the same on Windows.
  const c = cmd.toLowerCase().replace(/\\/g, '/');

  // Next.js: dev server CLI OR the worker process it spawns
  // (next/dist/server/lib/start-server.js is the actual port owner)
  if (
    /\bnext\b.*\bdev\b/.test(c) ||
    /next\/dist\/server\/lib\/start-server\.js/.test(c) ||
    /next\/dist\/bin\/next/.test(c)
  )
    return 'Next.js';

  // Vite: bin/vite.js or dist/node/cli.js — exclude build/preview workers
  if (
    (/\bvite\b/.test(c) || /vite\/(bin|dist)\//.test(c)) &&
    !c.includes('vite build') &&
    !c.includes('vite preview')
  )
    return 'Vite';

  // Webpack dev server
  if (/\bwebpack-dev-server\b|\bwebpack serve\b|webpack-dev-server\/bin/.test(c))
    return 'Webpack';

  // Nuxt
  if (/\bnuxt\b.*\bdev\b/.test(c) || /nuxt\/bin\/nuxt(-cli)?\.mjs/.test(c)) return 'Nuxt';

  // Other frameworks
  if (
    /\b(remix|astro|svelte-kit|sveltekit)\b.*\bdev\b/.test(c) ||
    /(astro|@remix-run\/dev|svelte-kit)\/dist/.test(c)
  )
    return 'Framework';

  // Generic npm/pnpm/yarn run dev
  if (/\bnpm(\.cmd)?\b.*\brun\b.*\bdev\b/.test(c)) return 'npm run dev';
  if (/\bpnpm(\.cmd)?\b.*\bdev\b/.test(c)) return 'pnpm dev';
  if (/\byarn(\.cmd)?\b.*\bdev\b/.test(c)) return 'yarn dev';

  // nodemon
  if (/\bnodemon\b/.test(c)) return 'nodemon';

  return null;
}

/**
 * Pull `Name='node.exe'` processes from WMI with their command lines.
 * Returns Map<pid, commandLine>. On non-Windows, returns empty.
 *
 * Uses powershell -EncodedCommand (base64 UTF-16-LE) so the script
 * survives cmd.exe -> powershell quoting without any escaping bugs.
 */
function fetchNodeCommandLines() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(new Map());

    const psScript =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      'Select-Object ProcessId, CommandLine | ' +
      'ConvertTo-Json -Compress';

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(new Map());
        try {
          // ConvertTo-Json returns either an object (1 result) or array (n results)
          const raw = JSON.parse(stdout);
          const rows = Array.isArray(raw) ? raw : [raw];
          const map = new Map();
          for (const r of rows) {
            if (r && r.ProcessId) map.set(Number(r.ProcessId), r.CommandLine || '');
          }
          resolve(map);
        } catch {
          resolve(new Map());
        }
      },
    );
  });
}

/**
 * Cross-reference listening TCP ports with node.exe command lines.
 * Each returned row: { pid, port, kind, command, exe }.
 * Only includes rows where the command line matches a known dev-server.
 */
// Diagnostic log buffer — writes to a file in userData instead of stdout
// (Electron stdout/stderr is unreliable when launched detached and triggers
// EPIPE crashes on the main process when the pipe is broken).
const _debugLogFile = () => path.join(app.getPath('userData'), 'detect-debug.log');
function dbg(msg) {
  try {
    fs.mkdirSync(path.dirname(_debugLogFile()), { recursive: true });
    fs.appendFileSync(
      _debugLogFile(),
      `[${new Date().toISOString()}] ${msg}\n`,
    );
  } catch {
    // swallow — debug logging must never crash
  }
}

/**
 * Pull the project root from a dev-server command line.
 *
 * Windows hides process CWD without admin/native bindings — but the path
 * to `node_modules/<framework>/...` is right there in the command line,
 * and everything before `\node_modules\` IS the project root.
 */
function extractProjectFolder(cmd) {
  if (!cmd) return null;

  const candidates = [];
  // Quoted paths (paths with spaces)
  for (const m of cmd.matchAll(/"([^"]+?)[\\/]node_modules[\\/]/g)) {
    candidates.push(m[1]);
  }
  // Unquoted paths
  for (const m of cmd.matchAll(/([A-Za-z]:[\\/](?:[^"\s]+?))[\\/]node_modules[\\/]/g)) {
    candidates.push(m[1]);
  }

  for (const raw of candidates) {
    const folder = raw.trim();
    // Skip Node.js install / global npm folders — those aren't projects.
    if (/[\\/](nodejs|npm)$/i.test(folder)) continue;
    if (/[\\/]Program Files([\\/]|$)/i.test(folder) && /[\\/]nodejs([\\/]|$)/i.test(folder))
      continue;
    return folder;
  }
  return null;
}

/**
 * Best-effort: read `<folder>/package.json` and return its `name` field.
 * Returns null on any error — never throws.
 */
function readPackageName(folder) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    return typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name : null;
  } catch {
    return null;
  }
}

function normalizeFolder(folder) {
  if (!folder) return '';
  let f = folder.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') f = f.toLowerCase();
  return f;
}

// Persistent set of folders the user has explicitly deleted — auto-add
// won't re-introduce them even if their dev server is still running.
function ignoredFile() {
  return path.join(app.getPath('userData'), 'ignored-folders.json');
}
function loadIgnoredFolders() {
  try {
    const arr = JSON.parse(fs.readFileSync(ignoredFile(), 'utf8'));
    return new Set(Array.isArray(arr) ? arr.map(normalizeFolder) : []);
  } catch {
    return new Set();
  }
}
function saveIgnoredFolders(set) {
  try {
    fs.mkdirSync(path.dirname(ignoredFile()), { recursive: true });
    fs.writeFileSync(ignoredFile(), JSON.stringify([...set], null, 2), 'utf8');
  } catch {
    /* swallow */
  }
}

/**
 * Auto-add detected dev servers as saved projects. Idempotent — folder
 * already saved → skip. Folder previously deleted (in ignored set) → skip.
 */
function autoAddProjects(detected) {
  const projects = loadProjects();
  const ignored = loadIgnoredFolders();
  const existing = new Set(projects.map((p) => normalizeFolder(p.folder)));
  let changed = false;

  for (const d of detected) {
    if (!d.folder) continue;
    const key = normalizeFolder(d.folder);
    if (existing.has(key) || ignored.has(key)) continue;

    projects.push({
      id: crypto.randomUUID(),
      name: d.name || path.basename(d.folder) || 'project',
      folder: d.folder,
      command: 'npm run dev',
      port: d.port,
      createdAt: Date.now(),
      autoAdded: true,
    });
    existing.add(key);
    changed = true;
  }

  if (changed) saveProjects(projects);
  return changed;
}

async function detectDevServers() {
  const [ports, cmds] = await Promise.all([
    getListeningPorts(),
    fetchNodeCommandLines(),
  ]);

  dbg(`ports=${ports.length}, cmdlines=${cmds.size}`);
  if (ports.length > 0) {
    dbg(`first few ports: ${JSON.stringify(ports.slice(0, 5))}`);
  }

  const out = [];
  for (const p of ports) {
    if (!p.pid) continue;
    if (!/node/i.test(p.exe || '')) continue;
    const cmd = cmds.get(p.pid);
    if (!cmd) {
      dbg(`port ${p.port} pid ${p.pid}: node, but no cmdline in WMI map`);
      continue;
    }
    const kind = classifyDevCommand(cmd);
    if (!kind) {
      dbg(`port ${p.port} pid ${p.pid}: did NOT classify — "${cmd.slice(0, 140)}"`);
      continue;
    }
    const folder = extractProjectFolder(cmd);
    const name = folder ? readPackageName(folder) : null;
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
  dbg(`matched=${out.length}`);

  // Auto-add any folders we haven't seen before
  try {
    autoAddProjects(out);
  } catch (err) {
    dbg(`autoAddProjects failed: ${err && err.message}`);
  }

  // Deduplicate by pid — a single dev server might open multiple ports
  // (Next does 3000 + websocket). Keep the lowest port for each pid.
  const seen = new Map();
  for (const row of out) {
    const existing = seen.get(row.pid);
    if (!existing || row.port < existing.port) seen.set(row.pid, row);
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

ipcMain.handle('proc:detect', () => detectDevServers());

/**
 * Kill an external process (not one we spawned). Same primitive used
 * for our own children — taskkill /T /F on Windows.
 */
ipcMain.handle('proc:killPid', (_e, pid) => {
  if (!pid || typeof pid !== 'number') return { ok: false, error: 'bad pid' };
  killProcessTree(pid);
  return { ok: true };
});

// ── App lifecycle ─────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  // Periodic runtime broadcast in case a child died without us catching it
  setInterval(broadcastStatus, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Stop everything we started before quitting
  for (const [, r] of running.entries()) killProcessTree(r.pid);
  running.clear();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const [, r] of running.entries()) killProcessTree(r.pid);
  running.clear();
});
