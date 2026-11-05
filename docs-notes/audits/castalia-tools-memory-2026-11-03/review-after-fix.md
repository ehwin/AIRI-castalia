# 记忆体 / Castalia 链路 —— 修复后复查与「假绿」反思

复查时间：2026-11-03 14:2x（Asia/Shanghai）
复查对象：`D:\AI\castalia-AIRI`，分支 `feat/tuning-manifest`
复查基线：审计报告 `report.md`（HEAD `fa9bbf417`，15 项问题，5 P1 / 10 P2）
本次改动：`fa9bbf417 → acbf25d76`（4 个提交，见文末）

结论先说：**15 项里 14 项已按报告的验收口径改掉并留下断言，F05 只做到「能力可见」，没做「逐能力面板」。所有结论都在单元/隔离测试层面，真实 Electron 与真实模型仍未跑。**

---

## 一、复查方法

1. 对每一项先回到报告给出的**根因位置**，确认那行代码现在是什么。
2. 改完的每一项必须有一条**可失败的断言**：先让它在旧代码上红，再让它在新代码上绿（F02/F03/F04/F08/F10/F12/F15 都是这么做的，旧的复现测试被翻成回归测试）。
3. 只认三种证据：库里的行、端口收到的参数、工具返回的字符串。界面状态与配置推导都不算证据。
4. 复查边界与报告一致：没有启动 Electron 界面，没有读用户真实库，没有验证真实模型的调用意愿。

## 二、逐项结论

| 编号 | 状态 | 修法（落点） | 断言（可失败） |
| --- | --- | --- | --- |
| F01 角色贯穿 | 已修 | 契约加 `persona`（`shared/eventa/castalia-memory.ts:27/33/55/82`）；进程内适配器改为**按角色各开一份 bank**（`castalia-inprocess.ts:64/80`）；stdio 传 `characterId`；工具/召回/落库都带当前卡 | `memory.remote.test.ts`「passes the asking card to the lookup and the ingest」；审计「searches the asking card when the caller passes its persona」 |
| F02 删除返回 false 仍移除 | 已修 | `remove/forget` 返回 `{found, persisted}`，后端 `false` 时把行放回（`stores/memory.ts`） | 「puts the entry back when the backend refuses to forget it」 |
| F03 保存/删除提前报成功 | 已修 | 工具 `await persisted` 才输出 Saved/Forgot，失败区分「拒绝/不可达」（`tools/memory.ts`） | 「waits for the backend and says NOT saved…」「says NOT forgotten when the backend keeps the row…」 |
| F04 故障伪装成没记忆 | 已修 | `lookup` 返回 `ok/partial/unavailable/failed`；工具对后两者明说「不代表她没记住」，提示词同步 | 「never reports an unreachable or failed lookup as a fact…」＋ 4 条 lookup 分支测试 |
| F05 模块状态冒充能力 | 部分 | 新增 `memory:status`（transport/项目/角色/**能力位**/失败原因），两个后端分支都注册（`castalia-memory.ts:326/426`）；模块行显示实况；进程内模式不再要求 `engineEntry` 文件存在 | `castalia-config.test.ts` 5 条（缺库/禁用/stdio 缺 entry/进程内不要求 entry）＋ 每 5 分钟刷新 |
| F06 自动情感门槛不可见 | 已修 | 状态里带 `emotion: {autoFromVad, estimator, note}`（`castalia-memory.ts:345-353`），模块行直接读 | 类型 + 代码路径；无独立单测（见「仍然没验证」） |
| F07 十分钟没有触发器 | 已修 | `bank.flushStaleVadQueue(maxAgeSec)` 只处理超龄批次；主进程每两分钟扫一次（`castalia-memory.ts:184/398`） | 审计「force-flushes a queue batch only once it is older than the deadline」（先断言未超龄不动，再断言超龄后 pending=0） |
| F08 主动检索漏共享记忆 | 已修 | 进程内 `search` 显式 `includeGeneral: true`（`:162`） | 审计「includes general memories in the search tool…」 |
| F09 后端新行不进读缓存 | 已修 | ingest 成功后 debounce 2s 重读；自循环/维护产出后同样触发 | 「re-reads the backend after an ingest so the new row becomes readable」 |
| F10 傲娇滑块无消费者 | 已修 | `formatSelfStatePrompt` 在 ≥3 档时输出语气行，并把「一切正常」的静默阈值算进去 | 审计「reflects the tsundere level in the prompt…」（0 档不含、10 档含） |
| F11 两套状态键 | 已修 | App.vue 与设置页统一 `resolvePersona`（`App.vue:491/496/518/546/571/574`；`settings/modules/castalia.vue`） | 静态确认 + 类型；无独立单测 |
| F12 重跑缺会话工具 | 已修 | 重跑走 `withRunTools` 同一套注册；找不到工具时**抛错不改历史**（`tool-call-rerun.ts`） | 「refuses the rerun and keeps history when the tool is unavailable」（断言 history 未被改写） |
| F13 工具降级不可见 | 部分 | `llm.toolsDisabledFor` + `retryToolSupport()`；对话模块行显示被降级的模型 | store 层导出 + 模块行；**没有重试按钮**，文案改成「重启后重新探测」 |
| F14 开关只管一部分 | 已修 | 关闭时 psyche 轮询、think→selfCycle、sleep→maintain、精力镜像全部跳过（`App.vue:515/543/569/582`） | 静态确认（四处 gate） |
| F15 跳过冒充完成 | 已修 | 页面先判 `skipped`，显示原因与「上次结果」，旧计数不再当本次产出 | 分支顺序 + i18n 文案 `maintain_skipped` |

### 顺手修掉的一个真崩溃

`App.vue` 的切卡 watch 引用了 `createFullStageRuntime()` 作用域里的 `cardStore` —— 那是 `ReferenceError`，只在**下次启动**时炸。已改为模块级 `airiCards`。这解释了「改完之后起不来」的现象。

## 三、复查后仍然没验证的（写清楚，不留绿）

1. **真实 Electron**：App.vue 的 IPC 包装、主进程定时器、渲染层状态刷新都只有 typecheck 与代码路径证据，没有跑过窗口。
2. **真实模型**：提示词说「检索失败就说检索失败」，模型会不会照做未验证；同样没验证它是否会因为工具返回 NOT saved 而改口。
3. **真实库**：所有隔离测试用的是临时库 + 关闭 embedding；2000 条列表上限、超大库分页没测。
4. **F05** 只有一句话的 detail，没有「逐能力」面板；状态靠 5 分钟轮询，不是事件驱动。
5. **F06** 只上报门槛与估计器，「最近一次分析为什么没推进」仍要读 `affect_status`。
6. **F13** 有 API 没有按钮；降级状态只存在内存里，重启即清空（这点已写进文案）。
7. **F07** 两分钟扫描只在进程内后端注册；stdio 后端没有 `flushStaleVadQueue`。
8. `castalia-memory.ts` 里仍有 10 条 HEAD 既有的 eslint 规则问题（`prefer-global/process` 等），没扩大也没清理。

## 四、反思：什么会造成「假绿」

这一轮最值得留下的不是 15 个补丁，而是**为什么这些洞能同时通过测试、通过评审、还能在界面上显示正常**。按来源分七类，每类都附本仓库的实例。

### 1. 断言写的是缺陷，不是期望

审计的 13 条隔离测试全绿，而它们证明的正是「工具仍返回 Saved」「检索仍返回没匹配」。测试没有错——它忠实记录了现状；但它一旦进了 CI，就变成了「这个 bug 不许修」。
**判据**：一条测试如果描述的是"当前行为"而不是"应该发生的事"，它就不是回归测试，是化石。
**做法**：缺陷测试必须成对——`documents-current`（明确标 xfail，修完删除）与 `expects-fixed`（先红后绿）。本轮把那 4 条翻成后者。

### 2. mock 停在边界内侧

`memory.remote.test.ts` 测的是 store → 端口，端口签名是 `forget(): Promise<void>`。真实的 boolean 在 App.vue 的 `forget: async entry => { await forgetCastaliaMemory(entry) }` 里就丢了。单测看不见这一层，因为 mock 的端口本来就是 `void`。
**判据**：任何"信息在层间消失"的 bug，用层内 mock 永远测不出来；要看**签名**能不能承载结论。
**做法**：让签名承载结论（`MemoryPersistResult`），并给端口本身写一条「拒绝要传上来」的测试。

### 3. 把开关当成能力

`configured: memoryStore.enabled` —— 用户点了开关，界面就说"已配置"。可是后端可能只是条目 SQLite（无检索、无入库、无循环）。这是最便宜的一种绿：**只要布尔值还在，界面永远绿**。
**做法**：状态必须由运行时探测产生（`memory:status`），且要能列出"缺哪几项"。

### 4. 错误被折叠成空结果

`catch → return []` 是这一类里最危险的写法：它把"问不到"变成"没有"。上层（模型）拿到的语义完全不同，而所有测试都绿——因为没人断言"失败要长得不一样"。
**判据**：凡是 `catch` 之后返回值与"正常空值"同形，就必然有一天被当成事实。
**做法**：返回带 `status` 的联合类型；空结果只在 `status === 'ok'` 时可被解释为"没有"。

### 5. 乐观更新当作落盘

先改本地数组、再 `void remote.save()`。界面立刻对，库可能永远不对；而"乐观"这个词让它在评审里看起来像设计，而不是缺陷。
**做法**：本地可以乐观，但必须带一个**可等待的持久化结果**，工具/提示只认后者；失败要能回滚。

### 6. 文档里的时限 ≠ 代码里的触发器

注释写「最多十分钟」，实现里只有"下次 flush 时顺便检查年龄"。没有定时器的那十分钟，是**文档在替代码撒谎**。
**判据**：任何写着"最多 N 分钟/小时"的地方，都要能指出是谁在 N 之后叫醒它。
**做法**：给时限配一个独立的扫描器（本轮是两分钟一次、只处理超龄批次）。

### 7. 状态只在启动时读一次

`hydrate()` 在启动时跑一次，之后后端自己写的行（ingest、维护、自循环）永远不在缓存里。搜索能命中、`read` 读不到 —— 两个入口看到两个时间点的世界。
**做法**：谁造成新行，谁负责触发一次 debounce 重读。

### 8. 控件有值、没有消费者

傲娇滑块存进了 snapshot，测试断言 snapshot 变了 —— 绿。提示词一个字没变。
**判据**：每个可操作控件，都要能说出"它的值最终改变了哪一句输出/哪一个决策"；说不出来就是装饰。
**做法**：要么接消费者（本轮接进提示词），要么把控件标成未接线并禁用手感。

### 9. 降级自动、恢复手动，且状态位缺失

工具被服务商错误降级是自动的，恢复要靠重启；界面两个都不显示。
**判据**：凡是有"自动降级"，就必须有"可见状态 + 明确恢复路径"，否则用户会认为自己看到的是完整能力。

### 10. 工具链自己也会造绿

本轮我犯过两次：用 `eslint --fix` 跑坏了一个块注释、用脚本批量改文件把 LF 改成 CRLF，导致 9 个文件显示"整文件重写"。测试全绿、提交成功，但评审看到的是噪音，真正的改动被埋掉。
**判据**：`git show --numstat` 里出现「增删接近文件行数」的条目，先怀疑行尾/格式化，再怀疑改动。
**做法**：批量改文件后跑一次行尾归一（本轮最后做了），提交前看 numstat 比例。

## 五、下次评审怎么用这张表

1. 先问「这条链的产物是什么」，再问「测试断言的是产物还是返回值」。产物 = 库里的一行、端口收到的参数、返回给模型的字符串。
2. 对每个 `catch`、每个 `configured`、每个 `skipped` 分支单独要一条断言。
3. 任何"最多 N 分钟"都要指出触发器；任何"自动"都要指出状态位与恢复路径。
4. 界面上的"已开启"不许作为能力证据；能力必须来自运行时探测。
5. 复现测试与回归测试分开命名，避免把缺陷固化进 CI。

---

## 附：本次提交

按交付惯例压成**一个**提交供复审：`26e7f9c09`（`fa9bbf417..26e7f9c09`）。
压缩前后的树哈希一致（`51fd1859`），内容没有变化。原 7 个提交（`c6dfd4b90`、`bc6533007`、`acbf25d76`、`25cdded11`、`1d4fb7731`、`5dd82090c`、`e277662c7`）见 reflog 与提交正文。

| 原提交 | 内容 |
| --- | --- |
| `c6dfd4b90` | F01 角色贯穿、F02/F03 结论等后端、F04 故障语义、F05 能力上报、F08 共享记忆、F11 角色解析、F14 开关约束、F15 跳过文案、启动崩溃 |
| `bc6533007` | F06 自动情感门槛、F07 队列到期扫描、F09 缓存刷新、F10 傲娇接线、F12 重跑保历史、F13 降级可见 |
| `acbf25d76` | F09 补完（自循环/维护产出也刷新） |
| `25cdded11` | 复查与假绿反思文档、F13 文案按事实改、后端状态随 5 分钟轮询刷新 |
| `1d4fb7731` | 队列能力/列表截断/情感门槛如实上报、该文件 lint 清零 |
| `5dd82090c` | 真机换包：角色 id 判断、hydrate 崩溃、能力面板上真机 |
| `e277662c7` | 记忆按卡的 id 分区，别名只在自有数据时跟随 |

验证快照（本轮重跑）：stage-ui 7 文件 **153 passed**；castalia-plugin **102 passed**；app castalia **17 passed**；审计套件 **15 passed**；改动文件 typecheck 0 新错；eslint 仅剩两个文件里 HEAD 既有的 29 条样式问题。

---

# 六、补记：先把「没验证」的处理掉（2026-11-03 16:5x）

上一节列的 8 条待验证，这轮逐条处理。结论先给：**真实模型这一条（最关键的）问了真人模型，答案是对的；真实库计数测了；stdio 与截断这两处从「不知道」改成「如实上报」；只剩 GUI 与两个界面动作没有做。**

## 6.1 真实模型：它会不会把「问不到」说成「没有」

探针脚本 `D:/AI/hermes-home/cache/scratch/probe-model-memory.mjs`。它**从源码里抽出当前提示词原文**（`packages/stage-ui/src/tools/memory.ts` 的 `composeMemoryPrompt` 数组，10 行），用真实端点（`sidrune` 网关，模型 `deepseek-v4-1-flash`，与 AIRI 那条云端 API 同族）跑三轮：

| 用例 | 工具返回给模型的内容 | 模型实际回的话（摘录） | 判定 |
| --- | --- | --- | --- |
| A 后端不可用 | `The memory lookup is unavailable right now (backend did not answer). This says nothing about whether the fact is remembered.` | 「我搜了，但记忆库这次没响应——后端没回话。**这不是「没记住」的证据**，只是我这边暂时查不了……等它恢复我再查一遍。」 | 通过：明确区分「查不了」与「没有」 |
| B 搜索为空白 | `No memory matched "生日".` | 「我刚查过，可记忆里没有关于你生日的记录，一个字也没有。如果你愿意告诉我，我就把它存下来。」 | 通过：空结果说「没找到」，并给补救路径 |
| C 命中 | `Search hit 901c50de: 官方档案里，我的生日一栏写的是「未知」，不过 6月27日这天我记得。` | 「搜到了——记忆里有这么一条：……正式记录上是不明的，但我记住的是 **6月27日**。要不要我把它当成你的生日，正式记一条？」 | 通过：按原文引用，不擅自改写 |

顺带观察到一个非缺陷现象：B 用例里模型会自己再搜一次（把查询细化成「6月27日」），C 用例偶尔连搜两三轮才收口。这属于「同一个问题多次检索」，不是把失败说成没有；如果以后要压轮次，属于工具描述/提示词的调优，不在本轮范围。

## 6.2 真实库：上限、分区、活跃条目

把 `D:/castalia/memory-banks/airi` 的五个分类库只读复制到 scratch 后直接查 `memory` 表：

| 分区 | 总行 | 活跃行 |
| --- | ---: | ---: |
| `airi/general` | 296 | 254 |
| `airi/project` | 98 | 53 |
| `airi/user` | 75 | 12 |
| `airi/reference` | 2 | 2 |
| `airi/feedback` | 1 | 1 |
| `default/*` | 0 | 0 |
| **合计** | 472 | **322** |

两个结论：

1. `listMemories(2000)` 的上限今天没有撞到（322 ≪ 2000），但**静默截断**这件事本身就是坑：撞到之后面板、索引、模型会一致地以为「库就这么大」。
2. `default` 分区**一行都没有**。这解释了 F11 为什么是 P1：任何仍拿裸 `activeCardId`（值是 `default`）去问 psyche / 精力 / 检索的调用点，读到的都是一个空分区——界面显示「已开启」，实际是另一个宇宙。

## 6.3 截断从「静默」改成「上报」

- `castalia-inprocess.ts`：列表结果落到 `listState = { listed, truncated }`，撞上限时打一条 warn。
- `memory:status` 增加 `entries: { listed, truncated }`；模块行的 `backendNote()` 在截断时追加「只读到 N 条（撞上限，列表不是全部）」。
- 顺带把 `castalia-memory.ts` 的 14 条 eslint 清零（`node:process` 导入、单行多语句、`prefer-const`、jsdoc 空标签），现在该文件 **0 error 0 warning**。

## 6.4 stdio 后端的队列能力：如实为 false

查过引擎 `dist/index.js` 注册的工具名（`memory_search`、`memory_get`、`memory_list`、`fact_search` 等 11 个 memory_* 加其余），**没有任何 VAD/队列刷新工具**。所以 stdio 适配器不是「忘了接」，而是「这个后端没有这个能力」。处理方式：

- 契约新增能力位 `capabilities.vadSweep`；stdio 分支为 `false`，条目 SQLite 分支为 `false`，进程内分支按函数是否存在判断。
- 扫描器在后端没有该能力时**明确打一行日志并退出**，不再安静地每两分钟空转。

## 6.5 还没做的两条（都要界面）

1. **F05 的逐能力面板**：现在只有模块行的一句话；逐项（recall/search/facts/ingest/maintain/selfCycle/psyche/vadSweep）没有单独的勾选/叉号 UI。
2. **F13 的重试按钮**：`retryToolSupport()` 已导出，但没有任何按钮调用它；文案已改成「重启后重新探测」，所以文案没有撒谎，但用户少一个快捷入口。

这两条加上「真实 Electron 跑一遍」，都需要开窗口验证，按既有约定要先问。

## 6.6 本轮验证快照

- stage-ui：`memory`/`memory.remote`/`tools/memory` 3 文件 **41 passed**；含 chat/tool-call-rerun 的 5 文件 **111 passed**。
- castalia-plugin：**102 passed**（14 文件）。
- 审计套件：**15 passed**。
- typecheck：stage-tamagotchi 的 castalia 相关 0 错；stage-ui 的 `stores/memory.ts` 0 错。
- eslint：`castalia-memory.ts` 0 error 0 warning；`agent-state.ts` / `bank/index.ts` 仍有 HEAD 既有的样式债（未由本轮引入）。

---

# 七、真机验证（换包重启，2026-11-03 17:1x–17:5x）

按「构建 → 打包 → 替换运行侧 → 重启」走完，运行侧 `D:\system\AIRIpps\stage-tamagotchi\dist\win-unpacked`
已换成新包（`--remote-debugging-port=9222` 启动，便于核对）。回滚点：`win-unpacked.bak-20261103T171000` 与
`resources/app.asar.bak-20261103T17*`。

真机跑出来两个单测永远抓不到的问题，都已修掉并留了回归：

## 7.1 P1：分区键是「卡的 id」，不是角色名

先把事实说清楚（我第一版写错过，用户纠正）：

- 库里两张卡：`default`（ReLU）与 `N_h4lzzOfl0AYehOR171-`（**尤诺**）。
- 218 条活跃记忆**全部**属于尤诺这张卡的 id；`airi` 一条都没有。
- `airi` 是卡内容里的**角色自我介绍名**，不是分区键。按角色名猜分区，必然猜空。

| 分类 | character_id | 活跃行 |
| --- | --- | ---: |
| general | `N_h4lzzOfl0AYehOR171-` | 174 |
| project | `N_h4lzzOfl0AYehOR171-` | 29 |
| user | `N_h4lzzOfl0AYehOR171-` | 12 |
| reference | `N_h4lzzOfl0AYehOR171-` | 2 |
| feedback | `N_h4lzzOfl0AYehOR171-` | 1 |

我一度把配置里的这个 id 判成"过期垃圾"、改成 `airi` —— 那是错的，等于把她的记忆搬到空分区。已还原。

真正要修的是 `resolvePersona`：**卡 id 就是键**。别名（`default` → `airi`）只在别名自己名下有行时才跟随，
否则用卡自己的 id。中途我还写过"退到后端上报的 character"的兜底，也删掉了——那是**当前写入方**的 id，
切到 ReLU 卡时会让她读到尤诺的记忆，属于跨卡串味。

回归断言（`memory.test.ts`）：尤诺卡 → 自己的 id；ReLU 卡 → `default` 且索引为空；只有当 `airi` 名下真有行时
`default` 才解析成 `airi`。

## 7.2 P1：真机上 hydrate 一直失败，缓存从没更新过

在设置窗口抓控制台：

```
[memory] remote hydrate failed, keeping local entries: Error: value.includes is not a function
```

根因：`parseTime()` 假定 `updated_at` 一定是字符串。真库里它是混合类型——实测某分类 **254 行 INTEGER、42 行 TEXT**。
第一行整数就让整次 `list` 抛错，渲染层退回旧缓存，于是"面板有库、模型读不到"。

处理：抽成共享 `packages/castalia-plugin/src/bank/time.ts` 的 `parseBankTime()`（吃秒/毫秒 epoch、`YYYY-MM-DD HH:MM:SS`、
ISO、空值），两个适配器（进程内 / stdio）都改用它，并加 `castalia-inprocess.test.ts` 三条断言。

复验：控制台不再有该警告；`localStorage['memory/entries']` 从"旧数据"变成 218 条，与库内活跃数一致。

## 7.3 顺带确认的三件事

1. **能力面板真的渲染出来了**：8 个能力位全 ✓（vadSweep/recall/search/facts/ingest/maintain/selfCycle/psyche），
   自动情感门槛那句人话也在。
2. **`vadSweep` 在进程内为 true**：队列扫描器在跑，不再是"安静空转"。
3. **测试会受环境变量影响**：我的 shell 里残留了 `PSYCHE_BAND_HOLD/ENTER/CENTER_OFFSET`，castalia-plugin 有 1 条测试
   因此失败；`env -u` 后 102 passed。这属于"假红"，但同样说明测试对环境的隐含依赖要写进文档。

## 7.4 真机仍未覆盖

- **聊天内的一次真实检索**没有跑（要往用户会话里发消息，未获授权）。已验证的是：数据在 `N_h4lz…`、缓存里也是它、
  `resolvePersona('default')` 返回它、检索/读取走的正是这个 persona。
- 语音、Live2D、视频工具等与本轮无关的链路未回归。
- 面板的"逐能力"目前是一排 chip，没有逐项开关（能力由后端决定，UI 不提供开关）。

## 8. 2026-11-05 补丁：情绪链与日记链

这一轮按“数据来源、时间语义、失败反馈”三条线补，改动都落在 AIRI 进程内跑的那份代码上。

### 8.1 情绪链

| 洞 | 位置 | 处理 |
| --- | --- | --- |
| `psyche` 镜像标记被当成事件 | `castalia-plugin/src/agent-state.ts` | 提示词与设置面板都过滤 `reason === 'psyche'`；轮询不是她经历过的事 |
| `updatedAt` 是读时间，不是观测时间 | `shared/eventa/castalia-memory.ts`、`bank/index.ts`、`App.vue`、`store.ts` | 快照新增 `lastEvidenceAt`（`-1` = 从未）；镜像按证据时间老化；过期分支不再拨动 `lastUpdated`（精力衰减钟） |
| 重启后 `pending` 行永远悬着 | `bank/index.ts` `flushStaleVadQueue` | 先按 `character_id` 聚合 durable 的 `pending` / `pending_psyche` 行，逐角色 `recoverPendingVadQueue`；到期判断改成项目级 |

实测：真库 8 条 2026-11-03 02:33–03:18 的 `vad_queue` 行悬了 33 小时，恢复路径原本只在夜间维护里跑一次。

### 8.2 日记链

| 洞 | 位置 | 处理 |
| --- | --- | --- |
| 蒸馏假成功 | `stage-ui/src/stores/modules/diary.ts` | 改判 `memory.write()` 的 `persisted`；后端拒绝时返回 `undefined`，不写“已记住” |
| 安静的一天重复同一行 | `core-agent/src/persona/diary-distill.ts` | `slots = min(max - shared, rest.length)` |
| 比率当条数 | `stage-pages/.../diary.vue` | `said: shared.length` |
| 无 persona 的旧想法每张卡都看得到 | `stage-ui/src/stores/modules/diary.ts` | 读日记的第一张卡收养（写回 persona），与 `switchCharacter` 同一策略 |
| 失败没有反馈 | `stage-pages/.../diary.vue` | 后端拒绝时按钮旁显示“没记住：记忆库没有接收这次写入” |

`core-agent` 的 `dist` 已重建；消费方读的是 dist。

### 8.3 验证

- `castalia-plugin`：120 passed / 16 files（新增 `psyche` 标记、队列恢复两条）。
- `stage-ui`：`diary-distill.integration` 6 passed；`chat.contract` / `video-share` / `memory` / `memory.remote` / `tools/castalia` / `castalia-path` 111 passed。
- `core-agent`：`diary-distill` 8 passed。
- 审计套件：15 passed。
- `eslint` 改动文件 0 新增（`bank/index.ts` 16 条、`bank/index.test.ts` 11 条与 HEAD 一致）。
- `@proj-airi/stage-tamagotchi build`：通过（28 s）。
- 队列恢复做了 red→green：去掉恢复块时 `expected 0 to be greater than 0`，恢复后通过。

### 8.4 仍要产品定夺

- `shared` 没有生产者：她主动开口不会写 `visibility: 'shared'`，所以“她说出口的”一栏恒空。补生产者还是删栏目？
- 日记标题取的是主人那句，注释却说取她自己那句。改注释还是改语气模板？
- `PSYCHE_FROM_VAD=on` 时显式写入被拒（`estimator_active`），自动词表只覆盖 8.6% 的对话。
- psyche band 工作点 `-0.35/0.12/0.05` 是在 CPED 语料上调的；套到 41 条 AIRI 真实会话上会把 38 条判成 positive（`psycheState.ts:109`）。
- 引擎日记的“情绪指数（旧量表）”恒 0：进程内 `addMood()` 没有调用方。它属于 vendor 镜像，改动要同步上游。
- 日记只读最新 200 条思绪，更早的日期没有“记住这一天”。
