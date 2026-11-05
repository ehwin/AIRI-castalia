# 交接：日记分区（diary partition）未完成改动

生成时间：2026-11-06 01:25（本地）
仓库：`D:\AI\castalia-AIRI`，分支 `feat/tuning-manifest`
状态：**第 3 节的四件事已完成**（2026-11-06 01:45）。集成测试改成 rememberDay 断言，`builtIn_castaliaSearchDiary` 工具已注册，`DAY_PREFIX` 已回退。结论见 report.md 第 15 节。

---

## 0. 需求（用户原话）

> 日记摘要可以是事实，但是不要随意一搜就给，只有明确搜日记的时候才给出去。
> 23 你看别人怎么做的，或者干脆和 1 一起做进记忆体新开一个文档算了，但是不出现在星图上，入口只给菜单。

拆成四条：

1. 日记摘要当作记忆存着，算“事实”也行。
2. **普通检索（search / 注入 / 提示词索引）不能返回它**，只有显式的“搜日记”才给。
3. **星图上不出现**（实体/边不生成，或查询看不到）。
4. **UI 入口只有设置菜单里的日记页**。

## 1. 设计决定

新分一个 `diary` 存储分区，不在 `MEM_TYPES` 里。

- `MEM_TYPES = [user, feedback, project, reference, general]` 是**目录扫描名单**。
  `listMemTypeDirs()` 写死 `base.includes(f)`，所以 `diary/` 目录对一切自动路径天然不可见：
  跨库召回、反刍、衰减、`stats`、`memory_graph`、`sessionInventory` 全部按这份名单走。
- 只有显式 `DatabaseManager.getInstance(project, 'diary')` / `normalizeMemType('diary')` 才读到它。
- 语义：库里是记忆，但不是一个“分区类型”，是一个**独立文档柜**。

### 参考（别人怎么做）

| 系统 | 做法 | 对应我们的哪一条 |
| --- | --- | --- |
| MemGPT / Letta | core memory 常驻上下文，archival memory 只通过 `archival_memory_search` 工具按需取，从不自动注入 | 第 2 条：显式才给 |
| Claude memory tool | `/memories` 是一个文件系统，模型自己 `view` 才看到内容 | 第 4 条：入口即“主动去翻” |
| OpenClaw | 记忆是 workspace 里的 markdown，按需读文件 | 第 3 条：不参与图谱 |

结论：**独立命名空间 + 显式工具 + 不自动注入**，三家一致。

## 2. 已落地的改动

### 2.1 引擎（两份，必须同步）

`packages/castalia-plugin/src/vendor/engine/memType.ts`
`D:\AI\castalia\Castalia-Anima\src\memType.ts`

```ts
export const DIARY_MEM_TYPE = 'diary';

export function normalizeMemType(v: any): MemType {
  // 日记分区走同一个 schema,但不在 MEM_TYPES 里,按普通类型名归一化。
  if (v === DIARY_MEM_TYPE) return DIARY_MEM_TYPE as MemType;
  return isMemType(v) ? v : 'general';
}
```

要点：
- `DIARY_MEM_TYPE` **不要**加进 `MEM_TYPES`，也不要加进 `CLOSED_MEM_TYPES`（加了会被 `normalizeMarkdown` 包一层标题）。
- 返回类型仍标 `MemType` 是刻意的：扩 `MemType` 联合会让每个 `Record<MemType, …>` 都要补一项。
- `memTypeDir(mt)` 就是 `normalizeMemType(mt)`，所以 `getInstance(project,'diary')` 会落到 `<bank>/<project>/diary/memory.sqlite`。

### 2.2 进程内银行

`packages/castalia-plugin/src/bank/index.ts`

新增 `DiaryDayInput` 和三个方法（在返回的 `BankHandle` 上）：

- `saveDiaryDay({date, description, body, characterId})`
  - 文本格式 `# diary-YYYY-MM-DD\n\n<description>\n\n<body>`
  - 先按 `text LIKE '# diary-<date>%'` 找旧行，**软删**（`is_active=0`），再 `store.saveMemory` 插入新行
  - `memType: DIARY_MEM_TYPE`、`source: 'diary_day'`、`type: 'episodic'`、`subject: 'self'`、`importance: 0.6`、`category: 'diary'`
  - **不设 `skipEmbed`**：`searchDiary` 要走向量（真实库有 config.json，一次一天一次 bge-m3 调用）
  - 返回 `{ id, name, replaced }`
- `searchDiary(query, {topK, characterId})` → `search.searchMemory({ query, project, memType: DIARY_MEM_TYPE, characterId, topK })`
- `listDiaryDays({limit, characterId})` → 直接查 diary 库（`is_active=1`），用 `parseStoreText` 拆 name/description/body

同时 `listMemories` 保留了上一批的过滤：`agent_diary` 不进长期记忆页。

注意：`parseStoreText` 是 `bank/store-tools.ts` 导出的，在 `openBank` 里用**动态** import 拿：
`const { createStoreTools, loadEngineDeps, parseStoreText } = await import('./store-tools')`。
`DIARY_MEM_TYPE` 也是动态 import 自 `../vendor/engine/memType`（不能静态 import 引擎模块，会提前定型 env）。

### 2.3 IPC / 主进程

- 契约 `apps/stage-tamagotchi/src/shared/eventa/castalia-memory.ts`
  - `CastaliaDiaryDayInput`
  - `castaliaMemoryRememberDay` (`eventa:invoke:castalia:memory:remember-day`) → `{ ok, reason? }`
  - `castaliaMemorySearchDiary` (`eventa:invoke:castalia:memory:search-diary`) → `CastaliaSearchedMemory[]`
- 引擎接口 `castalia-engine.ts`：`rememberDay?` / `searchDiary?`
- 进程内实现 `castalia-inprocess.ts`：`rememberDay` 调 `bank.saveDiaryDay`，`searchDiary` 调 `bank.searchDiary`（返回结构对齐 `CastaliaSearchedMemory`）
- handler `castalia-memory.ts`：两个 `defineInvokeHandler`，没有实现时返回 `{ ok:false, reason:'transport has no diary store' }` / `[]`
- 渲染层 `App.vue`：`rememberCastaliaDay` / `searchCastaliaDiary` 两个 invoke，并挂进 `memoryStore.attachRemote({...})`

### 2.4 渲染层 store

`packages/stage-ui/src/stores/memory.ts`

- `MemoryRemotePort` 新增 `rememberDay?` / `searchDiary?`
- 新类型 `MemoryDiaryDay` / `MemoryDiaryResult`
- 新函数：
  - `rememberDay(day)`：`enabled` 关闭 → `{ok:false,reason:'disabled'}`；端口没有 → `unsupported`；异常吞成 `{ok:false,reason:message}`
  - `searchDiary(query, topK=5, persona)`：关闭或无端口 → `[]`
- 两个都从 store 导出

`packages/stage-ui/src/stores/modules/diary.ts`

`distill(date)` 不再 `memory.write(...)`，改成：

```ts
const written = await memory.rememberDay({
  date,
  description: entry.description,
  body: entry.body,
  persona: memory.resolvePersona(scope.value),
})
if (!written.ok)
  return undefined
if (!hasDistilled(date))
  distilledDays.value = [...distilledDays.value, date]
return entry
```

## 3. 还没做的（按顺序）

### 3.1 日记集成测试要重写（**现在会红**）

文件：`packages/stage-ui/src/stores/modules/diary-distill.integration.test.ts`

四条旧断言都在假设“蒸馏 → memory.entries / index”：

| 旧用例 | 现在要断什么 |
| --- | --- |
| `turns a day into exactly one index line` | 改成：挂一个假 remote（含 `rememberDay: vi.fn(async () => ({ ok:true }))`），distill 后断言 payload：`date === '2026-11-01'`、`description` 含「我记着了」、`body` 含原文、`persona === memory.resolvePersona(useMindStore().scope)`；再断言 `memory.entries` 为空、`indexFor(persona)` 里没有 `- 2026-11-01` 行 |
| `does not add a second entry when the same day is remembered twice` | 同名覆盖发生在银行侧（`saveDiaryDay` 软删旧行再插）。UI 侧断：第二次调用后 `hasDistilled` 仍为 true；若要省一次嵌入调用，可在 `distill` 开头加 `if (hasDistilled(date)) return undefined`（**未做，建议加**，但要确认按钮文案仍显示“已记住”） |
| `keeps nothing when the memory module is off` | `memory.enabled=false` 时 `rememberDay` 直接返回 disabled，假 remote 的 spy 必须没被调用 |
| `does not mark the day when the bank refuses the write` | 假 remote 的 `rememberDay` 返回 `{ok:false}`，断言 `hasDistilled === false` |

`attachRemote` 的端口是必填 `list/save/forget`，mock 时三个都要给。

### 3.2 跑测试

```bash
cd /d/AI/castalia-AIRI
pnpm -F @proj-airi/castalia-plugin exec vitest run            # 期望 123+，含新 bank 用例
pnpm -F @proj-airi/stage-ui exec vitest run src/stores/memory.test.ts src/stores/modules/diary-distill.integration.test.ts
pnpm -F @proj-airi/stage-ui exec vitest run src/stores/modules/video-watch.test.ts
```

### 3.3 模型侧“翻日记”工具（还没写）

目的：主人明确问“你日记里写了什么 / 前天你记了什么”时，模型才有通道。平时不暴露内容。

- 位置：`packages/stage-ui/src/tools/castalia.ts`（照现有 `castalia_*` 工具的写法）
- 名称建议：`castalia_search_diary`
- 描述必须写死边界：*只在她自己主动提起日记、或主人明确问起她的日记时调用；普通对话不要调用。*
- 实现：`const hits = await memory.searchDiary(query, 5, persona)`，把 `hit.text` 按天拼成几行返回；空数组时回“日记里没有这一段”
- 可选第二个工具 `castalia_read_diary_day`（按 `YYYY-MM-DD`），用 `bank.listDiaryDays`，需要再加一层 IPC——**建议先不做**，等真需要
- 注册处：`packages/stage-ui/src/tools/index.ts`（或 chat 里组装工具的地方），和现有 castalia 工具一样受 `castalia.enabled` / `memory.enabled` 闸门

### 3.4 文档

`docs-notes/audits/castalia-emotion-loop-2026-11-05/report.md` 追加第 15 节：
- 为什么新分区而不是 `source='diary_day'`（目录扫描名单 = 天然隔离，一个漏过滤就会泄漏）
- 三家参考（MemGPT / Claude memory tool / OpenClaw）
- `saveDiaryDay` 的替换语义
- 星图为什么自动干净（`memory_graph` 只读 base 5 个分区的 `memory_entities`/`edges`）
- 遗留：G3 private 念头仍会进 body（现在被“显式才读”包住了，但页面上 private 仍需展开才能看，模型侧却能读到——要不要在 `distillDay` 里把 description 限定为 shared，是个待定项）

## 4. 验证现状

| 检查 | 结果 |
| --- | --- |
| `castalia-plugin` bank 套件 | **22 passed**（含新增 “keeps a diary day out of the memory list until the diary is searched”） |
| `stage-ui` 其余测试 | **未跑**；`diary-distill.integration` 现在会红（旧断言） |
| typecheck | **未跑**，预期报 `memory.ts` 端口与实现不匹配已经补上，但 `diary.ts` / 测试可能还有残留 |
| 应用构建 | 未做 |

## 5. 坑（踩过/需注意）

1. **CRLF**：这几个文件是 CRLF，`write_file` 整文件重写会产生整文件 diff。用字节替换，保留原行尾。
2. **引擎两份**：`packages/castalia-plugin/src/vendor/engine/*` 与 `D:\AI\castalia\Castalia-Anima\src\*` 必须同步；这次 `memType.ts` 两边都改了。
3. **独立引擎部署**：`D:\castalia\run\Castalia\dist`（5 条桥 3310–3318 用的）**还没重建**。`memType.js` 不改，那边的 `searchDiary` 不存在也不会报错，但日记分区功能只在 app 进程内可用。要上独立引擎就 `npm run build` 后只拷 `dist/memType.js`（以及将来用到 `search.js` 时再拷）。
4. **`listMemTypeDirs` 的 `base.includes(f)`**：这是隔离的关键，同时也是陷阱——以后谁把 `diary` 加进 `base`，隔离立刻失效。
5. **`stats()` 看不到 diary 分区**（它也写成 5 个类型）。日记页不要依赖它显示条数。
6. **嵌入成本**：一天一条，每条一次 bge-m3；`allowNoConfig`（测试）下 `EMBED_MODE=none`，只走 FTS，所以测试里用的英文词（`midnight`）比中文更稳。
7. **`saveMemory` 的 source 语义**：只有 `conversation_log` 进 VAD 队列，`diary_day` 不会污染 psyche。
8. **`updateMemory` 不用**：它按 `findDbByMemoryId` 定位库，diary 分区可能找不到；所以 `saveDiaryDay` 用“软删旧行 + 插入新行”。

## 6. 验收清单（新窗口照这个跑）

```bash
cd /d/AI/castalia-AIRI

# 1. 引擎侧
pnpm -F @proj-airi/castalia-plugin exec vitest run

# 2. 渲染层
pnpm -F @proj-airi/stage-ui exec vitest run src/stores/memory.test.ts \
  src/stores/modules/diary-distill.integration.test.ts \
  src/stores/modules/video-watch.test.ts

# 3. 类型
pnpm -F @proj-airi/stage-ui exec vue-tsc --noEmit 2>&1 | grep -E "stores/(memory|modules/diary)"

# 4. lint（只查改动文件）
pnpm exec eslint packages/stage-ui/src/stores/memory.ts \
  packages/stage-ui/src/stores/modules/diary.ts \
  packages/stage-ui/src/stores/modules/diary-distill.integration.test.ts \
  packages/castalia-plugin/src/bank/index.ts \
  apps/stage-tamagotchi/src/main/services/airi/castalia-inprocess.ts \
  apps/stage-tamagotchi/src/shared/eventa/castalia-memory.ts
```

期望：1）全部绿；2）集成测试 4 条改成 rememberDay 之后绿；3）无 `memory.ts` / `diary.ts` 的 error；4）0 error（`bank/index.ts` 有 15 条 HEAD 既有 error，不是本次引入）。

## 7. 本次改动文件清单

```
packages/castalia-plugin/src/vendor/engine/memType.ts     diary 分区常量 + normalizeMemType
packages/castalia-plugin/src/bank/index.ts               saveDiaryDay / searchDiary / listDiaryDays + DiaryDayInput
packages/castalia-plugin/src/bank/index.test.ts          日记日不进列表/默认检索的新用例
D:\AI\castalia\Castalia-Anima\src\memType.ts             与 vendor 同步
apps/stage-tamagotchi/src/shared/eventa/castalia-memory.ts   两个 invoke + 输入类型
apps/stage-tamagotchi/src/main/services/airi/castalia-engine.ts   接口 rememberDay/searchDiary
apps/stage-tamagotchi/src/main/services/airi/castalia-inprocess.ts 实现
apps/stage-tamagotchi/src/main/services/airi/castalia-memory.ts    IPC handler
apps/stage-tamagotchi/src/renderer/App.vue               attachRemote 挂两个方法
packages/stage-ui/src/stores/memory.ts                    端口 + rememberDay/searchDiary + 类型
packages/stage-ui/src/stores/modules/diary.ts             distill 改走 rememberDay
```

## 8. 前一批（已完成、有测试）的上下文，避免重复劳动

- 日记与看片分开：看片进 `video-watch` 队列，日记页按天 join（`watchedByDay`）；思绪流里不再有 `watched-video`。
- `memory.write()` 现在受 `enabled` 闸门：模块关闭时返回 `{ ok:false, reason:'disabled' }`。
- `listMemories` 过滤 `agent_diary`（自循环日记不再进长期记忆页）。
- `DAY_PREFIX` 接受 `diary-` 前缀，蒸馏条目会进索引 `recent` 段（**注意：这一条与新设计冲突**——新设计里日记不该进提示词索引；新窗口要把 `DAY_PREFIX` 的改动回退，或让 `selectIndexEntries` 按 `memType === 'diary'` 直接跳过）。
- `PSYCHE_FROM_VAD` 一刀切重写规则、`initialAffect`、`markShared`/`markSaidOutLoud`、`formatDiary` 的 unknown 输出，都在前几批完成并有测试。
