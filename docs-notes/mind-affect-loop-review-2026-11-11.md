# 情感循环与模块复查（2026-11-11）

目标：查完表层的「开口时机」后，把驱力、睡眠、影响层逐个模块看一遍，找出逻辑与代码问题。

## 修掉的三处

| 位置 | 问题 | 现在 |
| --- | --- | --- |
| `mind.ts` `wakeUp()` | 夜睡只回疲劳，不回无聊。带着躺下时那格无聊醒来，睁眼第一跳就「无聊到想说话」。 | 醒来减 25 无聊。午睡原本就有 0.4/分钟 + 收尾 15。 |
| `self-initiated-speech.ts` 成功分支 | `relieveAfterSpeech()` 只被测试调用，生产代码从没接。说完话无聊不降，于是每 10 分钟又想开口、每次都抓一次屏。 | 送达后调 `mind.relieveAfterSpeaking()`。失败不付。 |
| `core-agent` `restDrives()` | 只回疲劳。关机十小时后启动，无聊、好奇、专注原样交还。 | 三轴按离线钟松弛：无聊 e^(-h/3)、好奇半衰期、专注 e^(-h/1)。关机不是无聊。 |

## 删掉的一处重复机制

`castalia-plugin/src/emotion.ts` 里的 `decayEmotion()` / `regressEmotionToBaseline()` 只有自己的测试在调。活的衰减在 `vendor/engine/psycheState.ts`（分层快慢 + 证据时钟 + 带）。两份实现答同一个问题时会给不同答案，其中一份还没人测——删掉函数与测试，只留 `VADVector` 类型。

顺带：那份死代码用 `exp(-h/halfLife)` 表达「半衰期」，真实半衰点落在 0.69×halfLife 处。名字与数学不符，是「留着就会有人照着接」的典型。

## 逐模块结论

| 模块 | 结论 |
| --- | --- |
| `mind/interruption.ts` | 上一轮已改完：锁屏 > 新鲜视觉裁决 > unknown。无新增问题。 |
| `mind/drives.ts` | 三处松弛（上表）。其余数值与阈值复核一致。 |
| `mind/sleep.ts` | 回合结算、跨关机补算、质量决定时长都对。夜睡不回无聊由上表补。 |
| `mind/expression.ts` / `inner-voice.ts` | 无问题。 |
| `stage-ui/mind.ts` | `relieveAfterSpeaking()` 新增；`stateLine` 上移到首次使用之前（原先 eslint 报 used-before-define）。 |
| `self-initiated-speech.ts` | 送达付无聊；其余门、买断、冷却上一轮已修。 |
| `consciousness.ts` | 参数按模型存，上一轮已修。 |
| `screen-sense.ts` / `system-presence.ts` | 看门狗与 2 秒上限在。 |
| `castalia-plugin/agent-state.ts` | 聚合权重、静音门槛正确。`AgentState` 类只有测试在用（生产走 `getAgentState` 镜像），记为 P3 待清。 |
| `castalia-plugin/store.ts` | `syncPsyche` 只替换 `psyche` 事件，时间戳取引擎证据时刻，不会每 5 分钟假造新事件。 |
| `castalia-engine` 情绪写入 | 模型显式记录的情绪走 `applyEmotion` 进引擎，受模块开关约束；面板如实说明 unsupported。 |

## 为什么本地跑插件测试会红一条

shell 里带着部署参数 `PSYCHE_BAND_HOLD=0.08 / PSYCHE_BAND_CENTER_OFFSET=-0.2 / PSYCHE_BAND_ENTER=0.18`，而 `psyche-layered.test.ts` 的默认带假设 `center=0 / enter=0.25`。去掉这三项后 125 条全过。跑法：

```sh
env -u PSYCHE_BAND_HOLD -u PSYCHE_BAND_CENTER_OFFSET -u PSYCHE_BAND_ENTER pnpm -F @proj-airi/castalia-plugin exec vitest run
```

## 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm -F @proj-airi/core-agent run build` | 通过 |
| `pnpm -F @proj-airi/core-agent exec vitest run` | 716 passed |
| `pnpm -F @proj-airi/stage-ui exec vitest run src/stores/modules src/stores/chat.contract.test.ts` | 334 passed / 3 failed（`airi-card.browser`、`optional-modules.browser` ×2，改动前既有） |
| `env -u PSYCHE_BAND_* pnpm -F @proj-airi/castalia-plugin exec vitest run` | 125 passed |
| `vue-tsc --noEmit`（stage-ui / stage-pages）、`tsc --noEmit`（castalia-plugin / core-agent） | 全部 0 error |
| `eslint` 8 个改动文件 | 0 error |

## 未验证

- 真机上「说完一句就把无聊付掉」的观感，要看 `self-initiated-diagnostics` 里两次开口的间隔与 `lookMs`。
- 夜睡 25 点是否够：一晚醒来无聊从 80 降到 55，仍在想说话的线下。要调就看真机日志，不要猜。
