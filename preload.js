/**
 * Preload script — runs in an isolated context with Node access, exposes
 * a minimal surface to window.devManager in the renderer.
 *
 * Keeping this small protects the renderer (which loads local files but
 * runs untrusted strings from project package.json output) from being
 * able to call arbitrary Node APIs.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('devManager', {
  // Projects
  listProjects:  () => ipcRenderer.invoke('projects:list'),
  addProject:    (data) => ipcRenderer.invoke('projects:add', data),
  updateProject: (id, patch) => ipcRenderer.invoke('projects:update', id, patch),
  deleteProject: (id, opts) => ipcRenderer.invoke('projects:delete', id, opts),
  resetIgnored:  () => ipcRenderer.invoke('projects:resetIgnored'),

  // Dialogs / shell
  pickFolder:    () => ipcRenderer.invoke('dialog:pickFolder'),
  openFolder:    (folder) => ipcRenderer.invoke('shell:openFolder', folder),
  openUrl:       (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Process control
  startProject:  (id) => ipcRenderer.invoke('proc:start', id),
  stopProject:   (id) => ipcRenderer.invoke('proc:stop', id),
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),

  // System ports
  listPorts:     () => ipcRenderer.invoke('ports:list'),

  // Auto-detect external dev servers (cross-ref netstat + WMI cmd lines)
  detectDevServers: () => ipcRenderer.invoke('proc:detect'),
  killPid:          (pid) => ipcRenderer.invoke('proc:killPid', pid),

  // Streaming events
  onRuntimeUpdate: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('runtime:update', handler);
    return () => ipcRenderer.removeListener('runtime:update', handler);
  },
  onLog: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('runtime:log', handler);
    return () => ipcRenderer.removeListener('runtime:log', handler);
  },
});
