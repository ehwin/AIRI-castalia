# 情感函数 P0 落地记录（2026-10-31）

依据：`affect-humanlike-functions-review-2026-10-31.md`（复核报告）。
范围：`D:/AI/castalia/Castalia-Anima/src/`（这份就是带 `dist/` 的运行时代码），没有动数据库、没有改部署。
本轮把复核报告的 **P0 全部** 与两处顺带发现的接口缺陷落地，并补了测试。

---

## 一、结论

- **中性观测不再清标签**：被伤到之后来一句中性的日常话，`band` 保持 `negative`，检索拿到的偏置是 **−7.5**（改前是 0）。
- **相对/绝对拆成两个通道**：提示词/展示用绝对心境（她平时是 **+4**），检索/情绪合宜性用相对基线的偏差（平时 **0**，略低于平时 **−3**）。改前这两件事挤在一个返回值里。
- **夜间倍率、傲娇减速默认停用**：同一段过去不会因为查询时刻落在 22:00 之后而被重新解释（改前 arousal 2.48e−3 → 1.52e−8、dominance 0.513 → 0.717）。
- **精力有自己的时钟**：空闲 24h 后改 desire 不再把精力从 ≈30 弹回 100；恢复只来自显式 `boostEnergy`。
- 测试：6 个测试文件全绿（`test_psyche_state` 27 条、`test_affect_contract` 8 条，其余四个 17/40/… 条自报）；7 个相关 `regression_*` 全部 exit 0；`tsc -p tsconfig.build.json` 通过，`dist/` 已重建。

## 二、改了什么

| # | 文件 | 改动 | 为什么 |
|---|---|---|---|
| 1 | `psycheState.ts` | `finite()` 不再把 `null`/`''`/`true` 变成 0；只有数字与非空数字串算有效 | 缺维度被当成「观测到 0」= 强负 valence |
| 2 | `psycheState.ts` | `AppraisalKind` 新增 `state_neutral`；`neutral` 改为**事件级零影响**（只刷新证据、不动 VAD、不动 band）；`state_neutral` 才是「她现在在基线」的有界观测 | 原实现用一条中性观测直接写 `band='neutral'`，把仍然为负的 VAD 标成中性 |
| 3 | `psycheState.ts` | 新增 `absoluteMoodScalar()` / `deviationMoodScalar()` | 绝对心境与相对偏差必须分开暴露，不能由 `band` 门控一个数 |
| 4 | `psycheState.ts` | `targetAppraisalFromVAD()` 新增 `{ allowPartial }`；默认仍整条拒收缺失维度 | 词表只对部分维度有证据，缺一维不该丢掉全部证据，也不该补 0 |
| 5 | `index.ts` | `currentMood()` 改返回**偏差**；`unifiedStatePrompt()` 用**绝对**；`context_get`/`bundle` 的 `psyche` 增加 `absoluteValence` / `deviationFromBaseline` / `arousal` / `moodScalar` | 原来 `band==='neutral' → 0`，`v=+0.10`（相对 −0.30）会被清零；消费者分不清拿到的是哪种量 |
| 6 | `emotion.ts` | `HALF_LIFE` → `DECAY_TAU`（保留 deprecated 别名）；撤掉「Verduyn & Lavrijsen 2014」作为 24/4/36 的依据 | 它是 τ 不是半衰期（e⁻¹≈0.368 vs 0.5），且那篇不给 V/A/D 衰减常数 |
| 7 | `emotion.ts` | 夜间倍率与傲娇减速改为默认关闭（`ANIMA_NIGHT_DECAY=1` / `ANIMA_TSUNDERE_DECAY=1` 可复现旧行为） | 查询时刻重算整段过去 + 入夜 dominance 回升，都是数值级反例 |
| 8 | `emotion.ts` | 新增 `lexiconArousalToBipolar()`：0..1 强度 → −1..1 双极（0.5 为中点）；原始值 0 视为**无证据**返回 `undefined` | 词表 arousal 直接进 psyche（基线 .3、范围 −1..1）会把「平静」变成正唤醒 |
| 9 | `emotion.ts` | `computeRecency(hoursSince, tauHours)` 命名修正；`regressToBaseline` 标 `@deprecated`；`REGRESSION_RATE` 标 deprecated | 名字与量纲不一致；该函数全仓无调用 |
| 10 | `digest.ts` | 移除未使用的 `regressToBaseline, isNightTime` 导入 | 遗留死导入 |
| 11 | `emotionalRanking.ts` | 新增 `policyAllowsInjection()` | `injectionPolicy` 有四种返回值，调用方只处理了一种 |
| 12 | `recallForInjection.ts` | 过滤改为 `policyAllowsInjection`，`skip` 与 `context-only` 都不进注入；新增 `stats.policySuppressed` 与 `moodSuppressed` 分开计 | 原来只排除 `context-only`，**`skip` 反而被保留** |
| 13 | `agentState.ts` | 新增 `energyUpdatedAt` + `settleEnergy()`；`getCurrentEnergy()` 用独立时钟；`boostEnergy()` 先结算再叠加；mood/desire 不再影响精力 | 共用 `lastUpdated` + 只读时衰减 = 改一个想法就回血 30→100 |

## 三、数值验收（`dist/` 真实模块跑出来的）

```
1) 被伤到 → 一句中性日常话
   改前: band=neutral，检索偏置 0
   改后: band=negative，v=−0.348，展示 −3.5，检索 −7.5

2) 两个通道
   平时:        绝对 +4.0 / 偏差  0.0
   略低于平时:  绝对 +1.0 / 偏差 −3.0     ← 改前只给一个数（且被 band 清零）

3) 夜间开关（24h 旧记忆）
   改前: arousal 2.48e−3 → 1.52e−8；dominance 0.513 → 0.717（入夜反而更强）
   改后: day 与 night 完全相同（identical=true）

4) 词表量尺
   「今天吃了面」 arousal 原值 0 → 适配后 undefined（这一维不更新；改前的做法会把它当 0.5 传上去）
   「害怕」     arousal 原值 0.73 → 适配后 0.46

5) 注入策略
   score=0.1 → skip；policyAllowsInjection('skip')=false，('context-only')=false

6) 精力
   空闲 24h ≈30；setDesire 后仍 ≈30（改前回 100）；boostEnergy(0) 不回血；boostEnergy(20) 生效
```

## 四、测试

新增 `scripts/test_affect_contract.mjs`（8 条）：量尺换算、夜间/傲娇默认关闭、开关显式打开仍生效（子进程）、τ 与半衰期量纲、注入策略、Bjork 保底值、精力时钟。

修改 `scripts/test_psyche_state.mjs`（+7 条）：
- 缺失维度不是零观测；
- **一次性事件级 neutral 不再清除既有 band**（原用例断言的正是旧行为，已改写并注明语义变更）；
- `state_neutral` 朝基线走并给中性标签；
- `abstain` 不产生证据、不动版本；
- 两个 mood 通道；
- `band` 是相对基线的（写入为文档化行为，防止将来被当 bug 改坏）；
- 部分维度默认拒收 / `allowPartial` 放行。

跑法（本机 better-sqlite3 是按 Node 24 编译的，用项目自己的 node）：

```bash
cd D:/AI/castalia/Castalia-Anima
/d/sillytavern/runtime/node/node.exe --test scripts/test_psyche_state.mjs
/d/sillytavern/runtime/node/node.exe --test scripts/test_affect_contract.mjs
# 其余四个：test_affect_lexicon / test_emotion_wiring / test_emotional_ranking / test_injection_enrich
# 回归：regression_psyche_parse / regression_emotion_status_source / regression_emotion_failure /
#       regression_memory_injection / regression_diary_isolation / regression_restart_recovery
```

结果：六个测试文件 `FAIL=0`；七个 regression `exit=0`；`tsc` 通过。

## 五、没做 / 风险

1. **快慢两层（e/m + ρ）没做**。报告建议先统一语义再加复杂度，这一轮就停在这里。
2. **库里已写入的 `local_lexicon` 行 arousal 仍是 0..1**，与模型路径（−1..1）混在一列。适配器只在进入 psyche 时生效；回填需要一次单向迁移（`affect_source='local_lexicon'` 可识别）。
3. **`moodCongruence` 仍把 arousal 夹在 0..1**，而 psyche 给的是 −1..1 —— 这条通道的一致性计算还没统一。
4. **精力不持久化**：重启仍回到 100（本轮只修了「改想法回血」）。
5. **夜间倍率只是默认关闭，没删**。要彻底停用需删代码；保留是为了能复现旧行为。
6. **引擎没有重启验证**：改动已进入 `dist/`，当前没有 Castalia-Anima 进程在跑；下一次由托盘/AIRI 拉起时生效。没有做真实库上的一次端到端对话验证（只做了纯函数 + 模块级 + 现有回归）。
7. 复核报告 §9 对我上一轮 SDT 结论的收窄（d′ 差异也是分辨力差异）已在上一份回复里接受，本轮没有改动数字。

## 六、环境状态

- 未启动任何常驻服务；`3352=0`、`flm=0` 与上一轮一致。
- `dist/` 已由 `tsc -p tsconfig.build.json` 重建（12:07）。
- 未提交（该目录不是 git 仓库，无法给出 HEAD/write-tree）。
