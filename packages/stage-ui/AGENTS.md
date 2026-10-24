# stage-ui — shared business layer

Read this before opening files here. It is 91k lines across 744 files; the table
below is the fast path.

## What this package owns

Stores, composables, tools, and business components shared by `apps/stage-web`
and `apps/stage-tamagotchi`. It holds no window code and no native calls.

- Entry: `src/index.ts`
- Consumed as: `@proj-airi/stage-ui/*` (subpath imports, for example `stores/chat`)

## Address table

| Task | Path | Size |
| --- | --- | ---: |
| Chat orchestration and send path | `src/stores/chat.ts` | 1607 |
| Session messages, persistence | `src/stores/chat/session-store.ts` | 1899 |
| Runtime context registry | `src/stores/chat/context-store.ts` | 88 |
| Long-term memory (index + entries) | `src/stores/memory.ts` | 170 |
| Memory tools for the model | `src/tools/memory.ts` | 94 |
| Card data (`airi-card`) | `src/stores/modules/airi-card.ts` | 1520 |
| Speech input and output | `src/stores/modules/speech.ts` | 760 |
| Hearing (STT) | `src/stores/modules/hearing.ts` | 664 |
| Provider registry and config | `src/stores/providers/provider.ts` | 1196 |
| Voice pipeline | `src/stores/voice.ts` | 583 |
| Model providers list UI data | `src/stores/display-models.ts` | 570 |
| Electron screen and window helpers | `src/composables/` | 5605 |
| Tool definitions given to the model | `src/tools/` | 1559 |
| Local persistence (IDB) | `src/database/repos/` | — |
| Analytics milestones | `src/libs/product-signals/` | — |
| Settings stores (stage model, audio) | `src/stores/settings/` | 676 |

## Rules for changes here

- `src/stores/chat.ts` is in the refactor guard's frozen list. A change needs
  `node tools/refactor-guard/guard.mjs check --ack` and an entry in
  `patches/divergence.json`.
- A `synced` Pinia store carries cross-window state. Read
  `.agents/skills/enforce-rules-for-pinia-synced/SKILL.md` before adding one.
- `memory.indexFor()` must stay synchronous: `stores/chat.ts` composes it into the
  system prompt without awaiting. A remote backend mirrors writes instead.
- Stores never import from `apps/`. Shared code belongs in `packages/`.
- No `any`. Use Valibot for schemas; the package already depends on it.

## Verify

```powershell
cd packages/stage-ui
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit          # needs NODE_PATH, see README
node ../../node_modules/vitest/vitest.mjs run src/stores/memory
```
