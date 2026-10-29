# Castalia plugin

The AIRI integration code in this package is licensed under the GNU Affero
General Public License, version 3 or any later version. The adapted Castalia
emotion and agent-state code keeps its original MIT License and the `ehwin`
copyright notice. See [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) for the
file list and the full MIT text.

This package is the integration boundary for Castalia inside AIRI. The domain
logic and persisted state live here; AIRI's settings page and chat runtime use
only its exported API from `src/index.ts`. Keep Castalia-specific behavior in
this package so AIRI shell updates do not overwrite or scatter it.

The current embedded slice includes Castalia's per-character durable named
memories in SQLite, plus VAD emotion calculations and temporary mood, desire,
energy, and tsundere settings. AIRI's existing memory index, tools, and settings
use the durable repository; local entries migrate on first connection without
discarding newer local edits. Emotional self-state remains in browser storage,
and disabling that part of the plugin removes its prompt context and tools.

The emotion model and mood lifecycle are an integration copy based on
`Castalia-Anima/src/emotion.ts` and `agentState.ts`. The source project remains
untouched; update this copy deliberately and keep the two projects independently
buildable. The mood aggregate uses a zero-state prior so one old mood event can
fade toward neutral instead of remaining constant after normalization.

Castalia's vector retrieval, automatic processing, and reflection engine are
not yet embedded. This package does not start the standalone Castalia MCP
server. SQLite is owned by AIRI's Electron main process; web builds continue to
use their local browser store until they have a durable host adapter.

When changing this package, run its unit tests and typecheck, then verify the
chat integration and settings page:

```sh
pnpm --filter @proj-airi/castalia-plugin test
pnpm --filter @proj-airi/castalia-plugin typecheck
pnpm --filter @proj-airi/stage-ui exec vitest run src/stores/chat.contract.test.ts src/tools/castalia.test.ts
pnpm --filter @proj-airi/stage-ui typecheck
pnpm --filter @proj-airi/stage-pages typecheck
```
