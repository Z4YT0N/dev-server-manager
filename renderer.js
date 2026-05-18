/**
 * Renderer — runs in the BrowserWindow, talks to main via window.devManager
 * (exposed by preload.js). No Node access here directly.
 */

const $ = (sel) => document.querySelector(sel);

/** Normalize a folder path so saved/detected comparisons match (Windows
 *  is case-insensitive, slashes mixed, sometimes trailing). */
function normalizeFolder(folder) {
  if (!folder) return '';
  return folder.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Build a Map<normalizedFolder, detectedEntry> so we can ask "is this
 *  saved project's folder currently running externally?". */
function buildDetectedByFolder() {
  const map = new Map();
  for (const d of detected) {
    if (d.folder) map.set(normalizeFolder(d.folder), d);
  }
  return map;
}

// In-memory mirror of state for the UI
let projects = [];      // persisted list, refreshed on demand
let runtime = {};       // pid/startedAt/logs per project id
let detected = [];      // external dev servers we found running
let selectedId = null;  // currently focused project
let editingId = null;   // id of project being edited (null = adding)

// ── Boot ──────────────────────────────────────────────────────────────

(async function init() {
  await refreshProjects();
  runtime = await window.devManager.runtimeStatus();
  render();

  // Live updates from main
  window.devManager.onRuntimeUpdate((status) => {
    runtime = status;
    render();
  });
  window.devManager.onLog(({ id, line }) => {
    if (id === selectedId) appendLogLine(line);
  });

  bindGlobalUI();

  // Detection runs immediately then on a 5s heartbeat. We re-render
  // whenever the set changes so the sidebar feels live.
  refreshDetected();
  setInterval(refreshDetected, 5000);
})();

async function refreshDetected() {
  try {
    const next = await window.devManager.detectDevServers();
    // Auto-add on the main process may have inserted new saved entries.
    // Re-fetch the saved list every cycle so the sidebar mirrors disk.
    const freshProjects = await window.devManager.listProjects();
    const detectedChanged = JSON.stringify(next) !== JSON.stringify(detected);
    const projectsChanged = JSON.stringify(freshProjects) !== JSON.stringify(projects);
    if (detectedChanged || projectsChanged) {
      detected = next;
      projects = freshProjects;
      render();
    }
  } catch (err) {
    console.error('Detect failed:', err);
  }
}

async function refreshProjects() {
  projects = await window.devManager.listProjects();
}

// ── Global UI handlers ────────────────────────────────────────────────

function bindGlobalUI() {
  $('#add-btn').addEventListener('click', () => openModal(null));
  $('#ports-btn').addEventListener('click', openPortsModal);

  // Modal — add / edit
  $('#f-cancel').addEventListener('click', closeModal);
  $('#f-save').addEventListener('click', saveProject);
  $('#f-pick').addEventListener('click', async () => {
    const folder = await window.devManager.pickFolder();
    if (folder) {
      $('#f-folder').value = folder;
      if (!$('#f-name').value) {
        $('#f-name').value = folder.split(/[\\/]/).pop();
      }
    }
  });

  // Modal — ports
  $('#ports-close').addEventListener('click', closePortsModal);
  $('#ports-refresh').addEventListener('click', refreshPortsList);
}

// ── Sidebar render ────────────────────────────────────────────────────

function render() {
  $('#project-count').textContent = String(projects.length);

  const list = $('#project-list');
  list.innerHTML = '';

  // Build a folder → detected lookup so saved entries can know whether
  // they're currently running externally.
  const detectedByFolder = buildDetectedByFolder();
  const savedFolders = new Set(projects.map((p) => normalizeFolder(p.folder)));

  // 1. Detected dev servers we DON'T already have a saved entry for.
  //    Anything already in Saved is shown over there with proper status,
  //    so duplicating it here would be noise.
  const unsavedDetected = detected.filter(
    (d) => !d.folder || !savedFolders.has(normalizeFolder(d.folder)),
  );
  if (unsavedDetected.length > 0) {
    const heading = document.createElement('li');
    heading.className = 'section-label';
    heading.innerHTML = `<span>Detected</span><span class="muted">${unsavedDetected.length}</span>`;
    list.appendChild(heading);

    for (const d of unsavedDetected) {
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
      // Prefer the project name (from package.json) when we have it, else folder basename
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
        window.devManager.openUrl(`http://localhost:${d.port}`);
      });
      li.querySelector('[data-act="stop"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Kill PID ${d.pid} on port ${d.port}?`)) return;
        await window.devManager.killPid(d.pid);
        await refreshDetected();
      });
      list.appendChild(li);
    }

  }

  // 2. Saved projects — always shown when there's anything to show.
  if (projects.length > 0) {
    const sep = document.createElement('li');
    sep.className = 'section-label';
    sep.innerHTML = `<span>Saved</span><span class="muted">${projects.length}</span>`;
    list.appendChild(sep);

    for (const p of projects) {
      // Three running states: managed (we spawned it), external (someone
      // else spawned it but its folder matches), or stopped.
      const ext = p.folder ? detectedByFolder.get(normalizeFolder(p.folder)) : null;
      const isRunningManaged = !!runtime[p.id];
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
        : isRunningManaged
          ? 'Running'
          : 'Stopped';
      li.addEventListener('click', () => {
        selectedId = p.id;
        render();
      });
      list.appendChild(li);
    }
  }

  renderDetail();
}

// ── Detail render ─────────────────────────────────────────────────────

function renderDetail() {
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

  // Resolve running state — three branches as in the sidebar.
  const r = runtime[project.id];
  const ext = project.folder
    ? buildDetectedByFolder().get(normalizeFolder(project.folder))
    : null;
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
  const openFolder = detail.querySelector('#d-open-folder');
  openFolder.textContent = project.folder;
  openFolder.addEventListener('click', () => window.devManager.openFolder(project.folder));

  if (isRunning) {
    const openUrl = detail.querySelector('#d-open-url');
    openUrl.addEventListener('click', () =>
      window.devManager.openUrl(`http://localhost:${project.port}`),
    );
  }

  // Action handlers
  detail.querySelector('#d-edit').addEventListener('click', () => openModal(project.id));
  detail.querySelector('#d-delete').addEventListener('click', () => deleteProject(project.id));
  if (isRunning) {
    detail.querySelector('#d-stop').addEventListener('click', async () => {
      if (isRunningExternal) {
        // External process — kill via the PID we detected.
        if (!confirm(`Stop external process PID ${ext.pid} on port ${ext.port}?`)) return;
        await window.devManager.killPid(ext.pid);
        await refreshDetected();
      } else {
        stopProject(project.id);
      }
    });
  } else {
    detail.querySelector('#d-start').addEventListener('click', () => startProject(project.id));
  }

  // Logs — only meaningful for managed processes. For external ones we
  // never captured the stdout, so leave a hint.
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

function appendLogLine(line) {
  const logsEl = document.querySelector('#d-logs');
  if (!logsEl) return;
  // Bound DOM size
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

// ── Modal — add / edit ───────────────────────────────────────────────

function openModal(id) {
  editingId = id;
  const project = projects.find((p) => p.id === id);
  $('#modal-title').textContent = project ? 'Edit Project' : 'Add Project';
  $('#f-name').value = project?.name ?? '';
  $('#f-folder').value = project?.folder ?? '';
  $('#f-command').value = project?.command ?? 'npm run dev';
  $('#f-port').value = project?.port ?? 3000;
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
  editingId = null;
}

async function saveProject() {
  const data = {
    name: $('#f-name').value.trim(),
    folder: $('#f-folder').value.trim(),
    command: $('#f-command').value.trim() || 'npm run dev',
    port: Number($('#f-port').value) || 3000,
  };
  if (!data.folder) {
    alert('Please choose a folder.');
    return;
  }
  if (!data.name) {
    data.name = data.folder.split(/[\\/]/).pop() || 'project';
  }

  if (editingId) {
    await window.devManager.updateProject(editingId, data);
  } else {
    const created = await window.devManager.addProject(data);
    selectedId = created.id;
  }
  await refreshProjects();
  closeModal();
  render();
}

// ── Start / stop / delete ────────────────────────────────────────────

async function startProject(id) {
  const res = await window.devManager.startProject(id);
  if (!res.ok) alert('Start failed: ' + res.error);
  runtime = await window.devManager.runtimeStatus();
  render();
}

async function stopProject(id) {
  const res = await window.devManager.stopProject(id);
  if (!res.ok) alert('Stop failed: ' + res.error);
}

async function deleteProject(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) return;
  if (!confirm(`Remove "${project.name}"? Will stop it if running.`)) return;
  await window.devManager.deleteProject(id);
  if (selectedId === id) selectedId = null;
  await refreshProjects();
  runtime = await window.devManager.runtimeStatus();
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
  const rows = await window.devManager.listPorts();
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">No listening TCP ports found.</td></tr>';
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b></b></td>
      <td></td>
      <td></td>
      <td></td>
    `;
    tr.children[0].querySelector('b').textContent = r.port;
    tr.children[1].textContent = r.exe || '?';
    tr.children[2].textContent = r.pid;
    tr.children[3].textContent = r.host || '';
    tbody.appendChild(tr);
  }
}
