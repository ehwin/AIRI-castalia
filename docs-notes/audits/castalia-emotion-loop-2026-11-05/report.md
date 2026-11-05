# Castalia 情感循环：一条链、三个断点

2026-11-05 · 审计范围：AIRI 桌面端（stage-tamagotchi）+ `@proj-airi/castalia-plugin` 进程内引擎。

这篇只回答一件事：**一次对话进来，情绪怎么走一圈，问题 1 / 2 / 3 落在哪一段。**
改动方案在每节末尾，按“位置、触发条件、症状、修法”写，方便一项一项做。

---

## 1. 环路总图

```
                 ┌──────────────────────────── 用户说话 ────────────────────────────┐
                 │                                                                  │
                 ▼                                                                  │
[A] 写入对话      chat.send() 完成回复后 memory.ingestTurn()            chat.ts:1152  │
                 │  IPC: castaliaMemoryIngest                                       │
                 │  → castalia-inprocess.ts:214 → bank.ingestTurn      bank:331    │
                 │      ├ MEMORY_AUTO_PROCESS=1 → autoProcessor.autoProcess        │
                 │      └ 否则最小路径：saveConversationTurn                        │
                 │           source='conversation_log', affect_status='pending'    │
                 │           affect_source='vad_queue'                             │
                 ▼                                                                  │
[B] 判情绪       每 2 分钟 flushStaleVadQueue()          castalia-memory.ts:213     │
     两条写者：   nightly digest 也调 recoverPendingVadQueue      digest.ts:58       │
                 │                                                                  │
     B1 自动  ────┼─ PSYCHE_FROM_VAD === 'on' 才走            emotion.ts:1105       │
                 │   分析器：OLLAMA_URL / VAD_MODEL → 模型端点                      │
                 │           否则本地词表（140 条里 128 条 abstain）                │
                 │   有判断 → targetAppraisalFromVAD(event='vad:<project>:<ids>')   │
                 │         → psyche_state(vad, band, version) + psyche_events       │
                 │   无判断 → affect_status='abstain'                               │
                 │                                                                  │
     B2 显式  ────┼─ 模型调 builtIn_castaliaRecordEmotion      tools/castalia.ts:27 │
                 │   chat.ts:695 同时写两份：                                       │
                 │     castalia.recordEmotion()  → 渲染层 agent-states（提示词用）   │
                 │     memory.recordEmotion()    → IPC apply-emotion                │
                 │       → castalia-memory.ts:386                                   │
                 │       → PSYCHE_FROM_VAD=on 时直接拒绝            ← 问题 ③        │
                 ▼                                                                  │
[C] 读情绪       C1 castaliaMemoryPsyche → bank.psycheState → psyche_state     │
                 │  App.vue:522 每 5 分钟 syncPsyche                App.vue:170      │
                 │  → castalia/agent-states（vad / moodHistory / 'psyche' 标记）    │
                 │  → chat.ts:1078 formatSelfStatePrompt(snapshot) 每轮进上下文     │
                 │  C2 精力：mind.drives.fatigue → 100-fatigue → setEnergy           │
                 │  C3 愿望：builtIn_castaliaSetDesire → currentDesire（无调用方）   │
                 ▼                                                                  │
[D] 日记         主进程 scheduleSelfCycle（默认 360 分钟）    castalia-memory.ts:286
                 │ 渲染层 attachThink 也会触发                       App.vue:575     │
                 │ → bank.selfCycle → runSelfCycle                 bank:385         │
                 │ → formatDiary(AgentState, psyche, 最近对话)      selfCycle.ts:285│
                 │ → saveSelfDiary → source='agent_diary', skipEmbed               │
                 │                                                                  │
     D2 自言自语 ─┼─ diaryText → composeInnerVoice({diary,...})  inner-voice.ts:156│
                 │   diaryTitle() 取标题句                        inner-voice.ts:48 │
                 │   模板拼成「她……」（主语固定是她）             inner-voice.ts:173│
                 │   → mind.ts:535 记进思绪流 visibility='private'   ← 问题 ②        │
                 │                                                                  │
     D3 主动开口 ─┴─ self-initiated-speech.speak()             self-initiated-speech.ts:264
                    → chat.notifyConversation() → 一轮新对话（回到 [A]）
                    → 她说出口的话没有写回思绪流                ← 问题 ①
                                                                                   │
[E] 蒸馏         diary.load(200) → byDay →「记住这一天」→ distillDay → memory.write
                                                                                   │
                 └──────────────── 她主动开口 = 新一轮对话，回到 [A] ──────────────┘
```

---

## 2. 每一段的状态

| 环节 | 写入者 | 存储 | 读者 | 开关 | 现在的实际情况 |
| --- | --- | --- | --- | --- | --- |
| 对话 | `saveConversationTurn` | `memory` 表 `conversation_log` | VAD 扫描、日记 | 无 | 每轮都写，正常 |
| 自动情绪 | VAD 扫描 | `psyche_state`、`psyche_events` | 面板、提示词、日记 | `PSYCHE_FROM_VAD=on` | 开着也只有 8.6% 有判断 |
| 显式情绪 | 模型工具 | 同上 | 同上 | 模块开关；`=on` 时被拒 | 从未被调用过 |
| 渲染层镜像 | `syncPsyche` | `castalia/agent-states` | 提示词、面板 | 无 | 5 分钟一次，正常 |
| 精力 | mind 疲劳 | 两边 | 提示词、面板 | 无 | 真的，`100 - fatigue` |
| 愿望 | 模型工具 | `agent-states` | 提示词、面板 | 无 | 从未被调用，所以“暂无记录” |
| 日记 | 自循环 | `agent_diary`（`skipEmbed`） | 自言自语、记忆列表 | `CASTALIA_SELF_CYCLE` | 每 6 小时，正常 |
| 说她出口的 | 无人 | — | 日记页 | — | 恒空（问题 ①） |
| 蒸馏 | 用户点按钮 | 长期记忆索引 | 检索、提示词 | 记忆模块 | 已修成按 `persisted` 判定 |

**一句话**：证明“情绪有没有动”的只有 `psyche_state`。渲染层那份 `agent-states` 是镜像，不是真源；它里面的 `moodHistory` 里那条 `reason: 'psyche'` 只是同步标记，不是事件。

---

## 3. 问题 ③：`PSYCHE_FROM_VAD` 互锁（在 [B]）

### 位置

`castalia-memory.ts:390-394`

```ts
// One writer owns psyche. Under `PSYCHE_FROM_VAD=on` the automatic chain already judges this
// turn; letting the explicit write land too counted one moment twice (measured: +5% valence
// per turn on top of the first appraisal, and it compounds over a conversation).
if (process.env.PSYCHE_FROM_VAD === 'on')
  return { applied: false, reason: 'estimator_active' as const, version: 0 }
```

### 为什么会有这条

一次评估同时被两条通路算，会把同一轮的情绪计两次。实测叠加约 +5% valence/轮，聊久了会把 band 顶到 positive。

### 它和现实的冲突

自动通路在只有本地词表时，**140 条已处理对话里 128 条 abstain**（8.6% 有判断）。也就是说：

- 开关关：显式工具能写，但模型很少调（真库里 0 次），psyche 基本不动。
- 开关开：自动通路只对 8.6% 的轮次有判断，显式工具被拒，psyche 动得更少。

两个开关互为闸门，**没有一个组合能让 psyche 持续更新**。面板“当前情绪 0”就是这条链的结果，不是面板读错了。

### 触发条件与症状

| 条件 | 症状 |
| --- | --- |
| `PSYCHE_FROM_VAD=on` 且模型调 `recordEmotion` | 面板不动，`psyche_state.version` 不涨；渲染层 `moodHistory` 却多一条（两份状态各说各话） |
| `PSYCHE_FROM_VAD` 未开 | `recordEmotion` 能写进引擎，日志/面板文案会说明；但模型没有调用动机 |
| 自动通路 abstain | `affect_status='abstain'`，`has_evidence` 不变；72 小时后 TTL 到期，面板回到“暂无证据” |

实测：`airi` 最后一次证据 `2026-11-01 00:42:48`，TTL 72h，2026-11-04 00:42 过期；`N_h4lzzOfl0AYehOR171-` 分区的 `has_evidence=0`、`updated_at=2026-11-03 12:48`。

### 修法

**A. 按轮次去重（语义正确，代价中等）**

显式写入已经带幂等键 `emotion:turn:<conversationId>:<turnId>`（`chat.ts:706`）。
自动写入的 event id 是 `vad:<project>:<memoryIds...>`（`emotion.ts:1121`），是**一批**而不是一轮。

要真正按轮去重，需要把自动评估从“每批一次”改成“每条一次”（`event_id = vad:<project>:<memoryId>`），然后让 `applyPsycheAppraisal` 遇到同一轮已有事件就跳过。改动集中在 `flushVadQueue` 的两条分支（`emotion.ts:1105-1131`、`1168-1184`）和一个去重查询，约半天，会改变现有的批量语义（一次批次里 3 条对话会写成 3 个事件而不是 1 个），`psyche_events` 行数会涨。

**B. 按估计器质量放行（快修，有双计风险）**

只有 `estimator === 'model'` 时才拒绝显式写入；本地词表时允许。
改 `castalia-memory.ts:393` 一处，半小时。风险：词表判出判断的那 8.6% 轮次会和显式写入撞车，同一轮计两次。

**C. 不动**

面板文案已经如实说“模型显式记录的情绪不再重复写入”。代价是 psyche 长期不动。

> 建议 A。B 适合“先让它动起来”，但要接受少量双计。

---

## 4. 问题 ①：`shared` 没有生产者（在 [D3] → [A] 的回边）

### 位置

`self-initiated-speech.ts:264-307` 的 `speak()`：

```ts
const context = mind.innerContextLine(3)
const text = context ? `${SELF_INITIATED_NOTICE}\n\n${context}` : SELF_INITIATED_NOTICE
return chat.notifyConversation(sessionId, { source: SELF_INITIATED_SOURCE, text })
```

她说了一句话（通知模型本轮由她发起），模型回一句，TTS 播出来。**这句话没有写回思绪流。**

### 这条回边本来该喂谁

1. 日记页「她说出口的」栏（`diary.vue` 的 `shared`）——现在恒空。
2. 摘要里的 `said` 计数——现在恒 0。
3. `distillDay` 挑索引描述时优先 `shared` 行（`diary-distill.ts`）——永远轮不到。
4. `composeInnerVoice` 的“标题优先取她自己那句”设计（见问题 ②）——没有原料。

真机：IndexedDB `airi-mind/thoughts` 12 条全是 `private`，`shared` 0 条；全仓没有一处写 `visibility: 'shared'`。

### 症状

她主动说的话，第二天在日记里看不到。日记只记录“她想什么”，不记录“她说了什么”。于是“隐私 vs 说出口”这个分类在数据结构里存在，在行为里不存在。

### 修法

**A. 补回边（推荐）**

在 `speak()` 里等这一轮结束，取本轮 assistant 文本，写一条 shared 思绪：

```text
const done = await chat.notifyConversation(...)
const said = lastAssistantText(sessionId)          // 本轮她的回复
if (said) mind.recordSpoken(said)                   // 新增：visibility:'shared', topic:'self-talk', persona:mindScope
```

`mind.recordSpoken` 约 15 行（`stream.value = record(...)` + `innerThoughtsRepo.append`），`speak()` 改 3 行，加 1 条测试（发出→流里多一条 shared；被屏幕门挡下→不记）。风险：TTS 静音/失败时不该记，要按“真的发出去了”判断，否则又是一处假账。

**B. 删栏目**

删日记页的 section、摘要参数、3 个 i18n key。10 分钟，功能消失，但界面不再承诺没有的东西。

> 建议 A。它是问题 ② 的前置条件：有了 shared 行，日记标题才可能取她自己那句。

---

## 5. 问题 ②：日记标题取的是主人那句（在 [D2]）

### 位置

`packages/core-agent/src/mind/inner-voice.ts:48-70`

```text
const quote = lines.find(line => /^用户\s*[:：]/u.test(line))
if (quote) {
  // 一行里常把她的回应也串在一起（`用户: … 助手: …`）；她心里复述的是自己说的那句。
  const said = quote
    .replace(/^用户\s*[:：]\s*/u, '')
    .split(/\s+助手\s*[:：]/u)[0]     // ← [0] 是主人那句
    ...
```

注释说“复述自己说的那句”，代码取 `[0]`，也就是主人那句。

然后 `composeInnerVoice` 用固定主语拼句（`inner-voice.ts:173`）：

```text
const said = title?.replace(/[。！？…\s]+$/u, '')
... `${lead}她${said}……`
```

### 症状

日记里 `用户: 今天好累` → 她心里说「她今天好累……先记着，不急。」
**把主人的状态安到了她身上。**她说出口的话反而没有出现。

实测（真函数探针）：`title: "今天好累"` → `voice: "她今天好累……先记着，不急。"`

### 为什么不能直接改成取 `[1]`

取她那句，拼出来是「她就早点睡，别硬撑……」，主语 + 祈使句，语法塌。要改就得同时换模板主语（`她说${said}` 或去掉主语），会动 8~10 条 inner-voice 断言。

### 修法

**A. 换主语 + 改注释（小）**
`她${said}` → `主人${said}`，注释改成“她此刻想着的是主人那句”。半小时，语义立刻正确，不改取词逻辑。

**B. 取她那句 + 改模板（中）**
`split(...)[1]`，模板改 `她说${said}`，断言全改。半天。只有问题 ① 修好、`shared` 有数据之后，这条才有意义——否则她那句通常不存在（日记里的 `助手:` 段是引擎模板，不是她的口语）。

**C. 不改**

> 建议 A 先落地；① 做完再评估 B。

---

## 6. 三者的依赖与顺序

```
③ 互锁 ──独立，决定 [B]→[C] 有没有数
                     │
                     ▼
① 回边 ──独立，决定 [D3]→[A] 有没有“她说的话”
                     │
                     ▼
② 主语 ──依赖 ① 的数据；改法 A（换主语）不依赖任何东西，可以先做
```

- 只修 ③：psyche 会动，面板有数，日记情绪行变成“互动传感器”。日记仍然只记她想什么。
- 只修 ①：日记出现“她说出口的”，标题仍取主人那句（主语还是错的）。
- 只修 ②-A：主语对了，但取到的还是主人那句（“主人今天好累”是对的，只是不是她自己的话）。

**建议顺序**：②-A（半小时，先把错的句子改对）→ ③-B（快修让它动，接受少量双计）→ ①-A（补回边）→ 视数据再决定 ③-A 和 ②-B。

---

## 7. 实测数值（2026-11-05）

| 项 | 值 |
| --- | --- |
| 当前卡 | `N_h4lzzOfl0AYehOR171-` |
| 面板 | 情绪 0、愿望 暂无记录、精力 100%（`fatigue=0.539` → 99.46） |
| `psyche_state`（`airi`） | `has_evidence=1`，`last_evidence_at=2026-11-01 00:42:48` |
| `psyche_state`（`N_h4lz…`） | `has_evidence=0`，`updated_at=2026-11-03 12:48` |
| TTL | 72 小时，最后证据于 2026-11-04 00:42 过期 |
| `psyche_events` | 4 条，2026-10-31 22:34 → 2026-11-01 00:42 |
| 对话处理 | 140 条里 128 条 `abstain/local_lexicon`，8.6% 有判断 |
| pending VAD | 8 条，2026-11-03 02:33–03:18 入队（已修：重启会恢复） |
| 思绪 | 12 条 private、0 条 shared |
| band 工作点 | `-0.35 / 0.12 / 0.05`（CPED 语料调；套 AIRI 41 条会话 38 条 positive） |

---

## 8. 这篇没覆盖的

- 问题 ④ band 工作点（第 4 项）
- 问题 ⑤ 引擎日记“情绪指数（旧量表）”恒 0（第 5 项）
- 问题 ⑥ 日记只读 200 条（第 6 项）

按你的节奏，一项一项来。


## 9. 2026-11-05 第二批：按 2026-10-31 报告的口径落地

`docs-notes/psyche-full-chain-upgrade-report-2026-10-31.md` 已经定了几条规则，这一批按它改，不再新造机制。

### 9.1 ③ 单写者（不再按开关一刀切）

- 删掉 `castalia-memory.ts` 里 `PSYCHE_FROM_VAD === 'on'` 就拒绝显式写入的那段。它防的是同一轮算两次，但代价是两边都不动（词表只对 8.6% 的轮次有判断）。
- 判定跟着这一轮走：`bank.ingestTurn` 接受 `affect`，`saveConversationTurn` 直接把行落成 `analyzed`（带 VAD 和 `affect_analyzed_at`），不进 VAD 队列。两分钟后的扫描只捞 `pending`，自然跳过。
- 脑裂：`chat.ts` 先等引擎结果，只有 `applied` / `neutral`（或没有引擎时的 `unsupported`）才镜像到渲染层。引擎拒绝就不写，面板和提示词不再各说一套。
- 工具如实回报：引擎没接收时返回 `Emotion not recorded. The engine refused the write.`
- 未覆盖：`MEMORY_AUTO_PROCESS=1` 的 fullAuto 路径在引擎里落库，拿不到行 id，不参与去重。应用默认走最小路径。

### 9.2 ① 触发机制（原来完全没有）

事实核对：全仓没有一处写 `visibility: 'shared'`，`background-lane.ts` 只写 `private`，`inner-stream.ts` 只读计数。栏目挂在那里，永远不会有一条。

采用的判据是**复述**：她真正发出去的那句里包含某条念头（去掉 `noticed:` 前缀和标点后至少 6 个字），就把那条念头翻成 `shared`。

- `core-agent`：新增 `markShared(stream, id)` 纯函数，未知 id 或已 shared 时原样返回。
- `mind`：新增 `markSaidOutLoud(said)`，只扫 `self-cycle` / `held-back` 的 private 念头，命中后改流并写回 IndexedDB。
- `chat.notifyConversation` 现在返回本轮回复文本（从 `executeSend` 的消息切片里取，不靠读最后一条消息）。
- `speak()` 只有发送成功才调用；被屏幕门挡下或失败不标记。

含义：`shared` 列 = 她真的说出口的念头。转述（不复述原句）不会标记，所以这列天然稀少，和“几乎所有事她都自己留着”一致。

### 9.3 ⑤ “旧量表 +0.0” 改成 unknown

`selfCycle.formatDiary`：既没有 psyche 证据、也没有任何 `moodHistory` 时输出 `情绪指数 unknown（暂无评估）`。有事件时仍走旧量表，有证据时仍走传感器。依据是 2026-10-31 报告 §2.3：unknown、abstain、neutral 是三种状态。

### 9.4 ④ band（没有改）

部署 `castalia-engine.json` 里仍有 `PSYCHE_BAND_CENTER_OFFSET=-0.35`、`PSYCHE_BAND_ENTER=0.12`、`PSYCHE_BAND_HOLD=0.05`。默认值是 `0 / 0.25 / 0.10`（相对基线），也就是报告 §10 的策略。删掉这三项就回到默认，不需要改代码。运行中的配置没有动。

### 9.5 验证

- `core-agent`：`inner-stream` / `inner-voice` / `diary-distill` 30 passed。
- `castalia-plugin`：122 passed / 16 files；`tsc --noEmit` 只剩 `psyche-layered.test.ts` 的既存错误。
- `stage-ui`：七个文件 140 passed（含 `mind` 的两条新断言）。
- `eslint`：改动文件 0 新增（`mind.ts` 9 条与 HEAD 相同，`bank/index.ts` 16 条与 HEAD 相同）。
- `stage-ui vue-tsc`：改动文件（`chat.ts` / `memory.ts` / `mind.ts` / `self-initiated-speech.ts` / `tools/castalia.ts`）0 error；仓库其余 providers 测试的既存错误未动。


## 10. 2026-11-05 第三批：说出口也算一件事（心情）

### 10.1 两个触发机制的对照

| | 分享视频的回应 | 她主动开口 |
| --- | --- | --- |
| 触发点 | `react(id, reaction)` 记下回答；下一次 `applyPending()` 落账（卡片组件挂载时、autonomy tick 里各调一次） | ticker 决定开口，`speak()` 发送成功 |
| 幂等 | `applied` 标记，重复 tick 只落一次；写失败不标记，下个 tick 重试 | 每次成功发送一次（发送本身不能重放） |
| 心情 | `feedbackEffect`：wants +2 / more +1 / pass -1 | +1「我主动跟主人开口了」（本批新增） |
| 记忆 | `memory.write` 一条「分享过的片子 …」，persona 与心情同一 key | 不重复写：这一轮已由 `ingestTurn` 落 `conversation_log` |
| persona | `resolvePersona(cardId)` | `currentPersona`（tick 里已 resolve） |
| 开关 | 现在受 `castalia.enabled` 管，记忆写仍归记忆模块自己管 | tick 里 `castalia.enabled` 不过就不开口 |
| 失败 | 抛错 → 不标记 applied，下个 tick 重试 | 门控或发送失败 → 心情和 shared 都不写 |

### 10.2 本批改动

- `speak()` 送达成功时记一条 +1 心情。这是"她做了一件事"里的说话那一半；分享视频的回应是另一半。
- `formatSelfStatePrompt` 的「最近发生的事」按 reason 去重：开口多的时候，同一句「我主动跟主人开口了」不会占满两个槽。
- 视频回应写心情补上 `castalia.enabled` 闸门，和开口路径一致。

### 10.3 还没统一的一处

两条触发写的都是渲染层 `moodHistory`——提示词和面板读它。引擎的 `psyche_state` 看不到这两类事件，所以日记里"互动传感器"那一行不会因为它们变化。要统一，得先决定这两类事件怎么变成 VAD（或让引擎接受标量心情），那是另一个设计决定，不在本批。

### 10.4 验证

- `castalia-plugin`：123 passed / 16 files。
- `stage-ui`：`video-share` 10 passed、`self-initiated-speech` 7 passed、六件套 134 passed。
- `eslint`：改动文件 0 新增（`agent-state.ts` 13 条 `if-newline` 与 HEAD 相同）。
- `vue-tsc`：改动文件无错误。


## 11. 2026-11-05 第四批：看过的视频进日记

### 11.1 改了什么

| 位置 | 改动 |
| --- | --- |
| `stage-ui/stores/modules/diary.ts` | 新增 `appendThought(thought)`：调用方构造整条 `Thought`，store 只落库、并在当前卡下立即可见 |
| `renderer/stores/video-autonomy.ts` | 每看完一条片子，除了既有的 `memory.write`，再写一条 private 念头（topic `watched-video`） |
| 同上 | 记忆写的人称修正：`cardStore.activeCardId` → `memory.resolvePersona(...)`，和聊天、分享视频落在同一个 persona |

日记行的样子：`看了《标题》，为什么想看的。片子的前几行摘要`。它由视频路径自己拼，没有和说话路径、也没有和 memory 条目共用参数或 helper。

### 11.2 为什么不共用参数

两条事件的语义不同：

- 分享视频的回应是**对主人的反应**，值是心情（+2/+1/−1），落在 `moodHistory`。
- 她主动开口是**她自己做的一件事**，值是 +1，也落在 `moodHistory`。
- 看过的片子是**她自己看过的东西**，落在日记（private 念头）和长期记忆（可召回摘要）。

如果抽一个 `recordEvent(kind, value, text, persona, ...)`，调用方就要传它并不拥有的语义。所以三处各写各的，参数各自构造。

### 11.3 仍未统一

`moodHistory` 的两条事件（说话、视频回应）仍然不进引擎 `psyche_state`，日记的"互动传感器"那一行不会因为它们变化。要统一，得先给它们一个 VAD 或让引擎接受标量心情——那会引入共享参数，本次没有做。

### 11.4 验证

- `diary-distill.integration`：7 passed（新增 `appendThought` 一条）。
- `apps/stage-tamagotchi` `vue-tsc`：`video-autonomy.ts` 与 diary store 0 error。
- `eslint`：三个改动文件 0 条。


## 12. 2026-11-05 第五批：进引擎

### 12.1 落点

| 副本 | 改动 |
| --- | --- |
| `D:/AI/castalia/Castalia-Anima/src/store.ts` | `saveConversationTurn` 新增 `initialAffect`，行落 `analyzed` + VAD，且不入 VAD 队列 |
| `D:/AI/castalia/Castalia-Anima/src/selfCycle.ts` | `formatDiary` 在无证据且无事件时输出 `unknown（暂无评估）` |
| `AIRI packages/castalia-plugin/src/vendor/engine/*` | 已与 canonical 逐行一致（只差镜像头与 sqlite-shim 的 type import） |

### 12.2 构建与部署

- `npm run build`（gen_version + `tsc -p tsconfig.build.json`）通过。产物里 `dist/store.js` 有 3 处 `initialAffect`，`dist/selfCycle.js` 有「暂无评估」。
- 运行副本 `D:/castalia/run/Castalia-Anima/dist` 只替换了 `store.js` 和 `selfCycle.js`，替换前备份为 `.bak-<ts>`，`cmp` 与源码 dist 一致。
- `CastaliaNode.exe --check` 两个文件都通过。

### 12.3 冒烟

`CastaliaNode.exe dist/index.js` + stdio `initialize`：

```
[castalia] v1.28.8 started — unified MCP server
serverInfo {"name":"castalia","version":"1.28.8"}
tools 43
```

库指向 scratch（`MEMORY_DB_DIR`），`cwd=C:/`，没有在仓库里留 `memory/`。

### 12.4 没有重启任何进程

当前在跑的 5 个 `CastaliaNode` 子进程加载的都是 `run/Castalia`（标准版），没有进程持有 `run/Castalia-Anima`。下一次 spawn（酒馆插件、stdio 后端）会直接用新文件。

### 12.5 附带发现

canonical 提交里的 `dist/db.js`、`dist/psycheState.js` 落后于它们自己的 `src`（重新构建会改这两个文件）。本次只部署了改动涉及的两个文件，运行副本的其余文件仍与 HEAD 的 `dist` 一致。这条已补进 skill，避免下次整目录覆盖时把未评审的编译差异一起铺上去。


## 13. 2026-11-05 第六批：日记与看片的资料分开

前一批把看过的片子写成一条 `watched-video` 念头塞进思绪流，结果是两份数据同表：日记页里她的念头和她的片单混在一列，蒸馏还可能拿「看了《…》」当那一天的标题。

这一批改成两份数据、页面做连接。

| 数据 | 落点 | 消费者 |
| --- | --- | --- |
| 她的念头 | `airi-mind/thoughts`（IndexedDB），topic `self-cycle` / `held-back` | 日记页、蒸馏、自言自语 |
| 看过的片子 | `video-watch/queue`（localStorage），`state: 'watched'` + note | 日记页（按天连接）、召回工具、分享卡片 |

改动：

- `video-watch` 新增 `watchedByDay`：按本地日 `YYYY-MM-DD` 分组，组内保持新到旧。
- 日记页在每一天里加「看过的片子」小节，读 `watchedByDay[day.date]`，只显示时间和标题；正文仍在片单和长期记忆里。
- 删掉 `diary.appendThought` 与视频路径对它的调用：思绪流里不再出现 `watched-video`。
- 蒸馏因此看不到视频行，那一天的标题只会来自她自己的想法。

没有改的：

- 兴趣仍然交织。`curiosityOf()` 还是读心情和唤醒度，「主人点开我分享的视频」那 +2 也仍然抬高下一次看片的概率。这是有意保留的。
- 视频行不进自言自语（本来就不进），也不进「她说出口的」。

验证：`video-watch` 8 passed（含按天分组）、`diary-distill.integration` 6 passed；`eslint` 0 条；`vue-tsc`（stage-pages 与 app）见收尾。


## 14. 2026-11-05 第七批：两条链一直查到记忆体

两条链分开之后，往下追到长期记忆体。库是 `D:\castalia\memory-banks\airi\airi`，只读打开。

### 14.1 现状数字

| 项 | 值 |
| --- | --- |
| 活跃记忆 | 273（general 212 / project 46 / user 12 / reference 2 / feedback 1） |
| 自循环日记 | 42 行，全在 project 分库，source `agent_diary`，名字都是「情感记忆: [自循环日记]」 |
| 记忆向量 | `vec_memory` 173 行；切片向量 `vec_chunk` 328 行 |
| 嵌入空间 | `BAAI/bge-m3`，1024 维 |
| facts | 88 行，`source_memory_source` 全空（旧数据）；实体链接只来自 `reflect_summary` |

### 14.2 线 A：日记 → 记忆体

两个写者，两套落点：

| 写者 | 落点 | 来源标记 | 召回 | 反刍/衰减 |
| --- | --- | --- | --- | --- |
| 引擎自循环 `saveSelfDiary` | project 分库，`skipEmbed` | `agent_diary` + `metadata.generated_by=self_cycle` | 默认排除 | 排除 |
| 设置页「记住这一天」`memory.write` | general 分库，有向量 | `airi`（store 默认） | 可召回 | **不排除** |

修掉的两处：

- `listMemories` 没有来源过滤，42 条自循环日记进了长期记忆页，名字全一样、描述为空。现在过滤 `agent_diary`。
- 索引的日期识别是 `^(\d{4}-\d{2}-\d{2})`，而蒸馏条目叫 `diary-2026-11-01`，所以它从来没进「最近」段，`INDEX_PER_DAY` 也从没生效。正则改成接受 `diary-` 前缀。

### 14.3 线 B：看片 → 记忆体

每看完一条写一行 `看过的片子 <标题>`：general 分库、source `airi`、`subject: self`、importance 0.5、**有向量**（一次 bge-m3 调用一条）。名字带标题所以不合并，库随看片次数线性增长；队列只留 30 条，库不删。

索引侧是健康的：描述都是同一句，`distinct()` 把它们折成一行（已加测试）。

### 14.4 两条线共同的缺口

**G1 开关不拦写（已修）**。`write()` 原来不检查 `enabled`，而 `read` / `recall` / `ingest` 都检查。记忆模块关着，日记蒸馏和看片记录照样进库。现在 `write()` 返回 `{ ok: false, reason: 'disabled' }`，蒸馏页会显示「没记住」并保持可重试。

**G2 派生文本没有派生标记（未改）**。蒸馏日和看片摘要都写成 `source='airi'`，而 `consolidate()` 的候选查询只排除 `agent_diary` / `agent_state`。后果：她自己的日记摘要和片子摘要会被当成证据，参与相似合并和 facts 抽取。这跟 10-31 报告「派生记录不得回流成证据」冲突。修法需要新的来源类（例如 `airi_derived`）或按 `metadata.generated_by` 排除，vendor 与 canonical 都要同步。

**G3 「记住这一天」会把 private 念头写进记忆体（未改）**。`distillDay` 的 description 取当天第一条（没有 shared 时就是 private 那条），body 里也有 private 原文。页面上 private 要手动展开，但记忆索引和 `read` 对模型是直接可见的，这层区分在记忆体里丢了。

**G4 蒸馏条目会按普通记忆衰减（未改）**。`airi` 行不在 decay 的排除名单里，60 天没人访问就可能被剪。本地日记还在，可以重建，但「记住」并不永久。

### 14.5 验证

- `stage-ui`：`memory.test` 22 passed、`diary-distill.integration` 6 passed、`video-watch` 8 passed。
- `castalia-plugin`：全量 123 passed；`bank/index.test` 21 passed。
- `eslint`：改动文件 0 error（`bank/index.ts` 的 15 条是 HEAD 既有）。

## 15. 2026-11-06 第八批：日记独立分区

### 15.1 需求

日记摘要要存下来，但普通检索不能拿到它。四条：

1. 日记摘要当记忆存着，可以算事实。
2. 普通检索（search / 注入 / 提示词索引）不返回它，只有显式「搜日记」才给。
3. 星图上不出现。
4. UI 入口只有设置菜单里的日记页。

### 15.2 为什么是新分区，而不是 `source='diary_day'`

`MEM_TYPES = [user, feedback, project, reference, general]` 是**目录扫描名单**。`listMemTypeDirs()` 写死 `base.includes(f)`，所以不在名单里的目录，对下面这些路径天然不可见：

| 路径 | 维度 |
| --- | --- |
| 跨库召回、反刍 `consolidate`、衰减 `decay`、`stats`、`memory_graph`、会话盘点 | 全部按 `MEM_TYPES` 枚举目录 |

日记落在 `<bank>/<project>/diary/memory.sqlite`，每行 `memType: 'diary'`。只有显式 `DatabaseManager.getInstance(project, 'diary')` 才读得到。

沿用 `source='diary_day'` 的话，隔离就变成「每个扫描点都记得加一条 `source` 过滤」。漏一处就泄漏，14.4 的 G2 与 G4 就是这样来的：反刍把派生文本抽成 facts，衰减把蒸馏日记当普通记忆剪掉。

### 15.3 三家参考

| 系统 | 做法 | 对应哪一条 |
| --- | --- | --- |
| MemGPT / Letta | core memory 常驻上下文，archival memory 只通过 `archival_memory_search` 按需取，从不自动注入 | 第 2 条 |
| Claude memory tool | `/memories` 是一个文件系统，模型自己 `view` 才看到内容 | 第 4 条 |
| OpenClaw | 记忆是 workspace 里的 markdown，按需读文件 | 第 3 条 |

一致做法：独立命名空间 + 显式工具 + 不自动注入。

### 15.4 落点

| 文件 | 改动 |
| --- | --- |
| `packages/castalia-plugin/src/vendor/engine/memType.ts`、`D:\AI\castalia\Castalia-Anima\src\memType.ts` | `DIARY_MEM_TYPE` + `normalizeMemType` 认它（两份同步） |
| `packages/castalia-plugin/src/bank/index.ts` | `saveDiaryDay` / `searchDiary` / `listDiaryDays` |
| `apps/stage-tamagotchi/src/shared/eventa/castalia-memory.ts` | `castaliaMemoryRememberDay` / `castaliaMemorySearchDiary` 两个 invoke |
| `castalia-engine.ts` / `castalia-inprocess.ts` / `castalia-memory.ts` / `App.vue` | 实现与挂载 |
| `packages/stage-ui/src/stores/memory.ts` | 端口 `rememberDay` / `searchDiary` + `diarySupported` |
| `packages/stage-ui/src/stores/modules/diary.ts` | `distill()` 改走 `rememberDay`，不再写 general |
| `packages/stage-ui/src/tools/castalia.ts` | `builtIn_castaliaSearchDiary` 工具 |

一天的文本是 `# diary-YYYY-MM-DD\n\n<description>\n\n<body>`，`type: 'episodic'`、`category: 'diary'`、`subject: 'self'`、`importance: 0.6`、`source: 'diary_day'`。不设 `skipEmbed`，`searchDiary` 要走向量。

### 15.5 替换语义

同一天重记 = 替换。`saveDiaryDay` 先按 `text LIKE '# diary-<date>%'` 软删旧行（`is_active = 0`），再插入新行。

不用 `updateMemory`：它按 `findDbByMemoryId` 定位库，diary 分区可能找不到那条行。

### 15.6 星图为什么自动干净

`memory_graph` 只读 base 5 个分区的 `memory_entities` 与 `memory_edges`。diary 分区不在这份名单里，实体和边都不会生成。

### 15.7 提示词索引

`DAY_PREFIX` 回到 `^(\d{4}-\d{2}-\d{2})`。14.2 里为让蒸馏条目进 recent 段而加的 `diary-` 前缀已经回退：日记不该出现在索引里，正则多认一个前缀只是当初为了「看得见」。

### 15.8 模型侧的入口

`builtIn_castaliaSearchDiary`（`packages/stage-ui/src/tools/castalia.ts`）。工具描述写死边界：只在她自己提起日记、或主人明确问起时调用。

实现是 `memory.searchDiary(query, 5, persona)`。工具只在 `castalia.enabled && memory.enabled && memory.diarySupported` 时注册。`diarySupported` 在 `attachRemote` 时按「端口有没有 `searchDiary`」置位，避免把「没有通道」说成「日记里没有」。

### 15.9 与 14.4 的 G2 / G3 / G4

- **G2 派生文本回流**：日记不再进 base 5 个分区，反刍扫不到，问题消失。
- **G4 衰减**：衰减同样只扫 base 分区，日记不再被 60 天剪掉。
- **G3 private 念头进 body**：仍未改。页面上 private 要展开才看得到，模型侧却能直接读到。现在被「显式才读」包住，是否把 `description` 限定成 shared 仍是待定项。

### 15.10 验证（2026-11-06）

- `castalia-plugin`：全量 16 files / 124 tests 通过，含 `bank/index.test` 的「日记日不进 listMemories、不进默认 search」用例。
- `stage-ui`：`memory.test`、`tools/memory.test`、`diary-distill.integration`、`tools/castalia.test`、`video-watch.test` 共 5 files / 53 tests 通过。
- `stage-ui` 全量 node 套件：1250 条里 20 条失败，全在本次未改的文件（`characters`、`display-models`、`airi-card`、`providers/config`、`speech`、`onboarding`、`use-vision-inference`）。这些是缺模块 / HEAD 既有破坏（`airi-card.ts` 重复函数、`libs/file-transfer/transfer` 等解析不到），与本批无关。
- `stage-tamagotchi` `vue-tsc --noEmit -p tsconfig.json`：34 条 error，全在未改文件（`auto-updater.test` 25 条，其余为 `airi-card`、`wire-message`、`feature-flags`、`registry`、`display-models.repo`、`holo-coupon.vue`）。本批文件 0 条。
- `eslint`：`memory.ts`、`modules/diary.ts`、`diary-distill.integration.test.ts`、`tools/castalia.ts`、`tools/castalia.test.ts` 0 error。
- 「跑 `castalia-plugin` 全量前先清 `PSYCHE_BAND_ENTER` / `PSYCHE_BAND_HOLD` / `PSYCHE_BAND_CENTER_OFFSET`」：当前 shell 里带着这三个变量（并行会话留下的），会让 `psyche-layered.test` 的默认中心用例失败。清掉后全绿。

### 15.11 遗留

- 独立引擎 `D:\castalia\run\Castalia\dist` **未重建**。那边的 `memType.js` 不认识 `diary`，所以日记分区只在 app 进程内可用，5 条桥（3310–3318）没有这个功能。要上线就 `npm run build` 后拷 `dist/memType.js`。
- `listMemTypeDirs` 的 `base.includes(f)` 既是隔离的关键，也是陷阱：以后谁把 `diary` 加进 `base`，隔离立刻失效。
- 一天一次 bge-m3 调用。测试库走 `allowNoConfig` → `EMBED_MODE=none` → 只有 FTS，断言用英文词（`midnight`）比中文稳。

## 16. 2026-11-06 第九批：v0.13.1 升级留下的孤儿测试

### 16.1 现象

全量 `stage-ui` node 套件 1250 条里 20 条失败（9 个文件），`stage-tamagotchi` typecheck 34 条 error。

### 16.2 根因

**不是并行会话今天改坏的。** 证据在 git：

`d02629d25 vendor: upgrade AIRI fork to upstream v0.13.1`（2026-10-29）一次删掉 **802 个文件**：hosted 账号层、云端 provider、文件传输、云同步、onboarding 的登录分支。引用这些模块的测试和小部分生产代码没有跟着删。

| 文件 | 引用的东西 | 状态 |
| --- | --- | --- |
| `stores/providers/provider.test.ts` | `libs/providers/providers/official`、`services/inference-service-providers`、`stores/auth` | 三者都在 d02629d25 被删 |
| `stores/providers/config.test.ts`（15 条） | 同上 + 云端副本 API（`onAfterSync`、`syncProviders`） | 同上 |
| `stores/display-models.test.ts` | `services/display-model-sync`、`libs/file-transfer/transfer`、`stores/auth` | 同上 |
| `stores/modules/airi-card.test.ts` | `libs/character-card-sync`、`applySynchronizedCards` | 同上 |
| `stores/modules/airi-card-inheritance.test.ts` | `libs/providers/providers/official`、`better-auth`、`stores/auth` | 同上 |
| `stores/modules/speech.test.ts` | `OFFICIAL_SPEECH_*` 标识符（import 被删，引用还在） | 同上 |
| `stores/onboarding.test.ts` | `closeAfterAuthentication` | 随登录分支删除 |
| `services/characters.test.ts` | `charactersService.fetchRemote` | 随 characters API 删除 |
| `libs/chat-sync/wire-message.ts` | `@proj-airi/server-sdk-shared` | 离线同步层删除 |
| `apps/stage-tamagotchi/.../auto-updater.test.ts`（25 条 error） | `@ergosphere-it/electron/main` 的 `Updater`、`setPreferredUpdateLane` | 测试写的是另一套 updater 实现 |

另外三条是**改签名却没同步测试**，不是删除：

- `stores/modules/airi-card.ts` 有两份 `resolveModules`：`5610b5f61` 合并时把新旧都留下了，TS2393；运行时后一份覆盖前一份，逻辑等价但白占一份。
- `use-vision-inference` 的超时从 60 s 改成 90 s（`65895c381`），测试还推进 60 s，于是等到 20 s 的测试超时。
- `addCard(card, source, displayModelId)` 变成 `addCard(card, displayModelId)`，三处测试还在传 `'scratch'` / `'import'`；那个字符串落进了 `displayModelId`，预设模型就成了空。

### 16.3 处置

修：

- `airi-card.ts` 删掉后一份 `resolveModules`，保留带 NOTICE 的那份。
- `libs/providers/providers/registry.ts` 去掉 official provider 的 4 个类型与联合项。
- `database/repos/display-models.repo.ts` 把 `TransferTask` 换成本地 `StoredTransferTask`（旧行仍可读）。
- `pages/settings/modules/speech.search.ts` 去掉 `cardOf`，搜索助手用默认的自身映射。
- `holo-coupon.vue` 只对 `{ type: 'route' }` 跳转，`login` 在这个 fork 里只关闭。
- `feature-flags.ts` 调 `resolveFeatureFlag` 时补上 fork 的两个常量（无 policy、未登录）；三个 flag 都是 `availability: 'local'`，只走本地分支。
- `auto-updater.ts` 删掉 `latest` / `alpha` / `beta` 三个不可能的分支（`UpdateChannel` 只有 stable/canary/nightly/dev），并补上漏掉的 `dev`。
- `libs/chat-sync`：只保留 `extractMessageText`（移到 `message-text.ts`），云端 wire/merge 代码删除。
- `use-vision-inference.test.ts` 对齐 90 s；`characters.test.ts` 改测 `buildLocalCharacter`；`airi-card.test.ts` 去掉 `applySynchronizedCards` 整块和 `source` 参数，模型删除语义改成「本地删掉即删引用」。

删（整文件都是已移除能力的测试，git 历史可找回）：

`stores/providers/provider.test.ts`、`stores/providers/config.test.ts`、`stores/display-models.test.ts`、`stores/modules/airi-card-inheritance.test.ts`、`libs/chat-sync/wire-message.test.ts`、`stage-tamagotchi/.../auto-updater.test.ts`。

保留但删掉个别用例：`onboarding.test.ts`（登录完成即关闭）、`speech.test.ts`（official/streaming 的语音自动挑选，`picksSpeechVoiceAutomatically` 在这个 fork 里恒为 false）。

### 16.4 结果

| 检查 | 之前 | 现在 |
| --- | --- | --- |
| `stage-ui` node 套件 | 20 failed / 1230 passed | **156 files / 1272 passed** |
| `stage-tamagotchi` typecheck | 34 error | **0 error** |
| `castalia-plugin` | 124 passed（清 `PSYCHE_BAND_*` 后） | 124 passed |
| `stage-pages` typecheck | 7 error | 7 error，全是 motion store 的既有问题（`arHmmStateCount`、`method`），与本批无关 |
| eslint（本批改动文件） | — | 0 error（9 条既有 warning） |

### 16.5 独立引擎仍未动

Anima 仓库重建后 `dist/memType.js` 带 `DIARY_MEM_TYPE`；`D:\castalia\run\Castalia\dist` 是 **1.27.0** 的构建，而 Anima 现在是 **1.28.8**。两个版本不同源，只拷一个文件会造出混合构建，所以这次没有部署。日记分区目前只在 app 进程内可用，5 条桥（3310–3318）没有这个功能。
