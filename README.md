# Dev Server Manager

**Stop losing track of your dev servers.**

https://github.com/Z4YT0N/dev-server-manager/releases/download/v0.1.0/dev-server-manager-demo.mp4

If you're vibe-coding five things at once, juggling `next dev` here, `vite` there, an `npm run dev` you started yesterday and forgot about — this is for you.

> Made for the kind of developer who has 12 terminal tabs open, can't remember which one is the dashboard, and just `taskkill`'d everything to start over. Again.

---

## The problem

You start a project. `next dev` on 3000. ✓

You jump to a second one. `vite` on 5173. ✓

You pop into your friend's repo for five minutes. Port 3000 in use. You don't remember which terminal launched it. You kill node from Task Manager. Now your first dashboard is gone too. You sigh and re-run everything.

This happens to you weekly. Sometimes daily.

## What this does

One window. Every dev server on your machine, listed.

- **Auto-detects what's already running.** Open the app — it instantly sees the `next dev` on 3000, the `vite` on 5173, the `npm run dev` you started in the wrong folder this morning. It tells you which project each one belongs to (reads `package.json` for the real name).
- **Saves your projects** so they're a click away. Folder, command, default port — set once, remembered.
- **One-click start / stop.** Stop kills the whole process tree, including the workers Next.js leaves behind. No more zombies hogging ports.
- **"Running (external)" cross-reference.** A server you started in a terminal still shows up under its saved project — running, live PID, live port. Stop it from inside the app too.
- **Shows you who stole your port.** "Listening Ports" panel lists every TCP socket on the machine + the process holding it. The `netstat | grep` ritual ends.
- **Auto-cleanup on close.** Quit the app, every dev server it started gets killed too. Never leak again.

## Why it's 1.7 MB

Because it should be.

A tool that just lists processes and clicks buttons doesn't need to bundle Chromium. This one uses the WebView2 already on every Windows 10/11 machine, so the entire app is **1.6 MB on disk** and sits at **~26 MB of RAM** at idle. Open it, leave it open, forget it's there.

| | Dev Server Manager | Typical Electron tool |
|---|---|---|
| Download size | **0.8 MB** zipped | 70-300 MB |
| Disk after extract | **1.7 MB** | 70-300 MB |
| RAM at idle | **~26 MB** | 120-300 MB |
| Bundled browser | None — uses your WebView2 | Yes (Chromium) |
| Startup time | Instant | 2-4 seconds |

Your laptop fan stays quiet.

---

## Download

**[v0.1.0 — Windows](https://github.com/Z4YT0N/dev-server-manager/releases/latest)** • 800 KB zip

Extract anywhere. Double-click `DevServerManager.exe`. No installer, no admin, fully portable. Drop the folder on a USB stick if you want.

> Needs WebView2, pre-installed on Windows 10 (April 2018) and later. On older Windows: install the [Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) first.

## What it auto-detects

Out of the box: **Next.js, Vite, Webpack, Nuxt, Remix, Astro, SvelteKit, `npm run dev`, `pnpm dev`, `yarn dev`, nodemon.**

Missing your favorite? It's a 3-line regex add in `resources/renderer.js` (`classifyDevCommand`). Open an issue with the framework's command line and we'll add it.

---

## Run from source

```bash
git clone https://github.com/Z4YT0N/dev-server-manager
cd dev-server-manager
npm install
npx neu update    # downloads ~2 MB of Neutralinojs binaries
npm start
```

## Build the release

```bash
npm run build
```

Produces `dist/DevServerManager/DevServerManager-win_x64.exe` + `resources.neu`. Both ship together.

---

## How auto-detection works under the hood

When `next dev` / `vite` / etc. run, the **process actually bound to your port** is usually a worker like `node ...next/dist/server/lib/start-server.js` — not the CLI you typed. The app:

1. Lists listening TCP via `netstat -ano -p TCP`
2. Resolves PIDs to image names via `tasklist /FO CSV /NH`
3. For each `node.exe` PID, fetches the command line via `Get-CimInstance Win32_Process` (PowerShell `-EncodedCommand` so cmd.exe quoting can't corrupt it)
4. Matches the command line against framework patterns
5. Extracts the project root from the path that appears before `\node_modules\`
6. Reads the project's `package.json` to get a real display name

Windows hides a process's CWD without admin/native bindings, so the path-extraction approach is the reliable fallback. Works for any framework that loads from `node_modules`.

## Architecture (the short version)

No separate main process. The whole app is one ~700-line file (`resources/renderer.js`) calling Neutralinojs APIs directly:

```js
await Neutralino.os.execCommand('netstat -ano -p TCP');
await Neutralino.os.spawnProcess('npm run dev', cwd);
await Neutralino.filesystem.readFile(`${dir}/projects.json`);
await Neutralino.os.showFolderDialog('Pick project folder');
```

No IPC bridge, no preload, no `nodeIntegration` config to get wrong.

---

## Contributing

PRs welcome. Especially appreciated:

- **New framework patterns** — the regex set in `classifyDevCommand` is the most likely-to-need-expanding part of the code
- **Linux / macOS detection** — the binaries build cross-platform, but the detector currently assumes Windows tooling (`netstat -ano`, `tasklist`, WMI). Porting `getListeningPorts` and `fetchNodeCommandLines` to `lsof` + `ps -ef` would unlock Mac/Linux
- **Reading process CWD on Windows without admin** — if you know a way, this would be the single biggest accuracy upgrade

The interesting files:

- `resources/renderer.js` — everything: detection, classifier, spawn/kill, UI
- `neutralino.config.json` — window settings, native API allowlist

## Troubleshooting

**SmartScreen warning on first run.** The exe is unsigned (code-signing certs cost money for an unfunded side project). Click **More info → Run anyway**. The source is right here, audit away.

**App won't start.** Most likely WebView2 isn't installed — grab the [Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/). Pre-installed on Windows 10+ since April 2018, so this only matters on very old machines.

**My dev server isn't being detected.** Either the framework isn't in the classifier yet (open an issue with the command line), or it doesn't go through `node.exe` (e.g., Python's `runserver` — out of scope).

**Detected server is "Stopped" in Saved.** This means the folder paths don't match. Open the saved entry's Edit dialog and verify the folder is the project root (the one with `package.json`), not a subfolder.

---

## License

MIT.

Built because nobody else had built it small enough.
