# Game memory

The bot keeps what a later session must still know in a Castalia memory bank, not in the prompt. This page gives the area, the write rules, and the two bot tools that use it.

## Where it lives

| Item | Value |
| --- | --- |
| Bank | `D:/castalia/memory-banks/game` (its own library, not the persona bank) |
| Project | `minecraft` (one project per game, so a second game adds a project, not a bank) |
| Files | `D:/castalia/memory-banks/game/minecraft/<memType>/memory.sqlite` |
| Bridge id | `game-bridge` in `D:/castalia/run/Castalia/scripts/castalia.config.json` |
| Endpoint | `http://127.0.0.1:3320/mcp` (MCP over streamable HTTP) |
| Bot setting | `MEMORY_MCP_URL`, `MEMORY_PROJECT`, `MEMORY_DISABLED` |

The library is separate from the persona bank `airi`. A game row never reaches the persona prompt index, recall, or reflection chain, and persona maintenance (restore, merge, key rotation) does not touch the game library. The bridge sets `CASTALIA_BACKGROUND_TASKS=0`, so the engine runs no auto-reflect, consolidation, or digest here: a row stays as written.

Other agents read it across libraries: the bank is a member of the federation (`name: "Game"` in the `federation` list and in `federationService.members`), so `memory_search_all` on `http://127.0.0.1:3314/mcp` returns its rows with `member: "game"`, `project: "minecraft"`.

## Bring it up on a new machine

1. Create the bank directory with the settings of an existing bank, so embedding matches the rest of the stack:

   ```bash
   mkdir -p /d/castalia/memory-banks/game
   cp /d/castalia/memory-banks/airi/{config.json,keys.enc,keys.key} /d/castalia/memory-banks/game/
   ```

2. Add the bridge to `castalia.config.json`:

   ```json
   {
     "id": "game-bridge",
     "name": "游戏记忆桥",
     "port": 3320,
     "instance": "game",
     "char": "game",
     "project": "minecraft",
     "bank": "game",
     "env": { "CASTALIA_BACKGROUND_TASKS": "0" }
   }
   ```

3. Add the `game` instance and the federation member (the `federation` list, plus `federationService.members` with `transport: "local-dir"`, `target: "banks/game"`), then restart the tray.
4. Create the project once, through any bridge of the same bank:

   ```text
   project_create({ "name": "minecraft" })
   ```

4. Write the area contract. The first row holds the category list and the write rules, so a later reader (bot or person) learns the shape from the area itself. Use `memType: "reference"`, `category: "mc:schema"`.

## Categories

| Category | Partition | Content |
| --- | --- | --- |
| `mc:world` | `project` | Server, version, rules, border |
| `mc:place` | `project` | Base, mine, portal, chest, farm, with integer coordinates |
| `mc:build` | `project` | What was built, materials, progress |
| `mc:plan` | `project` | What the master asked for and what stays open |
| `mc:event` | `general` | Death, find, fight, a line from a player |
| `mc:relation` | `project` | Other players, their bases, how they treated the bot |
| `mc:diary` | `general` | One row per session, first line `# diary-YYYY-MM-DD` |

Tags: `mc`, `server:<host>_<port>`, `day:YYYY-MM-DD`.

`mc:diary` uses `general` on purpose. The `memory_save` schema accepts only `user`, `feedback`, `project`, `reference`, and `general`, so a `diary` memType is refused before it reaches the store. The category carries the meaning.

## Write rules

- Write one fact per call, with a stable first line such as `# 地点: 主屋`.
- Keep coordinates, counts, player names, and times verbatim. Do not round a position or turn "3 stacks" into "some".
- Write the word `未确认` when a detail is a guess. Never store a guess as a fact.
- Search before writing. The engine merges identical text, but that merge is a read-then-insert and it loses under concurrency. When a fact changes, write the new text and keep the old row as history.

## Duplicate rows: what the engine does, and what the client does

Measured on 2026-11-06 against the live bridge:

| Shape | Active rows for one text |
| --- | --- |
| 3 saves, one session, sequential | 1 |
| 3 saves, one session, parallel | 3 |
| 3 saves, three sessions, parallel | 3 |

So the engine's `LOWER(TRIM(text))` lookup loses whenever two saves overlap. The client closes that window without an engine change:

- `async-mutex` (repo catalog) serialises writes inside one process.
- After a save, the client recalls rows by the text's first line, compares their full text through `memory_get`, and soft-deletes the copies with `memory_delete`. That repair also covers rows another writer created.

Measured after the change: three parallel `remember` calls of one text give one id and one active row. Three duplicate rows written by an outside process were collapsed to one by a single `remember` (`collapsed: 2`).

The durable fix belongs in the engine: a unique index on the project, memType, and normalised text, with the insert as `ON CONFLICT DO UPDATE`. That is an engine change in three places (source, running `dist`, and the AIRI vendor mirror), plus a schema migration on live banks, so it is not applied here.

## Client choices

| Need | Wheel | Why not hand-rolled |
| --- | --- | --- |
| MCP transport | `@modelcontextprotocol/sdk` (`StreamableHTTPClientTransport`) | It is the reference client, and the app already uses it |
| Request deadline | `AbortSignal.timeout` | Native, and it aborts the request instead of orphaning a promise |
| Write serialisation | `async-mutex` from the repo catalog | Same wheel the app already depends on |
| Duplicate repair | Engine's own `memory_get` and `memory_delete` | No local index to drift from the bank |


## How the bot uses it

- `src/memory/game-memory.ts` holds the client. It connects lazily, times out in 8 s, and answers instead of throwing. One failure silences it for 30 s, so a stopped bridge cannot stall a turn.
- `src/cognitive/conscious/brain.ts` injects a `[MEMORY]` block at session start (`hydrateGameMemory`) and recalls once per distinct chat line (`recallForChat`).
- `src/memory/memory-actions.ts` adds two tools to the action registry: `remember` and `recallMemory`. Both are read-only, so they never take a control queue slot.
- `src/cognitive/conscious/prompts/brain-prompt.md` holds the rules the model reads.

Set `MEMORY_DISABLED=1` to run the bot without the area. Both tools then answer "memory not configured", and the bot still plays.

## Check it

```bash
# the bridge answers
curl -s -X POST http://127.0.0.1:3320/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

# the client, against the live bridge
cd integrations/minecraft && pnpm exec vitest run src/memory
```
