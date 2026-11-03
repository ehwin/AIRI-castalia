# 审计问题落地：修了什么、证据在哪、还剩什么

对象：`D:/AI/castalia/Castalia-Anima`（AIRI 的运行时代码）。依据文档：`docs/research/anima-paper-feasibility-2026-10-31.md`。
日期：2026-10-31。未启动任何常驻服务；未改生产数据（只读打开过 bank 做体检）。

审计报告的结论分两类：**代码级缺陷**（可以直接修）和**研究缺口**（要靠实验补数据）。本轮只动第一类，第二类给可执行的观测入口，不假装已经得到结论。

---

## 一、代码级缺陷 → 已修

| 审计条目 | 缺陷 | 修改 | 证据 |
|---|---|---|---|
| §4.1 | `shouldReinforce('diagnostic')` 返回 false，但**没有任何写路径读它**：诊断读取照样 `accessed_count+1`、刷新 `last_accessed_at`，把后续分数从 .656 抬到 .845 | `emotionalRanking.ts` 新增执行口径 `NON_REINFORCING_CHANNELS` + `shouldCountAccess()`；`search.ts::updateAccessed` 先判渠道再落库，并统计被拦次数 | `scripts/test_access_contract.mjs` 5 项全过；探针改后 `diagnostic` 计数 0、日志 0、分数 `.656 → .656`、salience `.188 → .188` |
| §4.1 | 标签快速路径绕过 guard，把请求的 `explicit_recall` 记成 `search` | 快路径改走同一个 `updateAccessedGuard`，透传 `accessChannel` | 同上；探针日志出现 `explicit_recall`，`tagPathLosesRequestedChannel=false` |
| §3 | `memory_access_log` 全库 0 行，而 `accessed_count` 已有 565 —— 写入失败被静默吞掉 | `updateAccessed` 的日志写失败改为可观测（计数 + 首次 `console.warn`），新增 `getAccessStats()` | `getAccessStats().suppressed` 在契约测试里被断言 |
| §3 | `memory_get`（按 id 取一条）只加计数、**不写访问日志**：ACT-R 的间隔效应拿不到这条路径的数据 | `index.ts` 的 `memory_get` 落库同一条 `memory_access_log`，渠道标 `explicit_recall` | 代码路径；体检脚本可看到 log 增长 |
| §4.2 | 闸 1 只验证"引文是来源子串"，从不验证结论方向 → 「来源：不接受加糖」→「结论：必须加糖」被接收 | `insightQuality.ts` 新增闸 1b `evidence-contradicts-claim`（共享术语的极性冲突，术语内自带否定不算，名词化后缀不算） | 5 行审计样例全翻转；`test_insight_support_gate.mjs` 10 项 |
| §4.2 | 真实引文 + 编造因果（"糖尿病→必须胰岛素"）被接收 | 新增闸 1c `unsupported-cause`：**逐分句**检查"带因果/义务标记的分句在来源里几乎没有词面支持" | 审计样例 3 与 4 均被拒；弱语气（建议/可以）与合法改写不误伤 |
| §4.2 | 缺失/过短引文不触发任何拒绝 | 新增闸 1d `evidence-missing`：断言用户偏好却不给引文 → 拦（可用 `policy.strictSupport:false` 退回） | 样例 4 被拒 |
| §5 第 3 项 | `bias.ts` 冷启动回填用 `Date.now()` 记 `lastSeen` → 重启把三个月前的兴趣刷成新兴趣 | `recordTopics(..., at)` 增时间参数；`loadBiasesFromDb` 带 `created_at`、按时间升序回填，缺时间戳用已知最早值兜底（绝不回退到 now） | `test_derived_evidence.mjs`：90 天前的标签回填后权重 **0.12**（旧行为 ≈1.0），今天的标签仍正常注册 |
| §5 第 4 项 | 反思抽取给源记忆 `reference_count+1`，`consolidate` 又在 `>2` 时提重要度 → 内部读自己被当独立证据 | 去掉 `reflect.ts` 的 `reference_count+1`；`store.ts` 的两处重复计数加守卫 `isGeneratedSource()`（日记/状态/`reflect_*`），派生重复只记 `metadata.derivedRewrites` 诊断字段 | `test_derived_evidence.mjs`：外部重复 +1、`reflect_insight` 复述 **不 +1** 但有诊断字段 |

### 新增的谓词签名

- `shouldCountAccess(channel)` / `isNonReinforcingChannel(channel)` / `NON_REINFORCING_CHANNELS`（`emotionalRanking.ts`）
- `isGeneratedSource(source)`（`memoryProvenance.ts`）
- `termPolarity(text, term)` / `claimSourceConflict(claim, source)` / `unsupportedCausalClaim(claim, source)`（`insightQuality.ts`）
- `getAccessStats()`（`search.ts`）、`recordTopics(..., at?: number)`（`bias.ts`）

### 闸的取舍（重要）

1c 用的是**逐分句 + 零词面支持**判定（阈值 0.08 ≈ 最多一个偶然重合的 2-gram），不是蕴含模型。它抓住的是"完全无据的因果/义务断言"，抓不住"用来源里真实存在的词做出的错误推理"。这属于**故意保守**：宁可漏判，也不要把合法改写型洞察全拒掉（对照组：`用户排斥加糖饮品，因此提供咖啡时应默认无糖` 仍然通过）。

## 二、改后实测（同一批探针）

`docs/research/memory-paper-audit-results-postfix.json`（改后）vs `memory-paper-audit-results.json`（改前）：

| 样例 | 改前 | 改后 |
|---|---|---|
| supported-rule（有据规则） | ok=true | ok=true（未误伤） |
| reversed-preference-real-quote（反向 + 真引文） | **ok=true** | ok=false，`evidence-contradicts-claim:加糖` |
| unsupported-cause-real-quote（真引文 + 编造因果） | **ok=true** | ok=false，`unsupported-cause` |
| missing-quote（无引文的偏好断言） | **ok=true** | ok=false，`evidence-contradicts-claim:加糖` + `evidence-missing` |
| fabricated-quote-control（伪造引文） | ok=false | ok=false（原有闸仍然有效） |

`docs/research/memory-feedback-probe-results-postfix.json`（改后）vs `memory-feedback-probe-results-prefix.json`（改前，即审计引用那份）：

| 检查 | 改前 | 改后 |
|---|---|---|
| `diagnosticNeverthelessIncrementsCount` | true | **false** |
| `diagnosticNeverthelessWritesLog` | true | **false** |
| `subsequentScoreIncreasesAtSameSimilarity`（.656→.845） | true | **false**（.656→.656，similarity 1→1，salience .188→.188） |
| `tagPathLosesRequestedChannel` | true | **false**（日志渠道是 `explicit_recall`） |
| 两条只读对照 | 保持 | 保持 |

## 三、前瞻观测入口（§3 剩下的问题）

`scripts/affect_pipeline_health.mjs`（只读，`--json` 可机读）：

```
合计: { memory: 8994, active: 4111, touched: 624, accessLog: 0,
        psycheState: 1, psycheEvidence: 1, psycheEvents: 0,
        selfCycle: 0, convLog: 3058, reflect: 4402 }

判读：
  ⚠ accessed_count>0 有 624 条，但 memory_access_log 为 0 —— 间隔信息从未落库（ACT-R 拿不到数据）
  ⚠ 有证据状态 1 条但 psyche_events 为 0 —— 状态更新发生过却没有事件历史（无法重放）
  · self_cycle_runs 为空：日记/自我循环未运行过
```

这组数字同时说明两件事：

1. 审计 §3 的"数据不足以重建三个月轨迹"**在代码修完之后依然成立** —— 历史日志没写过，补不回来；本轮修的是"以后会写"。
2. 8,994 条记忆里 **4,402 条是 `reflect_*`（约 49%）**。这解释了为什么 §5 第 4 项的 `reference_count` 通道值得修：派生内容占了一半的库，任何让"内部重复"涨权重的路径都会被放大。

`psyche_events` 为 0 的**原因已定位**：`applyPsycheAppraisal` 只在 `emotion.ts` 的 VAD 队列 flush 里调用，而该 flush 由 `digest.ts` 驱动 —— 也就是说"情感链路是否在跑"取决于 digest 有没有跑到。这不是代码 bug，是这个部署的调用频率问题；体检脚本以后可以直接回答它。

## 四、没修 / 明确留白

| 条目 | 为什么没动 |
|---|---|
| §5 第 1、2 项（读取改变排名 / 引文与主张的**语义**支持） | 需要在任务层测 top-k 反转与下游答案错误率，属于实验工作，本轮只修了确定性闸 |
| §5 第 5 项（多时钟一致性） | 需要先定义不变量；`psycheState.decay` 用半衰期、`emotion.decayDimension` 用 τ，两者语义不同但都有测试标明，未擅自统一 |
| §5 第 6 项（更正/删除传播） | 派生日记禁止普通删改有审计用途，属设计取舍 |
| §6 的 2×2 实验 | 这是论文主体，不是缺陷 |
| 历史 `local_lexicon` 行的 arousal 量纲 | 需要一次性单向迁移，未做（上一轮已记录） |
| `psyche_events` 从未写入 | 已定位为 digest 驱动；要让历史可重放需要先决定 digest 频率，属产品决策 |

## 五、测试与可追溯性

- 全量：`scripts/test_*.mjs`（16）+ `scripts/regression_*.mjs`（22）= **38 个文件全绿**（`tsc -p tsconfig.build.json` 通过，`dist/` 已重建）。
- 新增测试：`test_access_contract.mjs`（5）、`test_insight_support_gate.mjs`（10）、`test_derived_evidence.mjs`（4）。
- 跑法：用项目自己的 Node（`better-sqlite3` 按 Node 24 编译）：`/d/sillytavern/runtime/node/node.exe scripts/<name>.mjs`。
- 源码哈希（sha256 前 16 位）：`bias.ts 0423d313f06a533e`、`search.ts 44071cc6968987f1`、`index.ts b82bc346ad60f5a0`、`insightQuality.ts f0e7e632fa579b72`、`memoryProvenance.ts 40541a8467bfaaa3`、`store.ts 780762f28fe19499`、`reflect.ts 05a94c6e61d2d23d`、`emotionalRanking.ts d5d05a5504b20e5c`。
- 该目录不是 git 仓库，无法给 HEAD/write-tree；以哈希 + mtime 作为锚点。
