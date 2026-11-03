# 情感循环、记忆体与自循环整链路复核及升级报告

日期：2026-10-31

本报告把传感器实测、Anima 的记忆/VAD/psyche 链路、自循环和日记回写放在同一条链上复核。详细证据分别见：

- `psyche-memory-self-cycle-audit-2026-10-30.md`：源码链路、隔离、恢复和回归测试
- `psyche-report-2026-10-30.md`：0.8B/2B/4B/API 实测与 VAL 契约改造
- `psyche-upgrade-plan-2026-10-30.md`：传感器、校准、路由和上线顺序
- `psyche-upgrade-psychology-notes-2026-10-30.md`、`psyche-upgrade-ml-notes-2026-10-30.md`：心理学、测量和小模型工程依据

## 1. 最终结论

### 1.1 记忆体和自循环必须分开

这个拆分是正确的，而且应当成为硬边界：

- 记忆体保存可追溯的原始证据和可检索内容。
- 情感循环处理本轮对话、VAD 和短期 psyche 状态。
- 自循环读取对话证据与短期状态，生成带来源的日记或反思。
- 日记是派生记录，不是用户事实、情感证据、普通召回结果，也不是下一次自循环的输入。

这样可以避免“模型自己写的解释”再次被当成用户行为，形成自我强化、情绪漂移或记忆污染。

### 1.2 状态机应该保留，但不能由模型拥有

状态机不是为了让系统“模拟诊断”，而是为了维护可回放的短期动力学。模型只能输出本轮事件的 appraisal/VAL 候选；确定性代码负责：

- 基线回归和时间衰减
- 有界增量、clamp 和滞回
- `eventId` 去重和重试幂等
- `neutral`、`unknown`、`invalid`、`abstain`、`no_event` 的分离
- 版本、时间戳、来源和持久化

模型输出不能直接覆盖 mood，也不能把解析失败或上下文不足改写成 neutral。

### 1.3 当前 0.8B 适合作为低成本传感器基线，不适合作为状态机

旧 JSON 契约会让小模型花 token 生成死字段。改成一行 `VAL=-2..2` 后，同一批探针由 0.722 提升到 0.750，端到端失败率为 0，p50 约 1049 ms；但中性仍为 0 次，样本也只有 36 条。因此它只能产生候选事件信号，不能直接决定角色状态。

API 在留出集上约为方向 0.90、标签 0.90，但有延迟、成本和隐私边界。API 应作为离线校准或高风险路由候选，不应作为未经评估的常驻真值。

## 2. 复核后的完整链路

```text
用户/角色对话
  -> conversation_log（general，pending）
  -> VAD queue（只接受 active conversation_log）
  -> VAD/psyche 分析或 abstain
  -> psyche_state（确定性状态更新）
  -> context / retrieval / reply

conversation_log + psyche_state
  -> self_cycle（独立的读取与生成过程）
  -> agent_diary（derived，有 provenance，不进 VAD、不进普通召回）
```

关键不变量：

1. 先保存对话证据，再入 VAD 队列；不能先更新 mood 再补记忆。
2. 只有 psyche 成功持久化，VAD 项才提交为 `analyzed`；模型格式错误、写失败或状态写失败要保留并可重试。
3. 无可靠证据写 `abstain`，不写成 neutral，也不推进状态。
4. psyche 的读、转移、写在 SQLite `BEGIN IMMEDIATE` 内完成，避免并发版本互相覆盖。
5. 重放同一 `eventId` 不得重复累加。
6. `agent_diary` 不得重新进入 VAD、事实提取、实体来源、普通 search、context injection、reflection 或 consolidation。

## 3. 记忆体审查结果

### 3.1 对话记忆

对话统一落在 `conversation_log`，状态从 `pending` 开始。VAD 消费者只接受 active 的 `conversation_log`，因此 diary、state 或其他 memory type 不能伪装成用户情感证据。失败时保留队列项，重启后可恢复。

### 3.2 日记记忆

`saveSelfDiary()` 写入 `project` 库，至少带有：

- `generated_by=self_cycle`
- `evidence_ids`
- `state_version`
- 创建时间和派生来源

日记跳过 embedding，不进入普通记忆检索。只有显式 `includeDiary=true` 才能查看。相同 evidence key 的崩溃重试会复用已有 diary；不同 evidence key 即使文案相同，也按两条派生记录处理，避免错误去重。

### 3.3 facts 和 entities 的来源安全

事实来源不再假设跨 `memType` 的本地外键，额外保留 `source_memory_source` 与 `source_memory_mem_type`。来源必须满足同项目、同角色、active，且不能来自 `agent_diary` 或 `agent_state`。跨库实体关系可保留悬挂 link，但公开查询会按 project、character、active 和 derived-source 过滤，不会把其他角色或派生记录泄漏出来。

### 3.4 检索和注入

普通 search、context 注入、reflection、consolidation 和 cold maintenance 默认排除 diary。若产品以后需要“回顾自己的日记”，应使用单独的显式入口和 `includeDiary`，不要放宽默认检索过滤。

## 4. 自循环审查结果

自循环使用 `(created_at,rowid)` 的持久游标、durable claim 和 stale claim reclaim。进程在 claim 后、写 diary 前崩溃时，下一次运行会重新处理；evidence key 能阻止同一证据重复生成日记。自循环定时器默认关闭：`SELF_CYCLE_INTERVAL_MINUTES=0` 或未设置时不启动，只有显式配置正数才自动运行；MCP/内部调用仍可按需运行一次。

建议保持“只读证据 -> 生成派生文本 -> 一次写入”的单向结构。日记生成不能直接修改 psyche，也不能反过来触发下一次 self-cycle。

## 5. 状态机设计决定

保留状态机，但将它缩小为确定性 transition：

```text
next = transition(previous, appraisal, dt, eventId)
```

建议状态至少包含 `value`、`baseline`、`updatedAt`、`version`、`lastEventId` 和来源元数据。`abstain`、`invalid`、`no_event` 不新增证据；真正的 `neutral` 才能作为已标注的近零事件。进入/退出阈值使用滞回，停留时间和衰减半衰期必须从校准集与轨迹回放中确定，不能从心理学论文直接抄常数。

提示词中的状态只能作为带时间戳、带来源的先验估计，并与“日志观察”和“本轮新证据”分栏。本轮新证据必须能够推翻旧估计，避免模型把上一轮错误反复喂回而形成确认偏差。

## 6. 已完成的代码级修改与验证

已在 `D:\\AI\\castalia\\Castalia-Anima` 源码中完成构建和回归，主要包括：

- VAD 队列只接收 `conversation_log`，并把失败分为可重试和 `abstain`。
- psyche 更新具备事务、版本和事件去重。
- self-cycle 具备持久游标、claim、过期 claim 回收和 evidence-key 幂等。
- diary 具备 provenance、状态版本和默认隔离。
- facts 迁移保存跨 memType 的来源信息，并拒绝未知、跨角色、失活及派生来源。
- 传感器契约改为短 `VAL` 输出，移除无用 JSON 字段，限制输出长度并做解析边界处理。

已通过的回归类别包括：

- `pnpm run build`
- psyche 状态、解析、重启恢复、失败重试、并发 flush 和重复入队
- diary isolation、self-cycle cursor、跨进程 claim
- facts provenance、migration、entities、role isolation
- memory injection、store bridge、loop closure 和 Anima audit

审计记录中的总覆盖为状态 16 项、情感失败 13 项、实体 44 项以上，另有跨角色、来源和闭环回归。此前报告中的 `better_sqlite3.node` ABI 阻塞已不再适用。

## 7. 尚未完成或不能宣称完成的事项

1. 构建产物已经生成，但 `D:\\castalia\\run\\Castalia-Anima\\dist` 尚未部署；不能把审计结果当成线上已生效。
2. idle unload 的真实运行路径仍需在部署环境 smoke test；目前主要完成语法和回归验证。
3. 新 VAL 契约的中性覆盖仍为 0；不能用“问句/短句/无情绪词”直接判 neutral，必须用独立标注集验证规则精确率和覆盖率。
4. `/appraise` 仍没有证明存在有效 Anima 消费者；现有 VAD 的逐条音调会影响检索，但进程内平滑 mood 尚未形成唯一的回复上下文消费者。
5. 36 条探针不足以拟合阈值、衰减、API 路由或 conformal 错误率。正式校准要按用户/会话分组并按时间留出，防止同一对话和同义改写泄漏。

## 8. 上线顺序

1. 停止宿主，整体替换 `dist`，不要逐文件覆盖；启动后 smoke `context_get`、`self_cycle`、`auto_process`。
2. 先 shadow 写入 psyche 和指标，不改变回复；确认 queue age、解析失败、abstain、状态更新、消费者读取和 diary 生成量均可观测。
3. 锁定标注集，比较规则、0.8B VAL、小型 encoder 和 API 级联；报告每类 precision/recall、macro-F1、neutral/unknown/invalid 覆盖率、p50/p95、内存和成本。
4. 只有在 shadow 证明状态确实被唯一消费者读取后，才做状态注入 A/B。
5. 最后再决定是否做 LoRA/蒸馏或扩大 API 比例。不要先用 prompt、certainty 或多数投票掩盖传感器的系统性偏差。

## 9. 结论性验收标准

升级完成的最低标准是：非法输出不更新状态；状态 transition 可纯函数回放且防重复事件；memory、diary、facts、entities 和检索有可测试的 provenance 边界；失败、重启、并发和卸载路径可恢复；中性和 abstain 独立计数；状态有唯一消费者；线上能区分“写入成功”和“产品行为实际改变”。

---

## 10. 2026-10-31 第二批：上文 §7 的进展（本节优先于 §7）

本报告写成后代码又动了两轮（`8f02af9`、`b2d81ab`）。§7 的清单已经部分过期，按现状重列：

| 条目 | 现状 | 证据 |
|---|---|---|
| §5 band 用绝对阈值（原文未标为缺陷） | **已修**：相对基线 ±0.25 进入 / ±0.10 维持 | 负向事件静默 240h 后 band = `neutral`，不再翻成 `positive` |
| §5 `hasEvidence` 按"可回落"描述，实现不可回落 | **已修**：`last_evidence_at` + 72h TTL，过期交还 AgentState | env `PSYCHE_EVIDENCE_TTL_HOURS=1` 时 +3h 判定无证据、band 回 neutral |
| §7.1 dist 未部署 | **已部署**，四个关键文件 md5 与源码 dist 一致 | `index.js 04a87df4…`、`psycheState.js 71e1c229…` |
| §7.5 无历史轨迹、无法回放校准 | **已补** append-only `psyche_events`（from/to VAD、baseline、band、version、event_id），retention 默认 90 天 | temp bank 三次 appraisal（含一次重复 eventId）→ 2 行，重复未写 |
| 批次粒度 15 条压一次（评审补，原文未列） | **已修**：`VAD_APPRAISAL_CHUNK`（默认 3） | 7 条对话 flush → `3 project batch(es)` |
| 常数写死（§7.3 相关） | **已改**：`readPsycheTuning()`，全部可由 env 覆盖 | `PSYCHE_BASELINE_*` / `PSYCHE_HALF_LIFE_*_HOURS` / `PSYCHE_*_GAIN` / `PSYCHE_BAND_*` |
| 日记无读取方（评审补，原文未列） | **已补显式入口**：`context_get { includeDiary: true }`，默认关闭 | 默认返回无 `derivedDiary`，开启后有且 `derived: true` |
| §7.2 neutral 覆盖 0 | **未变**：本机 Ollama 不可用，7 条情感文本全 `abstain` | 本地词表对这批句子置信度 0 |
| §7.4 `/appraise` 无消费者 | **未变** | `grep appraise src/` 仍无命中 |
| 日记模板化、无 LLM 反思 | **未变**（设计取舍） | `selfCycle.ts` `formatDiary()` |

同时修正本报告一处计数与口径不一致：§1.3 的 `VAL` 契约 p50 应为 **701 ms**（传感器脚本自记），1049 ms 是 freetext 档；§6 引用的测试计数与实际脚本输出不符（`memory_injection` 44 项、`loop_closure` 11 项、`entities` 49 项）。
