# 她什么时候开口：占用裁决与两套采样参数（2026-11-10）

## 问题

两件互相牵连的事。

1. 她主动开口时常问「你是不是在忙」。这一问把判断推回给主人，而屏幕就在她眼前。
2. 主模型换过一版之后指令遵从变差，DeepSeek 与 MiniMax 共用同一组采样参数。

## 外部证据

先看别人怎么做，再决定动哪一层。

| 来源 | 结论 | 对本项目的意思 |
| --- | --- | --- |
| An, *When Should the Agent Speak?*（TMLR 09/2026, DOI 10.5281/zenodo.23291867） | 统一判据是「打扰收益 > 打扰代价」，分五层：信号、决策、动作、记忆、评估。信号已经很丰富，但几乎都花在「他在干什么」，不是「此刻该不该说」 | 缺的不是感知，是把感知转成决策的那一步 |
| 同上 §3.5 | 把时间戳直接交给模型并不产生时机行为，模型会编一个「轮数」当代替 | 靠提示词写「看看屏幕再问」不可靠，必须有结构化裁决 |
| Horvitz et al. 1999 | 三档动作：沉默 / 问一句 / 直接说，两个阈值；沉默也是一项有代价的动作 | 「问一句」是合法中间档，但只该用在真的不确定时 |
| Iqbal & Horvitz 2007 | 一次提醒的真实代价约 20 分钟，27% 的窗口两小时内不回来 | 猜错方向的代价不对称，precision 优先 |
| Pejović & Musolesi 2014 | 两小时内第 9 条通知的好感度不到第一条的一半；纯上下文门会背靠背连发 | 代价是路径相关的，频率本身要计入 |
| Pielot et al. 2017 | 用户自己的响应历史（4 个特征）胜过全部 197 个上下文特征 | 个人历史是最值钱的特征 |
| **反例：Fogarty et al. 2005** | 办公室场景里「有没有人在说话」单传感器就能判 75.9% 的不可打断 | **不可移植**：这是社交可打断性，不是任务忙闲。读文档、写代码、开会时人都可能长时间不出声 |
| **反例：Windows `QUNS_BUSY` / PowerToys PR #45891** | 系统能报全屏、演示模式、启发式 busy；PowerToys 每 2s 轮询来压自己的弹窗，并为 NV overlay 之类留了误报出口 | **不可移植**：它判的是「现在弹窗会不会被看见」，不是「这个人脑子里有没有在做事」。深度工作时它照样报 `ACCEPTS_NOTIFICATIONS` |

## 结论

- **忙闲只有视觉能答**。锁屏与空闲计数只说明「锁没锁 / 有没有输入」，不说明「闲不闲」。把空闲当免费证据会把「读十分钟文档」判成走开，反而更糟。
- **`unknown` 不是 `free`**：看不见就只能说自己的事，不许拿主人的状态当开场。旧的 `interruptAllowed` 默认 `true` 正是把「不知道」当成「可以打扰」。
- **一档改三档**：`away`（仅锁屏）/ `busy` 不出声，`free` 直接说事，`unknown` 放行但禁止问忙不忙。
- **一处裁决**：`core-agent` 的 `interruptionVerdict()` 合成证据，mind 只持有读数，宿主只提供读数。视觉裁决新鲜时它以视觉为准；锁屏是唯一能推翻它的硬事实。
- **两套采样参数按模型家族分册**：DeepSeek 与 MiniMax 各存一套，切模型自动套用；面板里能看见「请求实际带上」的值。

## 同一条线上的其它口子（顺着「unknown 不是 free」查到的）

| 位置 | 旧行为 | 现在 |
| --- | --- | --- |
| `mind.applyScreenLine` | 视觉只回描述、没回裁决时，用关键词兜底；**没命中就写 `interruptAllowed = true`**，一次解析失败变成自由通行证 | 关键词**只能否决**，不能放行；没有裁决就保持 unknown |
| `mind.considerSpeaking` | 读 `interruptAllowed`（默认 `true`），没看过屏幕也算可以搭话 | 只认 `free`；`unknown` 一律不算许可 |
| `self-initiated-speech.speak` | 看一眼超时后仍按几分钟前的裁决开口，可能说「主人现在不忙」 | 传 `minAgeMs = now - lookStartedAt`，只认这一眼产生的裁决；超时/只回描述 → `unknown` |
| 同上，提示词 | 决定用新裁决、嘴上读旧裁决 | `innerContextLine(3, { minAgeMs })` 与决定同源 |
| 裁决文案 | `free` 说「主人就在电脑前，现在不忙」——视觉只看见屏幕内容，证明不了人在 | 改成「屏幕上：X。看起来可以说话」 |

## 测试与成本

- **属性测试**：2000 组随机输入断言「`free` 必有当下这一眼的布尔裁决」；另 500 组断言「门槛越紧，接受窗口只会更小」。它防的不是某一条分支，而是「以后有人图省事，在没有裁决时返回 free」。
- **截图先缩到 1280 宽再交给视觉**：裁决要的是「哪个应用、在干什么」，不是可读正文；4K 原图按面积计费，还会把一次 look 拖到超时。缩小失败退回原图（宁可多花钱，也别因为她突然看不见）。
- **一分钟内不重复抓屏**：5 分钟的定时扫视与开口前那一眼会撞在一起；非 `force` 的调用一分钟内直接返回。
- **耗时落盘**：`screen-sense` 记录每次 look 的 `elapsedMs`，开口路径把它写进 `diagnostics.lookMs`，Castalia 设置页显示「开口前看一眼耗时」。20 秒预算够不够，看这个数。
- **全链路用例**（`interruption-chain.integration.test.ts`）：`mind` 与开口 store 都是真实现，只假 `chat.notifyConversation`。四条：忙屏沉默、可说话时开口且提示词带「别问他在不在忙」、视觉只回描述时不冒充 free、锁屏按 away 处理。**必须共用同一个 Pinia**——分两次 `createPinia()` 会让开口 store 拿到没有 sense 的第二份心智，裁决恒 `unknown`，而 `unknown` 本来就放行，用例会假绿。
- **主进程那一头**（`system-presence.test.ts`）：`powerMonitor` 打桩，验证 locked 透传、30 分钟空闲仍是 `idle`（不折成 away）、阈值 600 秒、`unknown` 不被猜成 active。
- **打包级证据**：`pnpm -F @proj-airi/stage-tamagotchi build` 后，`out/bundle/main/index.mjs` 里有 `system-presence:get`，renderer 产物里有裁决文案与 `createImageBitmap`（缩放路径）。单测绿 + tsc 绿仍可能是「没进包」。

## 落点

| 层 | 文件 |
| --- | --- |
| 纯规则 | `packages/core-agent/src/mind/interruption.ts`（`interruptionVerdict`、`asksIfBusy`） |
| 感知端口 | `packages/core-agent/src/mind/sense.ts` 的 `SensePort.presence` |
| 时钟与持有 | `packages/stage-ui/src/stores/modules/mind.ts`（`presence`、`interruption`、`interruptionLine`） |
| 提示词 | `packages/stage-ui/src/stores/chat.ts` 的运行时上下文；`self-initiated-speech` 的 notice 与 gate |
| 廉价读数 | 主进程 `services/electron/system-presence.ts` + `shared/eventa/presence.ts`；渲染端 `libs/screen-sense.ts` |
| 采样预设 | `packages/stage-ui/src/stores/modules/consciousness.ts`；意识页 `packages/stage-pages/src/pages/settings/modules/consciousness.vue` |
| 观测 | Castalia 设置页：占用状态、上次「在忙吗」 |

## 复查（2026-11-11，全链路）

从主进程到提示词逐段读了一遍，改了 5 处，都是「读数与实际不符」或「同一件事做了两遍」。

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `self-initiated-speech` 门 | 屏幕说忙时只拒绝、不记冷却：一秒一跳，`decideOutbound` 每秒重算、`snapshotFor` 每秒读一次、`onGated` 每秒写一次 localStorage | 与开口路径一样置 `blockedUntil = now + 5min`；下一跳起直接 `skip('screen-hold')` |
| 同一处 `onGated` | 同一理由每秒落盘一次，计数按 tick 涨（一天上万），面板那个数没有意义 | 按「事件」计：理由相同且 60 秒内不重复落盘 |
| 同一处 `loadDiagnostics` | 只把 `gatedCount` 读进 `diagnostics`，没有回填 ref：重启后第一次拒绝把持久化总数覆盖成 1 | `gatedCount.value = diagnostics.value.gatedCount` |
| 同一处 `speak` | 「已开口」在发送之前落盘，发送失败也显示 `sent`，`lastSpokeAt` 照样前移 | 失败记 `send-failed`，`sent` 只记在 `notifyConversation` 之后 |
| `mind.interruptAllowed` | 默认 `true`：当前没有读它（要配 `interruptVerdictAt`），但默认值是别人「顺手读一下」时的答案 | 默认 `false`——没人说过可以，就是不可以 |
| 裁决文案 | `busy` 写「别打扰」，而这句话每轮也进普通对话的运行时上下文；主人主动说话时会让模型把该回的话咽回去 | 改成「别自己起话头，也别问他在不在忙」 |
| `screen-sense.presence` | handler 未注册时 `defineInvoke` 不拒绝、只挂住：这个窗口从此读不到 presence，永远 `unknown` | 2 秒上限，超时按 `unknown` |

对应新增用例：忙屏「五分钟买断 + 只记一次事件」、发送失败记 `send-failed`、`busy` 文案只约束「起话头」。

### 第二轮：边界

| 边界 | 问题 | 修法 |
| --- | --- | --- |
| 裁决年龄 | `interruption` 走 tick 时钟，45 秒一跳：chat 每轮读到的年龄最多少算 45 秒，一条 20 分钟前的画面还能被当成「此刻」 | 新增 `interruptionNow()`（真实时钟），门、`interruptionLine()`、`considerSpeaking()` 全部改用它；`interruption` 只留给需要响应式的读法 |
| 锁屏延迟 | presence 只在 tick 里读，最多晚 45 秒：刚锁屏时她可能对着壁纸说完一整句 | `lookAround` 抓屏前先刷新 presence（2 秒上限），让「这一眼」看到的锁屏是真的 |
| 五分钟买断 | 主人在第 1 分钟就从忙变闲，她要等到第 5 分钟才重判 | 定时扫视或别处一看发现 `free`（且裁决时间不早于买断时刻）就立刻解除，不再按旧结论闭嘴 |
| presence 挂住 | `sense.presence()` 不回话会把 `lookAround` 一起拖住，开口的前置条件永远不满足 | 2 秒竞速，超时按「没读到」处理 |
| 缩放无测试 | `downscaleForVision` 只在 Chromium 里有 canvas，node 测不到，之前只有「失败会退回原图」这句注释 | 拆到 `libs/image-downscale.ts`，`*.browser.test.ts` 三条：4K → 1280×720 JPEG、已够小的原样返回、坏图退回原图 |

浏览器用例：`pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/renderer/libs/image-downscale.browser.test.ts` → **3 passed**。

### 第三轮：按模块梳理

| 模块 | 级别 | 发现 | 状态 |
| --- | --- | --- | --- |
| 主进程读数 | P2 | `setupSystemPresence` 与 `setupComputerUse` 同批注册，晚于窗口创建：渲染进程最早几次调用只能等满 2 秒再按 unknown | **未改**（涉及启动顺序，需真机验证；已有 2 秒兜底） |
| 渲染端感知 | P1 | AUV 命令没有上限：进程不回话时 `busy` 永不清，之后每次 look 直接返回空——**永久失明** | 已修：每条命令 45 秒 abort |
| 渲染端感知 | P1 | presence 用 `Promise.race` 超时，底层 invoke 仍挂着：每 45 秒留一对永不回收的 eventa 监听器 | 已修：改传 `AbortSignal.timeout(2000)`，eventa 在 abort 时清监听器 |
| 渲染端感知 | P2 | `screen:activity` 失败会再打一次 `screen:interpret`：provider 不支持时每次 look 双份计费 | **未改**，建议失败后记 10 分钟内直接走 interpret |
| 裁决核心 | — | 无。`ttl` 公式等价于「裁决时间 ≥ look 起点」，验算通过 | — |
| 心智 | P2 | `interruption` 用 tick 时钟，被当作「此刻」用于门与提示词 | 已修：`interruptionNow()`；生产代码已无消费者读 computed |
| 心智 | P2 | 锁屏读数最多晚 45 秒 | 已修：look 前刷新 presence |
| 心智 | P3 | 强制看一眼时 `applyScreenLine` 被调用两次（时间戳差几毫秒） | 未改，无行为差异 |
| 开口管线 | P2 | pace 在发送前记账：`send-failed` 也消耗 2 小时间隔 | **未改**，建议失败回滚 + 5 分钟重试冷却 |
| 开口管线 | P2 | `resetOutbound` 不清买断与落盘节流 | 已修（含用例） |
| 聊天上下文 | P3 | `interruptionLine()` 无感知时为 ''，`innerContextLine` 保留 unknown 句——两处策略不同 | 有意，已写注释 |
| 面板与参数 | P2 | 参数只按预设家族（deepseek/minimax）存，不在模型维度存：手调后切模型再切回会被预设覆盖 | **未改**，建议 `paramPresets[presetId][modelId]` |
| 面板与参数 | P3 | `presenceLine` 把 `active`/`idle` 原样英文塞进中文句子 | 未改 |

### 第四轮：参数按模型存 + 失败不计节奏

| 改动 | 做了什么 | 坑怎么堵的 |
| --- | --- | --- |
| 采样参数两级存 | `paramPresetBooks[family][modelId]`，`default` 是家族起点；`paramPresetFor()` 返回 `{values, scope}`，面板显示「当前模型的值 / 家族起点」 | 旧版扁平结构（`settings/consciousness/param-presets`）在 store 初始化时迁移到新键的 `default`，**迁完删旧键**；`resetState` 也删旧键，否则下次启动迁移会把它搬回来 |
| 面板写入目标可见 | 卡片新增一行「参数按模型分别保存……当前模型：{model}」，每行标注值来自模型还是家族起点 | 用户点「存进这套」时不会以为写到整个家族 |
| 发送失败不计节奏 | `recordOutbound` 移到 `notifyConversation` 成功之后；失败只写 `send-failed` 并置 5 分钟冷却 | 不配冷却会变成每秒重试；`lastSentAt`/话题/unanswered 都不再被失败消耗 |

新增用例：同族两个模型各存一份、切回仍保留；旧扁平结构迁移且旧键被删；失败后 3 分钟内不重试、冷却结束后重试并记 `sent`。

**起点值（按厂商文档取，不拍脑袋）**：DeepSeek `temperature` 默认 1.0，官方「通用对话」场景值是 1.3；MiniMax M2 官方推荐 `temperature=1.0`、`top_p=0.95`。取 DS 0.8 / top_p 0.9（flash 级模型收一点，但不压到 0.3——低温会把语气压平，并让「你在忙吗」这类高频套话**更容易**出现），MiniMax 1.0 / 0.95（厂商值）。

## 没做

- 全屏/演示/会议的**系统**判定（`SHQueryUserNotificationState`）。Electron 不暴露别的进程的全屏状态；要判它得写原生绑定或走 AUV 的窗口列表。当前仍由视觉回答这一档。
- 个人响应历史进裁决：`outbound` 里已有当天的条数、未回轮次、最近话题，但没有把它们折成「此刻被打扰的代价」。这是综述里最值钱的那一列。
- 打断后的代价回填（被忽略 vs 被接受）还没有写回存储。
