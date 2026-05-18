# Dev Server Manager

A **1.7 MB** desktop app for managing dev servers across multiple projects. Auto-detects what's already running, saves your projects, starts/stops with a click, kills the whole process tree on stop. Built on Neutralinojs (uses your system's WebView2 — no Chromium bundled).

Built because keeping track of `next dev` on 3000 here, `vite` on 5173 there, and `npm run dev` somewhere else from a sea of terminal tabs is awful.

## Why this exists

Most dev-server-manager-style tools are 70+ MB Electron apps that eat 200 MB of RAM at idle. This one is **1.6 MB on disk + ~26 MB of RAM** because it uses the WebView2 already on your machine, not its own bundled browser.

| | This app | Typical Electron equivalent |
|---|---|---|
| Disk | ~1.7 MB (unzipped) | 70-300 MB |
| RAM at idle | ~26 MB | 120-300 MB |
| Dependencies | None at runtime | Bundled Chromium + Node |

## Features

- **Auto-detect running dev servers** — scans listening TCP ports, cross-references with `node.exe` command lines via WMI on Windows, classifies the framework (Next.js / Vite / Webpack / Nuxt / Remix / Astro / nodemon / `npm run dev` / ...), extracts the project folder from the `node_modules` path, reads `package.json` for the name
- **Auto-add detected projects** — new dev servers your terminal started show up as saved projects automatically
- **Running (external) state** — saved entries cross-reference detection; if a folder is currently running externally, it shows as Running with the live PID + port
- **Per-project Start / Stop / Edit / Delete** — Stop kills the whole process tree (works for both managed and external processes)
- **Live stdout/stderr panel** — for app-managed processes, last 200 lines kept
- **Listening Ports panel** — every TCP LISTEN socket on the machine with the owning process name
- **Auto-cleanup on quit** — every dev server the app started gets killed too
- **Native Windows look** — Segoe UI, light grey chrome, blue accent

## Download

Grab `DevServerManager-win-x64-0.1.0.zip` from the [Releases page](https://github.com/Z4YT0N/dev-server-manager/releases). Extract anywhere, double-click `DevServerManager.exe`.

> Requires **WebView2** on Windows. Pre-installed on Windows 10 (April 2018) and later. If you're on something older, install the [Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

## Run from source

```bash
git clone https://github.com/Z4YT0N/dev-server-manager
cd dev-server-manager
npm install
npx neu update    # downloads ~2 MB of platform binaries
npm start
```

## Build the release

```bash
npm run build
```

Produces `dist/DevServerManager/DevServerManager-win_x64.exe` + `dist/DevServerManager/resources.neu`. Both files must ship together.

## Architecture

Tiny by design. There is **no separate main process** — everything runs in the renderer (`resources/renderer.js`), which gets direct access to OS primitives via Neutralino's API:

```js
await Neutralino.os.execCommand('netstat -ano -p TCP');     // shell out
await Neutralino.os.spawnProcess('npm run dev', cwd);       // spawn child
await Neutralino.filesystem.readFile(`${dir}/projects.json`); // persistence
await Neutralino.os.showFolderDialog('Pick project folder');  // file picker
```

No IPC bridge, no preload script, no `nodeIntegration` config dance. The whole "backend" is ~600 lines of plain JavaScript.

## How auto-detection works

When `next dev`, `vite`, etc. run, the **process actually bound to the port** is usually a worker like `node ...next/dist/server/lib/start-server.js`. The app:

1. Lists listening TCP ports via `netstat -ano -p TCP`
2. Resolves each PID to its image name via `tasklist /FO CSV`
3. For `node.exe` PIDs, pulls command lines via `Get-CimInstance Win32_Process` (PowerShell with `-EncodedCommand` so quoting survives)
4. Classifies the command line against framework patterns
5. Extracts the project root from the path before `\node_modules\`
6. Reads the project's `package.json` for a display name

Windows hides process CWD without admin/native bindings, so the path-extraction route is the reliable way. Works for any framework that loads from `node_modules`.

## Troubleshooting

### My dev server isn't being detected

The classifier looks for these patterns in the process command line:

- `next dev` / `next/dist/server/lib/start-server.js` / `next/dist/bin/next` → Next.js
- `vite` / `vite/bin/vite.js` → Vite
- `webpack-dev-server` / `webpack serve` → Webpack
- `nuxt dev` / `nuxt/bin/nuxt-cli.mjs` → Nuxt
- `(remix|astro|svelte-kit) dev` → Framework
- `npm run dev` / `pnpm dev` / `yarn dev`
- `nodemon`

If your framework isn't here, open an issue or PR — it's a 3-line regex add in `resources/renderer.js` (`classifyDevCommand`).

### App won't start (`Failed to launch WebView2`)

Install the [Evergreen WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/). Required on very old Windows builds.

## Contributing

PRs welcome. Anything that's a framework-detection gap (a new dev server type, a new command-line pattern) is especially appreciated.

The interesting code is in two files:

- `resources/renderer.js` — everything: persistence, detection, spawn/kill, UI
- `neutralino.config.json` — window settings, native API allowlist

If you find a way to read a process's actual CWD on Windows without admin/native bindings, that would be a huge upgrade — drop it in `extractProjectFolder` in `resources/renderer.js`.

## License

MIT — see [LICENSE](./LICENSE).
