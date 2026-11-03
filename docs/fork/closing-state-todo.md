# 「收尾状态」待做（代码即真相，改到哪就勾到哪）

> 目的：新会话/换上下文后不必重新推导。**先读这一页，再动代码。**
> 论文（实验与数据）：`D:\新论文\约束的税_PLC-Bench.md` §8；实验脚本 `D:\新论文\exp\plc_bench_e{3,5}.py`。
> 工作副本：`D:\新论文\AIRI_收尾状态_待做.md`（含论文侧的风险与验证口径）。

## 已确认的事实（别重新论证）

1. **主 system prompt 不背这个锅**：`CHAT_FORMAT_RULES` 只有 markdown/数学 6 行 + 时钟规则；角色卡 501 字里没有任何收尾条款。全仓 grep「以…问题结尾 / always end … question」命中 0。
2. **收尾状态从来没被建模**：`relational-policy.ts` 的模式表（CRISIS/ELEVATED/CORRECTION/BOUNDARY/VULNERABLE/PERSONAL）没有告辞。
3. **状态机会主动制造追问**：elevated 分支要求「ask at most one short question」；`repairNeeded` 要求她说「我会改什么」；`probing` 曾是死字段。
4. **实验结论（990 次调用）**：禁止式压住行为但把人设抹平（零人设回复 0.96）；挑衅式（W2）行为近似、人设保住（0.46）。**用 W2，且不要加反例。**
5. `core-agent` 按 `dist` 被消费：改 `src/` 之后不 build 等于没改。

## 进度

- [x] **T1 closing 判定**（`core-agent/src/persona/relational-policy.ts`）
  - `ClosingSignal = 'open' | 'pre-closing' | 'closed'`；`looksLikeFarewell()`（动词 + 离开标记；含问号或超 80 字一律不算）
  - `inferRelationalSignals()` 返回 `closing`；`createRelationalPolicy()` 落到 `stability.closing`
- [x] **T1b 跨轮计数**（`stage-ui/src/stores/chat/context-providers/relational-policy.ts`）
  - `closingRuns`：连续两句告辞 → `closed`，非告辞轮清零；按 `turnKey(session, persona)` 幂等
  - 缺口：**还没有单测**（见 T1c）
- [x] **T2 `probing` 接上消费者**：elevated 分支改为按 `probing` 决定是否允许问一句
- [x] **T3 优先级与降级**
  - renderer：`crisis > closing > elevated > normal`，closing 分支不打印 `Depth:`，不打印 repairNeeded
  - `updateRelationship()`：`boundary === 'stop'` 且 `closing !== 'open'` → 降级为 `unknown`（不计 boundary、不压 stage）
  - `repairNeeded` 在收尾轮为 false
- [x] **T4 文案**：W2 挑衅式（英文指令 + 中文例）
- [x] **真机语料校准**：从运行库 270 条里抽出 39 条真实用户发言，跑 `looksLikeFarewell` → 1 命中且正确（「今天先这样,明天继续」）、**0 误判**。为此加了两条规则：`CLOSING_SHORT_PATTERN`（短句里出现 `先这样/就到这/明天继续/撤了/晚安` 等离开专属标记即算，不含 `算了/好了`）与 `CLOSING_PAIR_MAX=24`（动词+标记规则的长度上限，挡掉"我今天先这样写一版，明天再继续…"这种在讲计划的句子）。脚本 `exp/check_real_turns.mjs`
- [x] 单测：`relational-policy.test.ts` +3（判定表、优先级、boundary 降级）；17 passed
- [x] **T1c provider 单测 + 计数语义**：`nextClosingRun()`/`closingFromRun()` 移进 core（可测），provider 只做 Map；
  测试 `core-agent/.../relational-policy.test.ts`（计数）+ `stage-ui/.../context-providers/relational-policy.test.ts`（6 条：告辞→收尾分支、普通轮→不触发、含问号的"我去做饭了你想吃什么"→不触发、同 messageId 复用、跨 persona 隔离、空文本→undefined）
- [x] 顺手修：provider 原先对**空白文本**（附件轮/手柄输入）也生成 policy 并推进 depth，现按 `.trim()` 直接返回
- [ ] **T2b 两处真相（已更正我上一轮的说法）**：`predictabilityScore / containment / blockMeaningInference / maxIntensity / evidenceRequired / repairAfterDisagreement` 六个字段**在测试里被断言，但渲染层从不读它们**——renderer 把同样的条件（`safety === 'crisis'` 等）重新推导一遍写成散文。所以不是"死字段"，是**两个真相源**：字段改了、散文不会跟着改。修法不是删，是让 renderer 读字段（`policy.safety.blockMeaningInference ? '…' : '…'`），删掉内联推导。`policy.hypotheses` 是**有意不渲染**（renderer 注释写明），保持现状
- [x] **T5 存入侧**（`memory.ts` + `chat.ts`）：`shouldSkipIngest()` —— 告辞轮 + 回复 ≤24 字（一句“嗯，去吧”）不写库；`chat.ts:1085` 已接上，跳过时打 `[memory] skipped ingest for a closing turn`
- [x] **T6 读出侧**（`memory.ts:indexFor`）：三条规则 —— ① `isTranscriptEntry()` 挡掉 `mem-*` 与「用户:/User:」开头的转储 ② 空描述不进索引 ③ 同描述折叠（空白/大小写归一）④ 同一天最多 2 条（`INDEX_PER_DAY`）⑤ 上限 40 行（`INDEX_MAX_LINES`），按 `updatedAt` 倒序而非名字字典序
  - **实测效果（运行库真实数据）**：270 行 / 19,697 字符 → **12 行 / 953 字符（−95%）**；留下的 12 行是母亲、创造者、人设参考、用户画像等真事实
  - **行为收益为零（E7，48 次）**：旧索引 vs 新索引，留话口 13/24 vs 13/24（p=1.000）。合理解释是 19.7k 字符的重复块根本没被有效读取。**不要再声称"索引把她拽回旧腔调"**——那条假设在受控对照下不成立；这项改动的正当性是每轮省 ~4.7k token 与索引干净
- [ ] **T10 引擎侧重复（根因，新）**：同一晚被引擎反复重写 7 条近似条目（`来源: f0dc58c1,d239df4a` 各不相同），32 条「情感记忆: [自循环日记]」描述为空。索引侧只是拦住了它，真正的修法在 castalia 的日记/巩固环节去重
- [ ] **T6 措辞**：`memory.indexFor()` 的 `- 名字: 描述` 改人声，或在 `composeMemoryPrompt()` 加「这些是事实记录，不是语气模板」；`agent-state.ts` 的 desire 在收尾轮降权
- [x] **T7 角色卡**（2026-11-01，用户授权「都改」）：`personality` 追加三条 canon 缺口 —— 否认/结巴/耍赖三层、二选一或抛回的挑衅、波浪号（「忍~耐~咯~」）；80 → 186 字
  - 写入口径：卡只在 localStorage（`airi-cards`），磁盘上没有卡文件。做法 = 往 `Local Storage/leveldb/000097.log` 追加一条 WriteBatch（type=1 PUT，key=`_file://\x00\x01airi-cards`，value=前缀 `\x00` + UTF-16LE JSON，seq=1363），CRC32C（Castagnoli）按 leveldb 物理记录格式打；写完用自写 replay 校验 72 条记录 **0 条 CRC 错**、逻辑重建后新文本在
  - 备份：`D:/AI/hermes-home/cache/scratch/leveldb-bak-20261101-1920`。**如果 app 打不开，把这个目录覆盖回去即可**
- [x] **T10 引擎侧重复（castalia）**：`store.ts` 里 `isNearDup`/`dupId` 只算不用（旧注释自陈"不管是否近重复，都存"）——上一个晚上的 7 条近似来源就是它。改法：① 派生行命中近重复 → 合并到旧行（保留更长文本、刷向量、加引用计数）② 派生行同一天、证据 id 共享 ≥1 且重叠 ≥50% → 合并（措辞变了向量拦不住，证据才是硬信号）③ 用户陈述的事实不合并
  - 探针 `D:/AI/castalia/Castalia/probe_dup_merge.mjs` 三例全 PASS（同证据合并 1 条 / 证据不重叠留 2 条 / 用户事实不合并）
  - 已 `tsc` 编译并把 `store.js` 拷到 `D:/castalia/run/Castalia/dist/`（19:23:57 mtime）
  - **已重启（19:34）**：先杀掉 5 个 mcp-proxy 及其子引擎，再 `schtasks /Run /TN "Castalia Guard"`（守护任务每 2 分钟一轮，自带桥端到端探活与会重建）→ 5 个端口 3310/3312/3314/3316/3318 全部 LISTEN，新进程 19:34:27–33 起（晚于 store.js 写入，必然加载新代码），桥日志正常跑 consolidate（`merged=4`）与 vec-backfill，无报错
  - 仍跑旧代码的两个进程（有意不动）：**PID 18288** = Hermes 网关自己拉起的引擎（我的 MCP 记忆工具走它，杀掉会断本会话）；**PID 34484** = `Castalia-Federation/web/server.mjs`（星图 Web，不写记忆）。下次网关/托盘重启自然更新
- [x] **T8 位置复核（E6，72 次调用）**：`[Context]` 块 vs system 末尾，留话口 3/24 vs 0/24（Fisher p=0.234，无显著差异），基线 9/24（vs S1 p=0.0016）；均长 13.2 vs 13.4；「哼」3/24 → 10/24。结论：位置不丢效果，反而更能带傲娇腔。脚本 `exp/plc_bench_e6.py` / `analyze_e6.py` / `annotate_e6.py`：实验把规则加在 system 末尾，生产走 context provider。用真实卡 + provider 输出重跑 C/A 各 24 条 × 3 模型，比五指标（结问率 / 索取型 / 挑衅语用 / 零人设 / A 组澄清）
- [~] **T9 部署**：已打出验证包 `dist/verify-pack/win-unpacked`（asar 内 `ending the conversation`=1、`skipped ingest for a closing turn`=1）；**在跑的那份 `dist/win-unpacked` 仍是旧的（=0）**，替换需要先关掉 app（文件被占用）。
  - **2026-11-01 19:51 部署完成**：`robocopy verify-pack/win-unpacked → win-unpacked`（app 已关闭）；成对性用 asar 头哈希验证 —— `sha256(header_json)` 里要取 **`hdr[4:]`**（跳过 4 字节长度前缀），该 64 位 hex 确实出现在 `airi.exe` 里，说明 asar 与 exe 一致，启动校验会通过
  - 角色卡侧证：app 开关一次后，`傲娇是壳不是心肠` 出现在新 compact 出的 `000101.ldb`（19:41）——说明 app 读进了我们写的那条 log 记录并把它并进表，**没被判定损坏**
  - 本机可用命令（pnpm 已装：本机 PATH 里 `/d/castalia/run/_shared/bin`）：
    ```
    cd D:/system/AIRI/packages/provider-inference && node D:/system/AIRI/node_modules/tsdown/dist/run.mjs
    cd D:/system/AIRI/apps/stage-tamagotchi && node node_modules/electron-vite/bin/electron-vite.js build < /dev/null
    cd D:/system/AIRI/apps/stage-tamagotchi && node node_modules/electron-builder/cli.js --dir \
      --config.directories.output=dist/verify-pack \
      --config.electronDist=D:/system/AIRI/apps/stage-tamagotchi/node_modules/electron/dist < /dev/null
    ```
  - **部署铁律**：`airi.exe` 里 `EmbeddedAsarIntegrityValidation` = **ENABLED**（fuse 索引 4，读法：exe 内找 `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`，其后 1 字节版本 + 每 fuse 1 字节，0x31=开）。所以 **app.asar 必须与 airi.exe 成对替换**，只换 asar 会让 app 启动时校验失败。app 在运行时 exe 被独占，只能等用户关闭后整树 robocopy
  - 三个坑：① `electron-vite`/`electron-builder` 在后台跑会报 `stdin is not a tty`，必须前台 + `< /dev/null`；② electron-builder 默认去 GitHub 拉 electron（本机 ETIMEDOUT），用 `--config.electronDist` 指向已装的解包版；③ 它收集依赖要 `pnpm list --json`，pnpm 不在 PATH 时直接 `No JSON content found in output`。

## 验证结果（2026-11-01，本轮）

| 链路 | 判据 | 结果 |
|---|---|---|
| 判定 → policy | `inferRelationalSignals` 10 条正负例 | ✅ |
| policy → 渲染文本 | renderer 三分支优先级、boundary 降级、repairNeeded 关闭 | ✅ 20 passed（core 两个测试文件） |
| 渲染 → ContextMessage | provider 6 条（含幂等、跨 persona） | ✅ 6 passed |
| ContextMessage → 注册表 | 现有 `context-store.test.ts` 的 ReplaceSelf | ✅ 7 passed |
| 注册表 → wire（provider 请求） | 新增 `render-provider-chat.test.ts`：`runtime-context` 段必须出现在 user 消息正文的 `[Context]` 块里 | ✅ |
| 记忆写入 | `shouldSkipIngest` 5 例（告辞+一句话 → 跳过；长回复/非告辞 → 照写） | ✅ |
| 记忆索引 | `indexFor` 6 条新测（转储/空描述/折叠/每日上限/总上限/仍可 read） | ✅ |
| 部署 | `grep -c -a 'ending the conversation' apps/.../resources/app.asar` | ❌ **0**（当前在跑的 app 还是旧包） |
| 记忆 persona 解析 | 运行库 270 条全部 `persona='airi'`，`resolvePersona()` 会映射到 airi | ✅ |
| 自我状态 | `psyche_state` 1 行（band=negative，今天更新），`psyche_events` 4 行 | ✅ 非空 |

既有红测（与本次改动无关）：`context-providers/memory-recall.test.ts > drops a recall that is slower than the deadline` 在 fake timers 下 20s 超时。

## 日记（diary）连线核查 —— 2026-11-01

链路：`mind` 后台道写 `innerThoughtsRepo`（IndexedDB `airi-mind/thoughts`）→ 日记页按天分组 → 「记住这一天」`distillDay()` → `memory.write` + `makeGeneral` → 索引 `- diary-YYYY-MM-DD: …`

- [x] 端到端测试 `stage-ui/src/stores/modules/diary-distill.integration.test.ts`（4 passed）：按天分组、一天一条索引行、重复点击不重复入库、空日返回 undefined
- [x] 真机数据：IDB 里 **15 条思绪**（`think-*` 2 / `thought-*` 13），全部 `2026-11-01`、`visibility=private` → 日记页只会有 1 天、1 个「记住这一天」
- [x] 修：`lastDistilled` 只是内存 ref，刷新后按钮又会劝你"记住这一天"（其实已记住）。改成持久化 `diary/distilled` + `hasDistilled()`，`diary.vue` 改用它
- [x] 观察（不是 bug，但要知道）：日记正文只经两条路进模型 —— ① `innerContextLine()` → `self-initiated-speech`（她主动开口时）② 主人点「记住这一天」后的索引行。**普通回复不读日记**

## 验证命令

```bash
# 单测（core-agent）
cd D:/system/AIRI/packages/core-agent
node D:/system/AIRI/node_modules/vitest/vitest.mjs run --config vitest.config.ts src/persona/relational-policy.test.ts

# 构建（pnpm 不在 PATH 时直接调 tsdown）
node D:/system/AIRI/node_modules/tsdown/dist/run.mjs
grep -c 'ending the conversation' dist/index.mjs   # 必须 ≥1
```

## 坑

- pnpm 不在本机 PATH；`node_modules/.bin/*.cmd` 的 shim 里是 MSYS 路径，node 会解析成 `D:\d\system\...`。**直接 `node <abs>/node_modules/<pkg>/dist/run.mjs`。**
- typecheck 有大量既存失败，只看自己改的文件，别用退出码判定整个包。
- 改卡会重设实验基线：动 T7 前先记一次当天的探针数字，否则前后不可比。
