# 情感循环 + 记忆体：她怎么记得、怎么会变、什么时候开口

写于 2026-11-12，对着 `ehwin/feat/diary-partition` 的代码读出来的，不是设计文档的回述。
每条结论后面挂 `path:line`，读到这里的人可以直接跳过去核。凡是我没核实的，会写「未核实」。

先给三句话，剩下的是它的推导：

1. **她的心情是一个单写者状态机**，输入是「绝对目标 + 有界跟随」，主要瓶颈不在数学而在**输入太少**：自动估计器只判 8.6% 的句子，闸门默认还是关的。
2. **她的记忆是一个分库 SQLite**，按 `库/项目/用途/memory.sqlite` 铺开，`general` 存对话与事实、`diary` 与 `thoughts` 各占一个不进枚举的分区，提示词里只放得下 1900 字的三段索引。
3. **她什么时候开口，决定性的一关不是「想不想」而是「能不能」**：想不想每秒算一次（60s 基准，最紧能压到 40s），能不能由闸门说了算（1 小时间隔、23–7 静默、每天 8 条、3 条没人应答就停），再叠一层睡眠与锁屏/忙碌裁决。

---

## 1. 全景：三个环，三种周期

| 环 | 谁在跑 | 周期 | 真源 |
| --- | --- | --- | --- |
| 情感环 | 引擎 `psycheState` | 事件驱动（每条被采纳的证据推一次） | `<bank>/<project>/general/memory.sqlite` 的 `psyche_state` / `psyche_events` |
| 记忆环 | 引擎 `bank` + 主进程调度 | 每轮对话写、每天 04:00–06:00 整理 | `<bank>/<project>/{general,diary,thoughts,...}/memory.sqlite` |
| 开口环 | 渲染层 `self-initiated-speech` | 每 1 秒跳一次 | localStorage 的 outbound 状态 + 主窗口内存 |

三个环共用一个方向：**记忆喂情感，情感与心智决定开口，开口又写回记忆**。下面分别拆。

---

## 2. 情感循环（psyche）

### 2.1 状态字段与初值

状态机本体 11 个字段（`packages/castalia-plugin/src/vendor/engine/psycheState.ts:40`）：

| 字段 | 含义 | 初值 / 范围 |
| --- | --- | --- |
| `version` | 单调版本号，只在**真正采纳**证据时 +1 | 1 起 |
| `hasEvidence` | 是否曾有过证据 | `false` |
| `lastEvidenceAt` | 最后一条证据时间 | `-1` |
| `salience` | 上一条证据的显著度 | 0，夹在 0..1 |
| `baseline` | 人格底色 | valence 0.4 / arousal 0.3 / dominance 0.6（`psycheState.ts:80`） |
| `vad` | 当前情绪 | 初值等于 baseline（`psycheState.ts:415`） |
| `mood` | 慢层心境 | 同上，慢层默认关闭时每次跃迁后被强制等于 `vad`（`psycheState.ts:203`） |
| `band` | 分档 | `negative \| neutral \| positive` |
| `processedEventIds` | 幂等去重集 | 上限 128，超了丢最老（`psycheState.ts:496`） |
| `valenceBias` | 冻结的极性偏置 | 1（负向偏离时 1.6） |
| `updatedAt` | 最后推进时间 | — |

不在 psyche 里的两个容易混的量：标量 `currentMood`（-10..+10，7 小时半衰期，`vendor/engine/agentState.ts:145`）和 `currentDesire`（字符串，直接覆盖、不衰减，`agentState.ts:137`）。`energy` 在 `agentState.ts:190`：0..100、初值 100、按 `exp(-0.05·h)` 自衰减，**一旦宿主 mind 推过 `setEnergy` 就转成纯镜像、不再自衰减**。

> 顺带纠正一个常见误读：psyche 里**没有** `relationship stage` 字段。关系阶段在 `packages/core-agent` 的关系层，记忆分类里的 `relationship` 只是条目分类（`vendor/engine/db.ts:924`）。

### 2.2 推进的数学

一次推进的形状是固定的（`psycheState.ts:443`）：先把 `now` 夹到不早于 `updatedAt`（防重放把时钟拨回去），算 `elapsedHours`，做**两层时间松弛**，再对被采纳的证据施加有界增量，最后重算 band。

- **衰减是半衰期形式，不是 τ**：`baseline + (current - baseline) · 0.5^(elapsedHours / halfLife)`（`psycheState.ts:284`）。
- **快层半衰期（单位是 H）**：valence **1.97h**（= E2 拟合 τ 2.85h × ln2）、arousal 4h、dominance 36h。注释明确后两维没有人类时序数据（`psycheState.ts:188`）。这里曾经把 τ 当 H 用，等于把衰减调慢 44%，2026-10-31 审稿复核后改的。
- **valence 的实际半衰期会被放大**：`halfLife.valence × valencePersistence × persistence`，其中 `persistence = clamp(1 + saliencePersistence·上一条 salience, 1, 4)`（`psycheState.ts:471`）。
- **两层用闭式解而不是逐次松弛**：`kf=ln2/Hf`、`ks=ln2/Hs`、`kl=ks/max(1,relaxRatio)` 解特征值（`psycheState.ts:307`）。好处是 288 次五分钟读和 1 次 24 小时读落在同一个点——所以「她睡了一夜心情回落多少」不依赖读的次数。
- **有界增量一次塞进四条性质**（`psycheState.ts:385`）：反向折扣（`inertia` 0.55）、向下放大（`negativeImpact` 1.35）、饱和（`× (1 - 0.5·|current|)`）、单步限幅（`maxStep` 0.35）。
- **增益按证据种类分**：`target`（绝对观测）`targetGain` 0.55，`event`（有符号增量）`eventGain` 0.35（`psycheState.ts:505`）。
- **band 带滞回**：中心 `= baseline.valence + bandCenterOffset`（默认 0.40），`rel = valence - center`；`rel ≥ enter(0.25)` 进 positive，`rel ≤ -enter` 进 negative；已在某档时 `rel > hold(0.1)` 就保持（`psycheState.ts:259`）。换成默认值：**v ≥ 0.65 进 positive、v ≤ 0.15 进 negative；positive 保持到 v > 0.50、negative 保持到 v < 0.30**。

### 2.3 写入通道：只有两条是真写

全仓只有两个 `applyPsycheAppraisal` 调用点（`vendor/engine/emotion.ts:1111`）：

| 通道 | 入口 | 门槛 | 幂等键 |
| --- | --- | --- | --- |
| 自动估计（词表 + 模型） | `flushVadQueueDetailed` | `process.env.PSYCHE_FROM_VAD === 'on'`，且这批确实有 `pending_psyche` 行（`emotion.ts:1171`） | `vad:<project>:<ids.join(,)>`，按持久行 id 规范化拼（`emotion.ts:819`） |
| 显式写入 | Eventa `castaliaMemoryApplyEmotion` → `engine.applyEmotion` | 面板开关 `moduleEnabled.castalia`（关掉回 `disabled`，写失败回 `persist_failed`）（`apps/stage-tamagotchi/src/main/services/airi/castalia-memory.ts:405`） | 调用方给：`emotion:turn:<conversationId>:<turnId>`（`packages/stage-ui/src/stores/chat.ts:712`） |

reflection / self-cycle **只读不写**：`runSelfCycle` 先 `getPsycheState` 再 `formatDiary`，把 band/VAD 写进日记文本，没有任何回写（`vendor/engine/selfCycle.ts:382`）。夜间维护是**间接**通道：每 30 分钟看一次本地时间，落在 04:00–06:00 就跑 `runMaintenance`，最终经 digest → `flushVadQueueDetailed` 回到自动链，所以照样受 `PSYCHE_FROM_VAD` 约束（`apps/stage-tamagotchi/src/main/services/airi/castalia-memory.ts:274`）。

### 2.4 并发与重放：四道闸

1. 整段读-改-写跑在 `BEGIN IMMEDIATE` 事务里。注释给了失效场景：两个 worker 都读到 version N，后写者会把前者的事件从 VAD 和 `processedEventIds` 里一起抹掉（`psycheState.ts:861`）。
2. `processedEventIds` 去重，重复 id 时 `shouldApply=false`，只走衰减（`psycheState.ts:496`）。
3. `observedNow` 要求 `!duplicate`，所以重放同一条事件不会把已过 TTL 的 `hasEvidence` 翻回 true（`psycheState.ts:580`）。
4. 冻结 `valenceBias`：让「durable 读回再推进」与内存推进逐位相等（`psycheState.ts:456`）。

事件轨迹落在 `psyche_events`，保留 `PSYCHE_EVENT_RETENTION_DAYS` 默认 90 天，写失败只 warn、不阻断跃迁（`psycheState.ts:807`）。

### 2.5 可调参数

面板画的是 `ACTIVE_TUNING_SPECS = ENGINE_TUNING_SPECS ?? TUNING_SPECS`；本 fork 的 `TUNING_SUPPORT` 是 `null`，所以走静态 29 项清单，key 就是环境变量名（`vendor/engine/tuningSupport.ts:8`）。

| 组 | key | 默认 |
| --- | --- | --- |
| band | `PSYCHE_BAND_CENTER_OFFSET` | 0（-0.6..0.6） |
| band | `PSYCHE_BAND_ENTER` / `PSYCHE_BAND_HOLD` | 0.25 / 0.1（hold 必须 < enter） |
| 快层 | `PSYCHE_HALF_LIFE_{VALENCE,AROUSAL,DOMINANCE}_HOURS` | 1.97 / 4 / 36（单位 H） |
| 慢层 | `PSYCHE_MOOD_HALF_LIFE_*_HOURS` | **引擎默认 0/0/0 = 关闭**；面板写 45.75/16/144 |
| 增益 | `PSYCHE_TARGET_GAIN` / `PSYCHE_EVENT_GAIN` / `PSYCHE_MAX_STEP` | 0.55 / 0.35 / 0.35 |
| 像人 | `PSYCHE_NEGATIVE_IMPACT` / `_NEGATIVE_PERSISTENCE` / `_INERTIA` / `_SATURATION` / `_SALIENCE_PERSISTENCE` | 1.35 / 1.6 / 0.55 / 0.5 / 1 |
| 证据 | `PSYCHE_EVIDENCE_TTL_HOURS` / `PSYCHE_EVENT_RETENTION_DAYS` | 72 / 90 |
| 检索 | `WEIGHT_{CONSISTENCY,EMOTION,TIME,DEVIATION}`、`MEMORY_INJECT_{MIN_SIM_LEXICAL,MIN_SIM,STRONG}` | 1 / 0.12 / 0.03 / 0.1、0.2 / 0.5 / 0.5 |

（`packages/castalia-plugin/src/tuning.ts:41`、`:82`、`:115`、`:159`、`:193`、`:246`、`:511`）

### 2.6 已知缺陷（代码注释自认的）

- **自动估计器覆盖率极低**：注释直接写词表「abstains on most turns (8.6% judged)」（`castalia-memory.ts:412`）。所以闸门关着时 psyche 基本不动。
- **词表评分已被降级摘除**：CPED 分层 300 条实测 κ=0.015、命中率 7.3%、命中处符号一致率 50%，现在只写 `affect_status='abstain'`（`vendor/engine/emotion.ts:750`）。
- **`PSYCHE_FROM_VAD` 只认小写 `on`**，`ON`/`1` 不算，而且它**不在面板参数清单里**，只能靠环境变量或 config 设（`castalia-memory.ts:449`）。
- **文档与代码不一致**：`docs/psyche-write-policy.md` 说 `=on` 时显式写入返回 `estimator_active` 且不动 psyche，但该拒绝逻辑已删；`estimator_active` 现在只剩类型联合、没有生产者（`apps/stage-tamagotchi/src/shared/eventa/castalia-memory.ts:271`）。
- **慢层默认关**是产品决定不是拟合结论；关着时 `mood` 每次跃迁后被强制等于 `vad`（`psycheState.ts:203`）。
- **面板默认值陷阱**：面板把慢层 valence 写成 45.75，而 `coerceTuning` 会把「等于 spec.default」的值当默认丢弃（`tuning.ts:515`），用户照面板默认保存等于什么都没设。
- **双算风险**：`MEMORY_AUTO_PROCESS` 默认 1，走 fullAuto 时显式判定拿不到行 id、不参与去重，行仍是 pending，自动链之后还会判同一轮（`packages/castalia-plugin/src/bank/index.ts:589`）。
- **两套常数容易混**：`psycheState` 用 1.97/4/36 的小时半衰期；`emotion.ts` 的 `DECAY_TAU` 是 24/4/36 的 τ，只用于旧记忆显示衰减（`vendor/engine/emotion.ts:90`）。

---

## 3. 记忆体（Castalia bank）

### 3.1 物理布局

```
<bankDir>/<project>/<memType>/memory.sqlite
```

- 没有 `castalia-engine.json` 时用 `<userData>/memory-banks`；一旦有配置就完全按 `bankDir`，不用默认值盖掉坏路径（`apps/stage-tamagotchi/src/main/services/airi/castalia-engine.ts:106`）。
- 实机一致：`D:/castalia/memory-banks/airi/airi/{general,user,feedback,project,reference,diary,thoughts}/memory.sqlite`。
- **project 是目录名**（默认 `airi`），**persona 不是目录而是 `memory.character_id` 列**；`general` 里 `character_id` 为空的行等于通用条目（`packages/castalia-plugin/src/bank/index.ts:131`）。
- 目录枚举白名单只有 `general/user/feedback/project/reference`；**`diary` 与 `thoughts` 故意不进 `MEM_TYPES`**，所以 list、衰减、反刍、星图这些遍历路径天然看不到它们（`vendor/engine/db.ts:331`）。这就是「日记分区」的关键：日记与念头各自一个库，不会被当成普通记忆去衰减或反刍。
- 各类内容落点：

| 内容 | 库 | 表/行 | source |
| --- | --- | --- | --- |
| 对话轮次 | general | `mem-*` / `conv-<turnId>` | `conversation_log` |
| 条目（她记的笔记） | general | 正文首行 `# name`、次行 description、空行后 body，按 (name, character_id) 覆盖 | `airi` |
| 结构化事实 | general | `facts`（subject/predicate/object/confidence/is_active + 溯源列） | — |
| 情绪状态 | general | `psyche_state`（快照）+ `psyche_events`（轨迹） | — |
| 自循环 | general | `self_cycle_runs` | — |
| 日记 | **diary** | 行名 `diary-YYYY-MM-DD` | `diary_day` |
| 念头 | **thoughts** | 行名 `thought-<id>`，`skipEmbed:true` | `thought_stream` |
| 全局 | 根 | `global.sqlite`：instructions 与 projects 注册表 | — |

（`vendor/engine/db.ts:1013`、`bank/index.ts:470`、`bank/store-tools.ts:212`、`vendor/engine/search.ts:1308`）

### 3.2 传输层：四种状态，能力逐项为真或为假

| 状态 | 什么时候是它 | 能做到什么 |
| --- | --- | --- |
| `in-process` | 默认。主进程用 `node:sqlite` + sqlite-vec 直接开库 | 全部能力 |
| `stdio` | `CASTALIA_MEMORY_TRANSPORT=stdio` | 只有 list/save/forget/recall/search/facts/selfCycle |
| `entry-only` | `enabled=false`、缺 `bankDir`、目录不存在、stdio 缺 `engineEntry` | 只有条目仓储；recall 返回空块、search/facts 返回 `[]` |
| `none` | 连状态都拿不到（invoke 失败） | 全 false，附错误文案 |

- 渲染层只认这四个值，并配一张逐项布尔能力表（vadSweep/recall/search/facts/ingest/maintain/selfCycle/psyche/diary/thoughts）（`packages/stage-ui/src/stores/memory.ts:196`）。
- stdio 拉 `node <engineEntry>`，固定 `MCP_TOOLS='store,self_cycle,memory_recent,memory_search'`，并显式清空 `ELECTRON_RUN_AS_NODE`（引擎的 better-sqlite3 按外部 Node 的 ABI 编）（`castalia-engine.ts:326`）。
- stdio 缺的能力**如实报 false**（`typeof engine.x === 'function'`），不假装在线（`castalia-memory.ts:423`）。
- `castalia-engine.json` 字段：`enabled`、`engineEntry`、`bankDir`、`project`、`character`、`nodeBinary`（Full 总线另有 `fullUrl`，默认 `http://127.0.0.1:3314/mcp`），同名字段可被 `CASTALIA_ENGINE_ENTRY/CASTALIA_BANK_DIR/CASTALIA_PROJECT/CASTALIA_NODE` 覆盖（`castalia-engine.ts:103`）。

### 3.3 写：一轮对话怎么进库

- 触发点 `onAssistantTurnReady`：回答显示后 `void memory.ingestTurn({user, assistant, sessionId, persona, affect?, turnId})`，不 await、失败只落 console（`packages/stage-ui/src/stores/chat.ts:1186`）。
- `shouldSkipIngest` 只跳一类：**用户像在道别，且助手回复去空白后不超过 24 字**（一句告别不携带事实）（`stores/memory.ts:89`）。
- 空轮直接拒收：user 或 assistant 去空白后为空就回 `{ok:false, error:'empty turn'}`（纯工具调用轮常见）（`bank/index.ts:584`）。
- 两条写路径：`MEMORY_AUTO_PROCESS=1`（app 设的默认）走引擎 `autoProcess`（带 VAD 队列与会话缓冲）；否则走最小路径 `saveConversationTurn` + `observeUserMessage` + 缓冲快照（`bank/index.ts:586`）。
- **去重靠主键不靠比文本**：行 id 是 `conv-<turnId>`，`INSERT OR IGNORE` 撞主键即视为已写过；重试只在调用方给了 `turnId` 时才做，间隔 1s/4s（`vendor/engine/store.ts:683`）。
- 向量化默认 `yuan-embedding-2.0-zh`、1024 维（`vec0(embedding float[1024])`），可由 `EMBEDDING_MODEL`/`EMBEDDING_DIM` 或 `config.json` 覆盖；`EMBED_MODE` 默认 `ollama`，为 `none` 时只写无向量行（`vendor/engine/db.ts:85`）。
- 情绪两条通道见 §2.3；显式通道会把判定塞回 `explicitAffect`，让本轮 ingest 落成 `analyzed`、不进队列（`bank/index.ts:841`）。
- 日记：`rememberDay` → `saveDiaryDay`，同日先软删旧行再插，按 project+persona+name 串行（防两个窗口各插一条），**无嵌入时宁可拒收也不标「已记住」**（`bank/index.ts:383`）。念头按 id 替换、不嵌入。

### 3.4 读：1900 字的索引 + 三种检索

索引预算（`stores/memory.ts:20`、`:452`）：

| 常量 | 值 | 为什么 |
| --- | --- | --- |
| `INDEX_HER_LINES` | 10 | 「她是谁」 |
| `INDEX_OWNER_LINES` | 6 | 「主人是谁」 |
| `INDEX_RECENT_LINES` | 4 | 「最近发生了什么」 |
| `INDEX_LINE_CHARS` | 150 | 一行是地图，不是条目 |
| `INDEX_MAX_CHARS` | 1900 | 每次请求都要付 |

- 分三段的理由写在注释里：一个按时间排序的列表只回答第三个问题，实测 51 条身份事实全被最后一周挤掉。
- 先过滤：描述为空、`[情绪…` 这类过期心情行、`isTranscriptEntry` 判定的转录（`用户:`/`User:` 开头，或 `mem-*` 名且描述为空）都不进索引（`stores/memory.ts:74`）。
- 打分：`exp(-ageDays/45)` 时效项 + 锚点词（名字/生日/身份…）+0.25 + 稳定事实（第一人称或主人画像）+0.15，纯函数可测（`stores/memory.ts:373`）。
- 选行用 MMR：在 `indexScore - 0.45 × 与已选行的字符 bigram 重叠` 上取最大，避免 38 条同等重要度的身份条目靠掷硬币（`stores/memory.ts:410`）。
- 二次去重：相似度 ≥0.55 视为近重复；按日期 `perDay` 只留 1 条，否则同一晚的复述会占满 Recent（`stores/memory.ts:479`）。
- 装填是贪心的：About you → About the owner → Recent，整段放不下就整段跳过，所以预算永远不会被截半句（`stores/memory.ts:507`）。

三种检索分工（`stores/memory.ts:1071`）：

| 手段 | 门槛 | 回答什么 |
| --- | --- | --- |
| `recall` | 相似度 ≥0.5（词法 0.2），topK 5 | 值得注入的块；空文本表示「没东西值得说」 |
| `search` | 无门槛，ranked 行 | 「库里有什么」 |
| `facts` | ≥0.6 取前 3 | 结构化三元组 |

可见性：`visibleTo` = 无 persona 的通用条目 + 本卡条目；`resolvePersona` 只在库里确实存在该别名的行时才把 `default` 映射成 `airi`，**绝不回退到后端上报的 character**（那会让两张卡共用一个自我）（`stores/memory.ts:783`）。

### 3.5 维护与自循环

- `maintain` 一条流水线四段：反刍抽取（未分析对话 → memory/facts/entities）→ 整合（近重复合并、衰减、升格）→ 事件摘要（把一天压成「发生了什么」，只摘录）→ digest；跑前跑后各拍一次每库 active/facts/entities 快照（`bank/index.ts:655`）。
- 调度在主进程：每天本地 04:00–06:00 每 30 分钟探一次，启动后 3 分钟先补跑一次；`CASTALIA_MAINTENANCE=off` 可关（`castalia-memory.ts:269`）。
- 有账本与冷却：成功间隔 20 小时、失败 30 分钟重试，记 `lastAttemptAt/lastOk/lastReport`，所以 23:00 睡下跑过一次后 04:00 那次会变成 no-op 而不是二次烧 token（`castalia-memory.ts:78`）。
- 单飞：`maintenanceInFlight` 让手动按钮、夜班、睡眠路径共用同一个 Promise；结果追加到 `<userData>/logs/memory-maintenance.log`，**不写进她能读到的库目录**（`castalia-memory.ts:139`）。
- 多角色：维护按「配置角色 + 所有已打开角色」各跑一遍（`castalia-inprocess.ts:305`）。
- 自循环只在 in-process 排程，默认 360 分钟一轮、`limit:6`、`hoursBack:48`，启动后 3 分钟先跑一次；`CASTALIA_SELF_CYCLE=off` 或间隔 ≤0 即关（`castalia-memory.ts:287`）。产物是 `source='agent_diary'` 的派生日记，`listMemories` 明确过滤掉它，所以它进不了面板列表和提示词索引（`bank/index.ts:373`）。
- 去重分层：`saveMemory` 同 project+同角色整段文本精确去重（agent_diary 豁免）、条目按 name 覆盖、日记按日期软删替换、念头按 id 替换、整合阶段另有 `CONSOLIDATE_SIMILARITY` 默认 0.88 的近似合并（`vendor/engine/store.ts:202`）。
- 截断显式暴露：列表上限 2000 行，撞到就 `listStats={listed, truncated:true}` 并 warn，经 `castaliaMemoryStatus.entries` 到面板，`backendNote()` 拼成「只读到 N 条（撞上限，列表不是全部）」（`castalia-inprocess.ts:104`）。

### 3.6 已知坑

- **库里绝大多数是转录**：注释实测 270 条里 220 条是 `mem-43bf085e` 这类按轮次命名的行，描述是「用户: … 助手: …」——这正是索引必须做 transcript 过滤的原因（`stores/memory.ts:9`）。
- **「端口在」不等于「后端活」**：MCP transport 在引擎死后仍挂着；另有 okCount/failureCount/lastError，连续 2 次失败才判 `remoteDegraded`（`stores/memory.ts:127`）。
- **检索失败不能读成「没有」**：`lookup` 区分 `ok/partial/unavailable/failed`，后端没 search 能力时工具层回「这说明不了这条记忆是否存在」（`stores/memory.ts:1044`）。
- **日记正文读不回来**：引擎 `memory_get` 按 agent 的 memType 目录找，日记写在 project 分类库，实测返回 NOT_FOUND；只能退回 `memory_recent` 或直接只读连接（`castalia-engine.ts:452`）。
- **一个进程只能开一个 bank**：换 bank 会让 `alignEmbedSpace` 拿旧指纹比对新库从而清空 vec 表，所以 `openBank` 直接拒绝热切换；缺 `config.json` 也拒绝打开真实库（`bank/index.ts:311`）。
- **工具层硬上限**：name ≤64、description ≤150、body ≤2000、query ≤200、单条命中 400 字、整条答复 1400 字，多出的只报 `(+N more hits)`（`packages/stage-ui/src/tools/memory.ts:76`）。
- **召回有 800ms 死线**（原 300ms）：实测冷启动一次 recall 要 597ms，300ms 时每个会话第一轮的记忆块都被静默丢掉，表现为「她翻遍小本本也没找到」（`stores/chat/context-providers/memory-recall.ts:20`）。

---

## 4. 开口环（自主动机）

### 4.1 调度：1 Hz，单窗口

- `setInterval(tick, 1000)`，`TICK_MS = 1000`（`packages/stage-ui/src/libs/self-initiated-speech/ticker.ts:60`、`:138`）。
- 每跳先 `readInput`，没输入就返回；`sending` 为真时不发第二条，失败发送也不停循环（`ticker.ts:79`、`:87`、`:122`）。
- 这个 store **没有 synced 状态**，只用选举：`synced.onLeadershipChange`（`stores/modules/self-initiated-speech.ts:96`、`:433`）。
- 桌面端只有主窗口带 `synced-leader=true`，settings/chat/inlay/workspace/notice 全部 `false`（`apps/stage-tamagotchi/src/main/windows/main/index.ts:304`、`windows/settings/index.ts:94`），映射成 `leader-only` / `follower-only`（`renderer/window-context.ts:62`）。
- 必须单窗口，是因为**闸门状态是每窗口内存**（`outbound` 是模块级 let）：两个窗口各自放行同一节奏，她就会连说三条（`self-initiated-speech.ts:101`、`:156`）。
- 代价：选举心跳 15s、参与者失联 120s 过期，**主窗口崩溃后最长约两分钟无人接手**；而其它窗口是 follower-only，真没人接手时她彻底不说话。
- 重启不靠内存恢复节奏：`lastSpokeAt` 每次新建都是 null，真正压住她的是按角色落盘的 outbound（`lastSentAt/sentToday/dayStartedAt`）（`ticker.ts:76`、`speak-decision.ts:91`、`self-initiated-speech.ts:122`）。

### 4.2 想不想说：hybrid-drive

- 四种政策 `idle-timer` / `desire-pressure` / `energy-budget` / `hybrid-drive`，当前 `ACTIVE_SPEAK_POLICY = 'hybrid-drive'`（`speak-decision.ts:285`、`:295`）。
- `AUTONOMY_POLICY_DEFAULTS`：`cooldownMs 60_000`、`energyFloor 20`、`baseChance 0.3`、`idleChatterFactor 3`、`userGraceMs 20_000`（`speak-decision.ts:66`）。
- 共享前置拒绝，顺序固定：输入非法 → `input-invalid`；政策非法 → `policy-invalid`；`energy ≤ 20` → `low-energy`；距主人消息不足 20s → `user-recent`（`speak-decision.ts:126`）。
- 「主人消息」来自 adapter 且跳过 `notice`：她自己的主动消息不算主人说话，否则每说一次就给自己 20s 宽限（`adapter.ts:28`）。
- hybrid 间隔：`cooldownMs × chatterFactor / (energyFactor × arousalFactor × relationshipFactor)`，energyFactor 0.5~1.0、arousalFactor 1~2、relationshipFactor 1~1.45（`speak-decision.ts:143`、`:152`、`:269`）。
- `chatterFactor`：有 desire 记 1；没 desire 记 `max(1, 3 - 0.5·(stage-1))`，即 stage1 三倍、stage4 一点五倍（`speak-decision.ts:158`）。
- 掷骰只在没 desire 时发生（`chance = baseChance`），有 desire 直接放行（`speak-decision.ts:277`）。
- 算出的节奏远快于闸门：能量 100 / arousal 0 / stage 1 时闲话间隔 120s、有 desire 40s，而闸门 `minGapMs` 是 1 小时——**实际出声节奏由 §4.3 决定，政策只决定「想不想」**。

### 4.3 能不能说：闸门

判定顺序（先命中先返回）：参数健全性 → `paused` → `quiet-hours` → `unanswered-pause` → `min-gap` → `duplicate` → `daily-cap` → `allowed`（`outbound-gate.ts:221`）。

拒绝理由六个：`daily-cap`、`duplicate`、`min-gap`、`paused`、`quiet-hours`、`unanswered-pause`（`outbound-gate.ts:17`）。

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `minGapMs` | 3_600_000 | 两次主动开口的基准间隔 |
| `quietStartHour` / `quietEndHour` | 23 / 7 | 静默窗，跨午夜拆两段 |
| `dedupeWindowMs` | 14_400_000 | 话题去重窗（4 小时） |
| `dailyCap` | 8 | 每天最多 8 条，按 `dayStartedAt + 24h` 滚动 |
| `unansweredGrowth` / `_Cap` | 1.35 / 2.2 | 无人应答的减速曲线 |
| `pauseAfterUnanswered` | 3 | 连续 3 条没人理就停 |

（`outbound-gate.ts:102`、`:177`、`:199`、`:260`）

- **最短间隔不是常数**：`lastSentAt + minGapMs × unansweredMultiplier × gapFactor`，`gapFactor` 默认 0.65~1.35、每次发送时抽一次并存进状态（`DEFAULT_GAP_SPREAD = 0.35`）（`outbound-gate.ts:118`、`:144`、`:289`）。
- unanswered 曲线 `min(2.2, 1.35^unanswered)`：0→1.00、1→1.35、2→1.8225、3→2.46（截到 2.2）。**但 2.2 实际到不了**：`unanswered ≥ 3` 先被 `unanswered-pause` 拦掉，真实生效的乘数只有 1.35 与 1.8225（`outbound-gate.ts:188`、`:239`）。
- 主人一说话 `unanswered` 归零，但手设的 `paused` 不因此解除（`outbound-gate.ts:300`、`:305`）。
- 语义复用是个坑：**政策或时钟不合法也返回 `paused`**，面板上看不出「配置坏了」和「被静音」的区别（`outbound-gate.ts:222`）。

### 4.4 心智：睡、打盹、屏幕裁决

- `asleep` 起点：疲劳 ≥80 且主人已静 10 分钟；`napping`：无聊 ≥75、35≤疲劳<80、静默 ≥45 分钟、距上次午睡 ≥3 小时、当天 <2 次（`packages/core-agent/src/mind/drives.ts:295`、`:333`、`:404`）。
- 睡/盹时 tick 只推进睡眠钟，不累加清醒疲劳，也不再 think/provoke，所以夜间不会自我唤醒（`stores/modules/mind.ts:948`）。
- 对开口的影响：闸门直接以 `sleeping`／`napping` 拒绝，定时扫视也跳过（睡着不抓屏）（`self-initiated-speech.ts:315`、`renderer/App.vue:539`）。
- 结束：主人完成一轮对话即醒（先回答再收夜）；夜睡醒 无聊 -25，午睡结束 无聊 -15（`mind.ts:1166`、`:565`、`:583`）。午睡 35 分钟硬上限、只把疲劳抬回 12 点；夜睡 `wakeAt` 20、上限 10 小时（`core-agent/src/mind/sleep.ts:80`、`:68`）。
- 裁决只有四个 level：`free` / `busy` / `away` / `unknown`（`core-agent/src/mind/interruption.ts:40`）。
- 来源两路：`presence.state === 'locked'` 直接判 `away`（唯一硬事实）；屏幕裁决新鲜且 `interruptible` 明确时给 `busy`／`free`；其余一律 `unknown`（`interruption.ts:98`、`:102`、`:119`）。
- presence 每 tick（45s）刷一次并限时 2s；视觉裁决 TTL 15 分钟；开口那一刻用 `minAgeMs` 只认「这一眼之后」的裁决，旧的 `free` 不能当许可（`mind.ts:355`、`interruption.ts:74`、`:93`、`mind.ts:410`）。
- 5 分钟重看：`SCREEN_BLOCK_RECHECK_MS = 5 × 60_000`，`away`/`busy` 一次买断 5 分钟（`blockedUntil`），期间不读快照、不决策、不抓屏；只有出现更新的 `free` 才提前解冻（`self-initiated-speech.ts:173`、`:250`、`:323`）。

### 4.5 开口这一跳

- ticker 先过闸门再占用节奏：gate 拒绝只回调 `onGated`，不动 `lastSpokeAt`、不进 sending（`ticker.ts:93`）。
- `speak()` 里强制重看屏幕 `mind.lookAround({ force: true })`，用 `Promise.race` 卡 20 秒预算（`LOOK_BUDGET_MS`）（`self-initiated-speech.ts:355`、`:193`）。
- 看的那一眼超时/失败只记诊断（`look-timeout` + `lookMs`），不阻断开口——她按已知信息说话（`self-initiated-speech.ts:362`）。
- 看完仍 `away`/`busy`：买断 5 分钟、写 `screen:*` 诊断、直接 return，且**不记账**（不推 lastSentAt、不占这次开口）（`self-initiated-speech.ts:369`）。
- 发送失败（`sent.ok` 假或没文本）同样不记账，改用 `SEND_FAILED_RETRY_MS = 5 × 60_000` 冷却，避免 provider 报错时每秒重试（`self-initiated-speech.ts:180`、`:389`）。
- 只有送达才 `recordOutbound`（时间取送达时刻）+ `saveOutbound`，并落盘 `lastReason: 'sent'`、`lastSpokeAt`、`lookMs`（`self-initiated-speech.ts:397`）。
- 事后三件事：`markSaidOutLoud`（复述进日记）、`relieveAfterSpeaking`（付掉无聊）、`castalia.recordMood(1, '我主动跟主人开口了')`；若裁决非 free 且问了「你在忙吗」再记 `asked-busy`（`self-initiated-speech.ts:405`、`:407`）。
- 整条发送 180s 上限（覆盖 20s 看屏 + 模型调用），超时由 ticker 收回锁并记 `speak-timeout`，防止一次卡死的请求让她安静到重启（`self-initiated-speech.ts:233`、`:341`）。
- 诊断字段 `LoopDiagnostics`：`lastReason`、`lastReasonAt`、`lastSpokeAt`、`askedBusyAt`、`lookMs`、`gatedCount`、`running`、`updatedAt`，按角色落盘（`self-initiated-speech.ts:64`、`:84`）。

### 4.6 怎么彻底关掉她

这次把「静音」做成了真开关，落到 localStorage 的 `SILENCE_KEY = 'castalia/self-initiated-silent'`：

- 只有字面量 `'true'` 算静音；**读写异常一律读成「没静音」**（`self-initiated-speech.ts:42`、`:45`）。
- store 的 `paused` 初值就是它，所以重启后状态不丢（`self-initiated-speech.ts:185`）。
- 闸门每跳同时看「本窗口内存 `paused`」和「持久化键」，所以别的窗口（设置页/首启向导）按下开关，正在跑的 leader 一秒内就停（`self-initiated-speech.ts:306`）。
- `setSpeechPaused(next)` 做三件事：改 `paused.value`、写 SILENCE_KEY、`outbound = setPaused(outbound, next)`（`self-initiated-speech.ts:451`）。

**残留（已知，未修）**：`outbound.paused` 既不落盘也不进 `outboundByPersona` 缓存；下一跳 `outbound = outboundFor(personaId)` 又从缓存取回旧对象，所以真正生效的静音只有 SILENCE_KEY，`setPaused` 那一步在这条链上是空转（`self-initiated-speech.ts:142`、`:283`、`:150`）。

其它彻底变哑的路：`castalia.enabled === false` 会以 `module-off` 跳过（驱动、闸门都到不了）（`self-initiated-speech.ts:268`）；关掉主窗口则没人持有选举，其余窗口是 follower-only（`window-context.ts:62`）。

**SILENCE_KEY 是全局键、不分角色**：一次关掉会让同一 profile 下所有角色都闭嘴（`self-initiated-speech.ts:42`、`:306`）。

> 文档不一致：`docs/behavior.md` §8 让用户关「打断许可 `interruptAllowed`」，但该 ref 只由视觉裁决写入、没有任何 UI 能设它，照着文档关不掉（`docs/behavior.md:64`、`stores/modules/mind.ts:319`、`:786`）。

---

## 5. 三个环怎么咬在一轮对话里

1. 主人说话 → `onAssistantTurnReady`。
2. `ingestTurn` 异步写库（`conv-<turnId>` 幂等），`resolvePersona` 先决定这轮属于哪张卡。
3. 若模型给了 VAD → `recordEmotion` → `applyEmotion` → `applyPsycheAppraisal` 推 psyche（版本 +1，写 `psyche_state`，追加 `psyche_events`），并把本轮标 `analyzed`；没给 VAD 则留在 `pending_psyche` 队列，等 `PSYCHE_FROM_VAD=on` 时由自动链批量判（上限 15，另 2 分钟超龄 sweep）。
4. 下一次请求前，`stores/memory.ts` 把 1900 字的三段索引拼进 system prompt（放在缓存前缀里）；需要细节时 `recall` 走相似度门槛再取一块。
5. 每秒一跳的 ticker 读 `snapshot`（energy/desire/arousal）+ 关系阶段 → hybrid-drive 算「想不想」。
6. 想过就进闸门：静音、静默时段、无人应答、间隔、去重、日上限。
7. 过闸门再看一眼屏幕（20s 预算）→ `free` 才发；`away`/`busy` 买断 5 分钟。
8. 送达后记账（outbound 落盘）+ 写日记（`markSaidOutLoud`）+ 付掉无聊 + `recordMood(+1)`。
9. 每天 04:00–06:00 主进程整理：反刍抽取 → 整合 → 事件摘要 → digest；自循环每 360 分钟写一篇 `agent_diary`（不进索引）。

---

## 6. 这次落地的改动（首启向导 + 真开关）

| 改动 | 文件 | 为什么 |
| --- | --- | --- |
| 首启向导新增 `castalia-basics` 步骤 | `packages/stage-ui/src/components/scenarios/dialogs/onboarding/step-castalia-basics.vue`、`onboarding.vue` | 前面只在配服务商，没有人讲过「她记得住」「她会主动说话」 |
| 静音键落盘 | `stores/modules/self-initiated-speech.ts`（`SILENCE_KEY`） | `paused` 过去只在内存，设置窗口与向导各持一份、重启就忘 |
| 记忆目录透传 | `shared/eventa/castalia-memory.ts`、`main/services/airi/castalia-memory.ts`、`stores/memory.ts`（`bankDir`） | 向导与设置页要回答「记忆存在哪」，就得是真实目录；拿不到就说还没建 |
| 设置页加同一个开关 + 目录行 | `apps/stage-tamagotchi/src/renderer/pages/settings/modules/castalia.vue` | 向导里能关，设置里也得能改 |
| 文案按平台分叉 | `packages/i18n/src/locales/{en,zh-Hans}/settings.yaml` | 桌面是有路径的目录，网页是站点存储，同一句话不能两处都说 |

验证（真跑）：

```
pnpm -F @proj-airi/i18n build
pnpm -F @proj-airi/stage-ui exec vitest run src/components/scenarios/dialogs/onboarding/ --project browser
  → Tests 13 passed (13)
pnpm -F @proj-airi/stage-ui exec vitest run --project node
  → Test Files 158 passed (158) / Tests 1324 passed (1324)
pnpm -F @proj-airi/stage-tamagotchi exec vitest run --project node src/main/services
  → Test Files 37 passed | 1 skipped / Tests 340 passed | 4 skipped
pnpm -F @proj-airi/castalia-plugin test:run
  → Test Files 16 passed / Tests 127 passed
pnpm typecheck
  → Tasks: 55 successful, 55 total
```

browser 项目在本机全量跑会有 3 条稳定失败（`optional-modules` ×2、`airi-card` ×1），另有若干条随负载抖动的时序失败。**把本次改动 stash 后重跑，失败一字不差**，所以是基线，判据写在 `docs/known-lint-debt.md`。

---

## 7. 还没补的缺口

| 缺口 | 影响 | 位置 |
| --- | --- | --- |
| `outbound.paused` 空转 | `setPaused` 每跳被 `outboundFor` 覆盖，读代码的人会以为它生效 | `self-initiated-speech.ts:283` |
| `interruptAllowed` 文档写了但没 UI | 用户照着文档关不掉「打断许可」 | `docs/behavior.md:64` |
| 自动估计器覆盖率 8.6% | 闸门关着时 psyche 几乎不动，情感环事实上靠显式写入 | `castalia-memory.ts:412` |
| 慢层默认关 | 面板默认值又被 `coerceTuning` 当默认丢弃，照默认保存等于没设 | `tuning.ts:515` |
| `docs/psyche-write-policy.md` 过时 | 描述的 `estimator_active` 拒绝逻辑已删 | `shared/eventa/castalia-memory.ts:271` |
| 日记 `memory_get` 读不回 | 只能走 `memory_recent` 或直连 sqlite | `castalia-engine.ts:452` |
| 主窗口崩溃 2 分钟内无人开口 | follower-only 无人接手 | `window-context.ts:62` |

---

## 8. 证据索引

- 情感：`packages/castalia-plugin/src/vendor/engine/{psycheState,emotion,agentState,selfCycle}.ts`、`packages/castalia-plugin/src/tuning.ts`
- 记忆：`packages/castalia-plugin/src/bank/{index,store-tools}.ts`、`vendor/engine/{db,store,search}.ts`、`packages/stage-ui/src/stores/memory.ts`、`apps/stage-tamagotchi/src/main/services/airi/{castalia-engine,castalia-memory,castalia-inprocess}.ts`
- 开口：`packages/stage-ui/src/libs/self-initiated-speech/{ticker,outbound-gate,speak-decision,adapter}.ts`、`packages/stage-ui/src/stores/modules/{self-initiated-speech,mind}.ts`、`packages/core-agent/src/mind/{drives,sleep,interruption}.ts`
