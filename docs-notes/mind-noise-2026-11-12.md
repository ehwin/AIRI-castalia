# 给情感循环加噪声（2026-11-12）

目标：让同一天跑两遍不再一模一样。她应该在「什么时候想说话、先做什么」上有自己的抖动，但不该变得不可靠——记录、打扰裁决、幂等写入必须还是确定的。

## 先看别人怎么做

| 来源 | 结论 | 对这里的用处 |
| --- | --- | --- |
| Oravecz, Tuerlinckx & Vandekerckhove 2011（*Psychological Methods* 16(4):468–490，doi:10.1037/a0024375） | 核心情感用 Ornstein–Uhlenbeck 过程建模：home base（均值）、吸引强度、**过程方差**三个参数平级。方差是"这个人的情感有多会飘"，不是测量误差。 | 抖动属于状态本身；要均值回复，不能每跳独立重抽。|
| Kuppens, Oravecz & Tuerlinckx 2010（*JPSP* 99(6):1042–1060） | 情感动力学的个体差异（inertia / home base）稳定存在。 | 两个角色必须有不同的日子与不同的漂移。|
| Kim, Park, Lee, Kim & Chung 2009（CIRA，*Stochastic approach on a simplified OCC model*） | 在评价模型里引入随机决策，理由是可信度与不确定性。 | 「靠线那次选择掷骰子」有出处，不是随手加随机。|
| Sutton & Barto, *Reinforcement Learning* §2.3（softmax / Boltzmann） | 软最大化按价值差分配概率：差得远是决定，贴线是抽签。 | `think` vs `provoke` 的选择用 logistic，不全局掷骰。|
| Barabási 2005（*Nature* 435:207）、Vázquez et al. 2006（*PRE* 73:036127） | 人的行为间隔是突发重尾的，不是周期也不是泊松。 | 开口间隔在基准上按 ±35% 抽，不再整点打卡。|
| Horvitz 1999（NEVA）、Iqbal & Horvitz 2007 | 打扰代价高且不对称（一次约 20 分钟）。 | 噪声绝不进「能不能打扰」那条裁决。|

## 实现的三层 + 一层节奏

`packages/core-agent/src/mind/noise.ts`：

| 层 | 函数 | 参数 | 不改什么 |
| --- | --- | --- | --- |
| 心情抖动 | `stepWobble` | σ=3.5 点、τ=20 分钟、均值回复 | 不写进驱力快照 |
| 每日阈值 | `dailyJitter` + `jitteredThresholds` | ±5 点，按 `角色+日期` 派生 | sleep / wake / `sleepIdleMs` 不动 |
| 选择抽签 | `decide(..., { random })` 里的 logistic | 温度 6 点 | 远离阈值时仍是确定决定 |
| 开口间隔 | `nextGapFactor`（`outbound-gate.ts`） | 1h × [0.65, 1.35] | 日上限、未回暂停、去重窗不动 |

关键实现细节：

- OU 步长用 `w·e^(-dt/τ) + σ·sqrt(1-e^(-2dt/τ))·N`。`sqrt(1-a²)` 让**任意步长的平稳方差都等于 σ**：挂起两小时回来是一次新抽样，不是昨天的心情打五折。
- 每日偏移从日期派生（`seedFrom(角色 + 日期)`），不落盘：同一天里任何窗口、任何重载读到同一个数。
- 抽到的间隔**必须在开口成功时落盘**（`OutboundState.gapFactor`）。不存就是每问一次门都重抽，消息会被越问越早。
- 噪声源默认**没装**（`attachNoise` 未调用 = 原来的确定性循环），宿主 `App.vue` 在 `initialize` 之后装一条按启动取的种子流。不装不会悄悄改变行为，既有测试也不会变成摇奖。

## 不接噪声的地方（硬线）

1. `interruptionVerdict` / 屏幕门：一次错误的 `free` 值二十分钟。
2. 任何落盘记录：记忆、心情、日记、`gapFactor` 以外的节奏账本。噪声进记录 = 检索不可复现。
3. 幂等键：`emotion:turn:<conversationId>:<turnId>` 这类去重不能带随机。
4. sleep/wake 阈值：维护次数会跟着漂，那是副作用不是性格。

## 变体对照（`scripts/mind-noise-sim.mjs`，7 天，45 秒一跳）

同样的日程（9–12、13–18 在桌前），三个种子：

| 变体 | 首日首次想开口 | 每天想开口 | 想先想一次（7 天合计） |
| --- | --- | --- | --- |
| 无噪声 | 00:36 | 12–13 | 91 |
| 种子 1 | 00:48 | 12–13 | 105 |
| 种子 2 | 00:48 | 12–13 | 117 |
| 种子 3 | 00:50 | 12–13 | 87 |

诚实的读法：

- **选择层真的变了**：同样 7 天，「先想一想」从 87 到 117（±17%），日与日之间 8–20 次。
- **阈值层让第一天晚了 12–14 分钟**（60 → 55~65 的偏移）。
- **「每天想开口次数」几乎不变**，因为无聊在阈值之上已经饱和，每小时一次是**节奏层**决定的，不是抖动决定的。想要「有些天她更黏人」，改的是间隔（已做：±35%）和日上限，不是把 σ 调大。

## 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm -F @proj-airi/core-agent exec vitest run` | 731 passed（新增 15 条噪声测试）|
| `pnpm -F @proj-airi/stage-ui exec vitest run src/stores/modules src/libs/self-initiated-speech` | 398 passed / 3 failed（`airi-card.browser`、`optional-modules.browser` ×2，改动前既有）|
| `vue-tsc --noEmit` stage-ui / stage-tamagotchi | 0 error |
| `eslint` 改动文件 | 0 error |
| `node scripts/mind-noise-sim.mjs` | 上表 |

噪声测试钉住的不变量：

- 同一种子 → 同一条轨迹；不同种子 → 不同轨迹（`mind.integration`）。
- 驱力**逐位相等**：装噪声与不装噪声，走完同样多的 tick 落盘数值一模一样（噪声只进判定）。
- 平稳标准差 ≈ σ（0.85σ–1.15σ，5000 步）；长间隔后与新初值无关（8e-4 残差）。
- 间隔抽签落在 [0.65, 1.35]，非有限值夹回；`gapSpread: 0` 恢复旧节奏。
- 睡眠/打盹判定不会因为骰子翻转。

## 未做 / 下一步

- 面板上没有显示「今天的偏移」：设置窗口是另一个 Pinia，读到的会是它自己那份，正是上一轮修掉的假绿。要看真值就把 `todayOffset` 并进 stage 窗口落盘的诊断里。
- 慢层 mood（默认关闭）没有加噪声。它一旦打开，噪声应该加在扩散项而不是读的时候。
- `math.random` 仍是 `self-initiated-speech` 里自动策略的源（`policy.random`），没接种子；它在噪声层之外，行为上只影响「到点了要不要说」。
