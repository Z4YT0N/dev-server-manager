# Dev Server Manager

A tiny Electron desktop app for **managing dev servers across multiple projects**. Save your projects once (folder + command + port), then start/stop them with a click. The app auto-detects dev servers already running on your machine and offers them up as projects automatically.

Built because keeping track of `next dev` on port 3000 here, `vite` on 5173 there, and `npm run dev` somewhere else from a sea of terminal tabs is awful.

## Features

- **Saved projects** — add a folder + command + default port; persisted across launches
- **Auto-detect running dev servers** — scans listening TCP ports, cross-references with `node.exe` command lines (via WMI on Windows), figures out which framework is running (Next.js, Vite, Webpack, Nuxt, Remix, Astro, nodemon, `npm run dev`, etc.), and extracts the project folder from the command-line path
- **Auto-add detected projects** — new dev servers your terminal started show up as saved projects automatically, with the right name from `package.json`, folder, port, and framework
- **Running (external) state** — when a saved project's folder matches a currently-detected dev server, it shows as Running with the live PID + port, even if you didn't start it through the app
- **Per-project Start / Stop / Edit / Delete** — Stop kills the whole process tree (works for both managed and external processes)
- **Live logs** — stdout/stderr for app-managed processes, captured into a terminal-like panel (last 200 lines)
- **Listening Ports panel** — every TCP LISTEN socket on the machine with the owning process name; useful for finding port thieves
- **Open folder / open URL** — one click from the project entry
- **Auto-cleanup on quit** — every dev server the app started gets killed when the app closes; no orphan node processes
- **Native Windows look** — Segoe UI, light grey chrome, blue accent

## Download

Grab the latest `Dev-Server-Manager-Setup-x.y.z.exe` from the [Releases page](https://github.com/Z4YT0N/dev-server-manager/releases) and install.

## Run from source

```bash
git clone https://github.com/Z4YT0N/dev-server-manager
cd dev-server-manager
npm install
npm start
```

That spawns the Electron window. Click **+ Add Project**, pick a folder, set the command (default `npm run dev`) and port — done.

## Build a Windows installer

```bash
npm run dist
```

Produces `dist/Dev Server Manager Setup x.y.z.exe`.

## How auto-detection works

When `next dev`, `vite`, `webpack-dev-server`, etc. run, the **process actually bound to the port** is usually a worker like `node ...next/dist/server/lib/start-server.js`. The app:

1. Lists listening TCP ports via `netstat -ano -p TCP`
2. Resolves each owning PID to its image name via `tasklist`
3. For `node.exe` PIDs, pulls the command line via `Get-CimInstance Win32_Process` (PowerShell + `-EncodedCommand`, so quoting survives)
4. Classifies the command line against framework patterns (Next.js worker path, Vite path, Webpack serve, etc.)
5. Extracts the project root from the path before `\node_modules\`
6. Reads the project's `package.json` to get a display name

Windows doesn't expose a process's CWD without admin/native bindings, so the `\node_modules\` path-based extraction is the reliable fallback. Works for every framework that loads from `node_modules`.

## Troubleshooting

### "Cannot read properties of undefined (reading 'handle')" on start

You have `ELECTRON_RUN_AS_NODE=1` set as a global environment variable (some tools set this to use Electron's bundled Node as a plain Node runtime). With that flag set, Electron skips loading the main-process API entirely and `require('electron')` returns a string instead of the API object.

`npm start` already clears the variable inline. If you launch the binary directly, clear it first:

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE
```

To remove it permanently: Windows → Settings → System → About → Advanced system settings → Environment Variables → delete `ELECTRON_RUN_AS_NODE`.

### My dev server isn't being detected

The classifier looks for these patterns in the process command line:

- `next dev` or `next/dist/server/lib/start-server.js` or `next/dist/bin/next` → Next.js
- `vite` (in PATH or `vite/bin/vite.js`) → Vite
- `webpack-dev-server` / `webpack serve` → Webpack
- `nuxt dev` / `nuxt/bin/nuxt-cli.mjs` → Nuxt
- `(remix|astro|svelte-kit) dev` → Framework
- `npm run dev` / `pnpm dev` / `yarn dev` → npm run dev
- `nodemon` → nodemon

If your framework isn't here, open an issue or PR — it's a 3-line regex add in `main.js`.

### How do I stop auto-add for a specific folder?

When you click **Delete** on a saved project, hold Shift (TODO — currently the v0.1 build always re-detects). Workaround: keep the auto-added entry but use the app's Stop button when you don't want it running.

## Contributing

PRs welcome. Anything that's a framework-detection gap (a new dev server type, a new command-line pattern) is especially appreciated — that's the part of the codebase most likely to need expanding.

Three files do most of the work:

- `main.js` — Electron main process: spawn/kill, persist projects.json, port scan, command-line classifier, auto-add
- `preload.js` — secure IPC bridge to the renderer (`window.devManager`)
- `renderer.js` + `index.html` + `styles.css` — UI (vanilla JS, no framework)

If you find a way to read a process's actual CWD on Windows without admin/native bindings, that would be a huge upgrade — drop it in `extractProjectFolder` in `main.js`.

## License

MIT — see [LICENSE](./LICENSE).
