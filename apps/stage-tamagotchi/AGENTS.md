# stage-tamagotchi — the Electron shell

Read this before opening files here. It is 52k lines across 379 files, split
between the main process and the renderer.

## What this app owns

Windows, tray, global shortcuts, IPC contracts, and the adapters that connect the
renderer to the OS. Business logic belongs in `packages/`, not here.

- Main entry: `src/main/index.ts`
- Renderer entry: `src/renderer/main.ts`, root component `src/renderer/App.vue`
- IPC contracts: `src/shared/eventa/index.ts` (770) — every `invoke` pair lives here

## Address table

### Main process — `src/main/services/`

| Task | Path | Size |
| --- | --- | ---: |
| Window, updater, shortcuts | `services/electron/` | 2189 |
| MCP servers (spawn, list tools, call) | `services/airi/mcp-servers/index.ts` | 551 |
| Bus client (announce, heartbeat, events) | `services/airi/channel-server/index.ts` | 510 |
| Plugin host | `services/airi/plugins/index.ts` | 264 |
| Widgets and artistry bridge | `services/airi/widgets/` | 938 |
| Godot stage bridge | `services/airi/godot-stage/index.ts` | 973 |
| Home Assistant adapter | `services/airi/home-assistant/` | 282 |
| Computer use runtime | `services/airi/computer-use/` | 186 |
| IO trace hub (timings) | `services/airi/io-trace-hub/` | 177 |
| Local HTTP server | `services/airi/http-server/` | 116 |

### Renderer — `src/renderer/`

| Task | Path | Size |
| --- | --- | ---: |
| Stage page | `pages/index.vue` | 865 |
| Floating chat window | `pages/chat-floating.vue` | 545 |
| Chat input area and controls | `components/InteractiveArea.vue` | 670 |
| Screen ambient light, backdrops, window helpers | `composables/` | 3029 |
| Fullscreen and runtime diagnostics | `stores/` | 1011 |
| Bridge to trace | `bridges/` | 202 |

### Shared and build

| Task | Path |
| --- | --- |
| IPC contracts | `src/shared/eventa/index.ts` |
| MCP config file shape | `src/shared/mcp-config.ts` (243) |
| Electron Vite config | `electron.vite.config.ts` (314) |
| Packaging | `electron-builder.config.ts` (271) |

## Rules for changes here

- Renderer code never imports `node:*` or `src/main/*`. Cross that line only
  through an eventa contract in `src/shared/eventa/`.
- A new IPC call means: contract in `shared/eventa/index.ts`, handler registered
  in `src/main/index.ts`, `useElectronEventaInvoke` in the renderer.
- `src/main/services/airi/mcp-servers/index.ts` reads `userData/mcp.json`. Do not
  reuse it for a built-in service; spawn that service from its own module.
- Window and lifecycle work belongs in `services/electron/`. Keep the AI-specific
  services under `services/airi/`.
- `src/renderer/pages/index.vue` and `components/InteractiveArea.vue` are large and
  change often. Read the section before editing, do not reformat.

## Verify

```powershell
cd apps/stage-tamagotchi
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.json
```
