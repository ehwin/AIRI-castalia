# 模块 / 情感循环 / 记忆体接入复查（2026-11-12 第二轮）

范围：复核上一轮加的噪声与付账改动，并把「接入记忆体」这条链从写入、召回、日记、念头、情绪、精力逐个交接点走一遍。

## 修掉的两处

| 位置 | 问题 | 现在 |
| --- | --- | --- |
| `castalia-inprocess.ts` | 「最近注入过的记忆 id」是**进程一份**。共享（general）记忆两张卡都看得见，第一张卡刚读过的 id 会把第二张卡的那一行也排掉。 | `recent-ids.ts` 按角色分开：`Map<persona, ids>`，上限仍是 10。5 条测试。 |
| `memory.ts` `read` / `forget` | 没解析卡→库的别名，而 `indexFor` 解析了：提示词索引里印着一行（`default` 卡读 `airi` 的行），工具按同一行去读却读不到。 | 两处都先 `resolvePersona`，与 `indexFor` 同源。1 条测试。 |

## 核对过、判定正确的交接点

| 交接 | 结论 |
| --- | --- |
| 每轮落库的人格 | `chat.ts` 先 `resolvePersona(personaOf(sessionId))` 再 `ingestTurn`，非聊天写入（看片）也解析。 |
| 召回的人格 | 上下文 provider 传 session，再解析成 persona；`castalia-inprocess` 把 persona 映射成 `characterId`（审计 A01 的修法在）。 |
| 情绪写入的幂等 | 键是 `emotion:turn:<conversationId>:<turnId>`；引擎拒绝（`estimator_active`）时**不**镜像、不标记该轮 analyzed，于是这一轮仍进 VAD 队列，自动通路接手——两条路只会有一条生效。 |
| `deferPsycheFinalize` | 调用点传的是 `PSYCHE_FROM_VAD === 'on'`。闸门关时行落成 `analyzed`，不会永远 `pending_psyche` 被反复入队。 |
| 精力 / psyche 镜像 | `setEnergy`、`psycheState` 都先 `ensure(persona)`，按角色开库；`syncPsyche` 用引擎回包的 `characterId` 写镜像。 |
| 念头存档 | 只在 mind 租约持有者里跑；行按 persona 写；`skipEmbed` 不花嵌入费。 |
| 列表截断 | `LIST_LIMIT` 撞上限时有 `truncated` 标记 → 面板如实说「只读到 N 条」，不假装是全部。 |
| 本地缓存 | `entries` 落在 localStorage，首轮系统提示的索引不是空的；`hydrate` 先迁移后接管，失败保留本地。 |

## 发现但没动的（需要你定或需要真机数据）

1. **落库没有幂等键、也没有重试**（P2）。`saveConversationTurn` 每次 `generateId()` 新插一行；`ingestTurn` 是 `void` 调用，引擎抖一下这一轮就永久丢了（情绪有 `recoverPendingVadQueue`，对话行没有对应恢复口）。两条路可选：给 ingest 传 `turnId` 在 SQL 去重（干净，要改 schema 一侧的去重条件），或做一个 localStorage 的待发队列 + `hydrate` 时补发（不动引擎，但要处理顺序和上限）。我倾向先做前者再做后者。
2. **`searchDiary` 在模块关闭时返回 `[]`** — 已改：关闭或无端口时抛错，工具侧照既有 try/catch 说「打不开」，不再冒充「没写过」。
3. **每日阈值偏移在零点是一个跳变** — 已改：`noiseDayKey()` 把分区点挪到 **04:00**（和日记同一个边界），23:59 与次日 00:30 落在同一「日」。
4. **同一轮双份视觉调用**（P2，上一轮遗留）：`screen:activity` 失败退 `screen:interpret` 时会连打两次模型。需要真机 `lastSenseDiagnostics` 的 `stage: 'activity-threw'` 计数才有依据决定要不要合并。
5. **面板不显示今日偏移 / 抖动**（有意）。设置窗口是另一份 Pinia，读到的不是 stage 窗口那份——上一轮已经踩过这个假绿。要看真值必须并进 stage 窗口落盘的诊断。

## 落库幂等：怎么做的

宿主给键，引擎按主键去重：

- `chat.ts` 把**用户消息 id**（`pendingUserTurns.get(sessionId).id`）作为 `turnId` 传下去 → eventa `CastaliaIngestTurnInput.turnId` → bank `IngestTurn.turnId`。
- `saveConversationTurn()` 收到 `turnId` 就用 `conv-<turnId>` 当行主键，插入改成 `INSERT OR IGNORE`；`changes === 0` 立刻返回 `{ ok: true, deduped: true }`，**不再入 VAD 队列**（否则自动估计器会把同一句话算第二次）。
- 没有 `turnId` 时行为完全不变（每次新插一行），老调用方和 `MEMORY_AUTO_PROCESS=1` 那条路不受影响。
- 重试只对**带键**的调用开放（`INGEST_RETRY_DELAYS_MS = [1s, 4s]`）：没键时一次「超时但其实写进去了」的重试会变成两行。带键的重试则是空操作。
- 拒绝（`ok:false`）不重试：那是答复，不是抖动。

验证：`bank/index.test.ts` 用真 sqlite 跑同一 `turnId` 两次 → 一行、同一个 `id`；不给 `turnId` 两次 → 两行。

## 同步引擎时确认的边界（不是问题）

`D:\castalia\run\Castalia\dist` 是**标准版 Castalia**，给四桥用，和 AIRI 情感版是两条产品线：它的 `store.js` 写死 `characterId = 'airi'`、`is_active=0`「分隔带」、`metadata` 分栏，那是它自己的设计。所以不存在「run 落后需要同步」这件事，本次也没有动它。

本次改动落在情感版这一侧：`packages/castalia-plugin/src/vendor/engine/store.ts` 与 `D:\AI\castalia\Castalia-Anima\src\store.ts` 同改，Anima `dist/store.js` 已重建（`git status` 里就是这两个文件）。

## 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm -F @proj-airi/core-agent exec vitest run` | 732 passed（含新增 04:00 分区测试）|
| `env -u PSYCHE_BAND_* pnpm -F @proj-airi/castalia-plugin exec vitest run` | 127 passed（含 2 条落库去重）|
| `pnpm -F @proj-airi/stage-ui exec vitest run <memory×2 + mind.integration + speech×2>` | 213 passed |
| `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/recent-ids.test.ts` | 5 passed |
| `vue-tsc --noEmit` stage-ui / stage-pages / stage-tamagotchi；`tsc --noEmit` castalia-plugin / core-agent | 全部 0 error |
| `eslint` 改动文件 | 0 error（`bank/index.test.ts` 两条 one-liner 与 HEAD 一致；`chat.ts` 3 条既存 comment warning）|
| `stage-tamagotchi build` | 成功；`out/bundle/main/chunks/store-*.mjs` 含 `conv-${` 与 `deduped` |
