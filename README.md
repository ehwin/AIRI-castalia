# AIRI · Castalia 记忆体升级版

**一句话**：给 [Project AIRI](https://github.com/moeru-ai/airi) 装上**长期记忆 + 情绪回路** —— 把 Castalia 引擎搬进 AIRI 主进程：角色记得住、会淡忘、有短期情绪状态，而且不靠子进程、不编译原生模块。

上游 AIRI 是"会说话的虚拟角色"：对话停在上下文窗口里，关掉就忘。本仓的升级把记忆做成**三条互不越界的链路**——证据链、情感链、派生链——跑在 Electron 主进程内，SQLite 落盘，零子进程、零 API 成本。

- 基线：上游 **v0.13.1**（`pnpm@11.24.0`），本仓在其上 **40 个提交**
- 记忆体相关路径：**201 个文件 / +26,574 −21 行**（引擎镜像 52 文件 15,639 行、插件胶水 11 文件 613 行、托盘脚本 5 个 4,911 行、NPU ASR 195+37 行）
- 实测：插件 `tsc --noEmit` **0 error**、vitest **7 files / 30 tests 全过**、引擎镜像 **0 断链 / 0 原生依赖残留**
- 许可：**AGPL-3.0-or-later**（沿用上游）；上游原始 README 在 [docs/README.upstream.md](docs/README.upstream.md)

---

## 一、升级了什么

### 1. 记忆引擎改为**进程内**运行（本仓最大的结构性改动）

Castalia 原本是 stdio MCP 子进程（酒馆与外部宿主走那条路）。本仓把它镜像进插件，直接跑在 Electron 主进程：

| | 子进程 MCP 形态 | 本仓（进程内） |
|---|---|---|
| 启动 | 每次连接 spawn 一个 Node 子进程 | 随应用启动，零 spawn |
| 原生依赖 | `better-sqlite3` + `sqlite-vec`，**按 Node ABI 编译**，换 Node 就得重装 | `vendor/sqlite-shim`（node:sqlite），**无原生模块** |
| 崩溃域 | 子进程挂了宿主不知道 | 同进程，异常宿主可见 |
| 数据 | 同一批 `memory.sqlite` | 同一批库、同一套读写路径 |

代价：引擎源码以 `@ts-nocheck` 镜像，类型安全靠上游 tsconfig（见「已知限制」）。

### 2. 情感与短期状态：从"每轮问模型"到"确定性状态机"

| 能力 | 上游 | 本仓 |
|---|---|---|
| 情绪记忆 | 无 | 写入即打 VAD（`vad_valence/arousal/dominance` + `emotional_impact`）；模型不可用回落本地词表，没有情感词**不造情绪** |
| 短期状态 | 无 | `psyche_state`：基线回归 + 半衰期衰减（v 24h / a 4h / d 36h）+ 有界误差步 + 滞回带；**模型只提候选，代码做转移** |
| 事件幂等 | — | `eventId` 去重（128 条窗口）、旧时间戳不回拨、`BEGIN IMMEDIATE` 内读—转移—写 |
| 无可靠证据 | — | 写 `abstain`，**不写 neutral、不推进状态**；`neutral` 只代表"有证据且接近零" |
| 状态注入 | — | `context_get` 同时给 JSON `psyche` 块与人类可读状态块；有证据时 psyche 是唯一 affect owner |

### 3. 自循环与日记：派生记录不许回流当证据

角色自己写日记，但日记**不能**再被当成用户事实：

```text
conversation_log（证据，general 库）
  -> VAD 队列（只吃 active 的 conversation_log）
  -> psyche_state（短期状态，不是 memory）
  -> 注入 / 检索 / 回复

conversation_log + psyche_state
  -> self_cycle（持久游标 (created_at,rowid) + claim + evidence_key 幂等）
  -> agent_diary（project 库；带 evidence_ids / state_version / generated_by；不 embed、不进 VAD）

检索 / 注入 / 反思 / 整合 / 事实来源 / 实体图  —— 默认排除 agent_diary 与 agent_state
```

- 自循环定时器**默认关**（`SELF_CYCLE_INTERVAL_MINUTES=0`），要自动跑得显式开。
- 崩溃恢复：claim 后崩溃 → 一小时后可回收；日记已落库但 claim 未完成 → 下次按 `evidence_key` 补完，不重复生成。
- 派生记录对通用 `memory_delete` / `restore` 不可变。

### 4. 记忆写入与召回接进真实对话路径

- 每轮对话结束写回记忆库（不再靠外部脚本补）。
- 会话缓冲喂进临时反思路，反刍行不再空转。
- 注入加固：带 `id`、`recentIds` 去重、`margin`、命中/被挡原因可观测；**注入不算回忆**（accessed_count 只在真检索时涨）。
- 每进程一个维护调度器（不再"托盘一份 + 应用一份"跑两遍）；启动预热 bank，注入块 800ms 预算。
- 会话孤儿对账 API（`orphanSessions` / `sessionInventory`）。

### 5. 桌面壳与托盘

- 托盘：记忆维护与控制台入口并入菜单，控制台默认落「记忆体」视图。
- 记忆栈根目录切到 `D:\castalia`（源码 / 运行时 / 库三者分离）。
- `scripts/start-airi.bat` 收敛启动逻辑，`启动AIRI.bat` 退役。
- 设置页不再重复造控制台：记忆页交接给 Full 总线，长期记忆归 castalia。
- 通道：桌面窗口自己认领 `chat-ingestion` 消费组；异步 runtime context provider 不再拖垮发送。

### 6. AMD NPU 本地语音识别

`packages/stage-ui/src/libs/providers/npu-whisper.ts`（+ 单测）：走本机 Lemonade / FLM 的 NPU ASR，语音不进云端。

## 二、代码在哪

```text
packages/castalia-plugin/
├─ src/vendor/engine/          # 引擎镜像 52 文件（生成物，禁止手改）
├─ src/vendor/sqlite-shim.ts   # better-sqlite3 → node:sqlite 适配
├─ src/                        # 插件胶水 11 文件：bank / memory / store / emotion / agent-state
└─ scripts/sync-engine.mjs     # 镜像同步脚本（幂等）
scripts/castalia_*.py          # 托盘 / 配置 / 设置 / 控制台壳（5 个，4,911 行）
packages/stage-ui/.../npu-whisper.ts
apps/stage-tamagotchi/src/renderer/main.ts
```

引擎真源不在本仓：[Castalia-Anima](https://github.com/ehwin/Castalia-Anima) 的 `src/`。改引擎在那边改、跑回归、再用 `sync-engine.mjs` 同步过来。

## 三、数据与运行时

```text
D:\castalia\memory-banks\<project>\<memType>\memory.sqlite   # 记忆库（general / user / project / feedback / reference）
D:\castalia\run\Castalia-Anima\dist                           # 独立 MCP 服务形态（酒馆 / 外部宿主）
D:\castalia\run\Castalia\scripts\castalia.config.json         # 托盘与实例配置（活的这份）
D:\system\AIRI\castalia\memory-banks → D:\castalia\memory-banks   # junction，兜旧 argv
D:\system\AIRI\castalia\run          → D:\castalia\run
```

## 四、构建与运行

```bash
pnpm install            # pnpm 11.24.0；postinstall 跑 simple-git-hooks + build:packages
pnpm build:packages     # 引擎镜像随插件一起编译
pnpm dev:tamagotchi     # 开发态桌面端
pnpm build:tamagotchi   # 出包
node node_modules/vitest/vitest.mjs run --root packages/castalia-plugin   # 不开 GUI 验插件
```

## 五、引擎镜像同步（唯一正确改法）

```bash
node packages/castalia-plugin/scripts/sync-engine.mjs                  # 默认源 D:/AI/castalia/Castalia-Anima/src
node packages/castalia-plugin/scripts/sync-engine.mjs --engine <src>
```

1. 复制 `src/*.ts`（跳过 MCP 入口 `index.ts` / `fedServer.ts`）+ 子目录 `federation/`；
2. `better-sqlite3` / `sqlite-vec` → `vendor/sqlite-shim`（子目录多上跳一层）；
3. 加 NOTICE 头 + `@ts-nocheck`，把类型导入拆成 `import type`（AIRI 开了 `verbatimModuleSyntax`）；
4. 先读源再清目标（源路径失效时绝不先删——踩过 38 个文件被清空的坑）。

同步完必须：插件 `tsc --noEmit` + `vitest`。

## 六、完整性实测（2026-10-31）

| 项 | 结果 |
|---|---|
| workspace | 71 个包，包名无重复 |
| `workspace:` 依赖 | 0 处未解析（`catalog:` 的 `@proj-airi/*` 是 npm 外部包） |
| 引擎镜像 import 图 | 0 断链 |
| 引擎内原生依赖残留 | 0（全部走 shim） |
| 插件引用引擎导出 | 0 缺失 |
| `pnpm-lock.yaml` | 1.26 MB，覆盖全部工作区 |
| 插件 typecheck | `tsc --noEmit` 0 error |
| 插件单测 | 7 files / 30 tests 全过 |
| `castalia` junction | `memory-banks` / `run` 均可达 |

## 七、已知限制

- `vendor/engine` 过不了本仓 eslint（`@ts-nocheck`、`node:process`、`.js` 后缀导入）：同步类提交一律 `--no-verify`，质量门是上游 tsc + 本包 vitest，别在这逐条改 lint。
- 引擎以 `@ts-nocheck` 镜像，插件内类型安全靠上游 tsconfig；本仓 tsc 只兜插件自己的代码。
- 引擎 → 插件的接口是机械映射，无语义校验：上游删/改导出时，`tsc` + 30 个单测是第一道也是唯一一道闸。
- NPU ASR 依赖本机 Lemonade / FLM；没装就是该 provider 不可用。
- 记忆链行为边界（abstain 不推进状态、日记不回流、facts 来源硬校验）由 Castalia-Anima 侧回归担保，本仓不重复实现。

## 八、上游与致谢

- 上游：[Project AIRI](https://github.com/moeru-ai/airi)（Moeru AI），AGPL-3.0-or-later，英文原文见 [docs/README.upstream.md](docs/README.upstream.md)；
- 记忆引擎：[Castalia-Anima](https://github.com/ehwin/Castalia-Anima) / [Castalia](https://github.com/ehwin/Castalia) / [Castalia-Full](https://github.com/ehwin/Castalia-Full)；
- 第三方声明见各包目录下的 `THIRD-PARTY-NOTICES.md`。

本 fork 的所有改动同样以 **AGPL-3.0-or-later** 发布。
