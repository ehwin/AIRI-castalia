# AIRI · Castalia 记忆体升级版

**一句话简介**：给 Project AIRI 装上长期记忆 + 情绪回路 —— 把 Castalia 引擎直接搬进 AIRI 主进程，让角色记得住、会淡忘、有短期情绪状态，且不靠子进程、无需编译 C++ 原生模块。

上游原版 AIRI 是“会说话的虚拟角色”，但对话只停留在上下文窗口里，关掉软件就忘。本仓库将记忆系统拆解为三条互不越界的物理链路——**证据链、情感链、派生链**——直接运行在 Electron 主进程内，通过 SQLite 本地落盘，实现零子进程开销、零存储 API 成本。

## 直接使用

| 想做的事 | 去哪 |
| --- | --- |
| 装上跑起来 | [Releases](https://github.com/ehwin/AIRI-castalia/releases) → `AIRI-Castalia-<版本>-windows-x64-setup.exe`，步骤见 [docs/install.md](docs/install.md) |
| 搞懂她什么时候会自己开口 | [docs/behavior.md](docs/behavior.md) |
| 从源码构建 | 见文末「构建与开发」 |

> 当前的 Windows 安装包用**自签名证书**，SmartScreen 会提示“未知发布者”。校验 SHA-256 或按 [docs/install.md](docs/install.md) 第 2 节信任本机证书即可。

* **版本基线**：基于上游 `v0.13.1`（`pnpm@11.24.0`），本仓在此基础上新增 104 个提交
* **核心改动规模**：涉及 201 个文件，`+26,574 / -21` 行代码
  * 引擎镜像：52 个文件（15,639 行）
  * 插件胶水层：11 个文件（613 行）
  * 系统托盘脚本：5 个文件（4,911 行）
  * 本地 NPU 语音识别（ASR）：195 + 37 行
* **质量实测**：插件 `tsc --noEmit` 0 报错、Vitest 7 个测试文件 / 30 项单测全过、引擎镜像 0 断链 / 0 原生依赖残留
* **开源许可**：`AGPL-3.0-or-later`（沿用上游）；上游原始说明文档归档于 `docs/README.upstream.md`

---

## 一、 核心升级内容

### 1. 记忆引擎改为“进程内运行”（最大的结构性改动）

Castalia 原本是独立的 `stdio` MCP 子进程（SillyTavern 酒馆与外部宿主依然走该模式）。本仓将其直接镜像整合进插件，跑在 Electron 主进程内：

| 维度 | 传统子进程 MCP 形态 | 本仓（主进程内嵌形态） |
| :--- | :--- | :--- |
| **启动方式** | 每次连接需 `spawn` 一个独立 Node 子进程 | 随桌面应用直接启动，零 `spawn` 开销 |
| **原生依赖** | 依赖 `better-sqlite3` + `sqlite-vec`，需按 Node ABI 编译，升级 Node 必重装 | 通过 `vendor/sqlite-shim` 映射至内置 `node:sqlite`，彻底告别原生模块编译 |
| **崩溃域** | 子进程静默挂死时，宿主往往无感知 | 同进程运行，异常可直接被宿主捕获与观测 |
| **底层数据** | 读写同一批 `memory.sqlite` | 读写同一批库、共用同一套读写路径 |

> **工程折中**：引擎源码以 `@ts-nocheck` 镜像引入，其内部类型安全由上游独立仓库的 `tsconfig` 担保（详见「已知限制」）。

### 2. 情感与短期状态：从“每轮问模型”改为“确定性状态机”

| 能力维度 | 上游原版 | 本仓升级版 |
| :--- | :--- | :--- |
| **情绪记忆** | 无 | 写入即标注 VAD（`vad_valence` / `arousal` / `dominance` + `emotional_impact`）；模型不可用时自动回落本地情感词表，无情感词绝不凭空捏造情绪 |
| **短期状态** | 无 | `psyche_state` 状态机：基线回归 + 半衰期指数衰减（`v=24h` / `a=4h` / `d=36h`）+ 有界误差步 + 滞回死区；模型只提候选信号，代码纯函数负责状态转移 |
| **事件幂等** | — | `eventId` 去重（128 条滑动窗口）、旧时间戳防回拨、SQLite `BEGIN IMMEDIATE` 事务内完成“读—转移—写”闭环 |
| **无可靠证据** | — | 显式记录 `abstain`（弃权），不写 `neutral`、不推进状态；`neutral` 仅代表“有确切证据且情绪接近零” |
| **状态注入** | — | `context_get` 同时返回 JSON 数据块与人类可读状态块；有确切证据时，`psyche` 是唯一的情绪所有者（affect owner） |

### 3. 自循环与日记：派生记录严禁回流充当事实证据

角色可以自己写反思日记，但日记绝不能在下一次检索中被当成“用户说过的事实”：

```text
【证据链】
conversation_log（客观证据，存 general 库）
  -> VAD 队列（仅接收 active 的 conversation_log）
  -> psyche_state（短期动力学状态，非 memory）
  -> 上下文注入 / 检索重排 / 生成回复

【派生链】
conversation_log + psyche_state
  -> self_cycle（持久游标 (created_at, rowid) + claim 抢锁 + evidence_key 幂等）
  -> agent_diary（存 project 库；附带 evidence_ids / state_version / generated_by；不跑 embedding、不进 VAD 队列）

【物理隔离面】
常规检索 / 上下文注入 / 反思 / 整合 / 事实来源 / 实体图谱 —— 默认全部排除 agent_diary 与 agent_state
```

* **自循环定时器默认关闭**（`SELF_CYCLE_INTERVAL_MINUTES=0`），需自动运行必须显式配置正整数。
* **崩溃自愈恢复**：claim 抢锁后若进程崩溃，1 小时后可自动回收过期锁；若日记已落库但 claim 未标记完成，下次运行按 `evidence_key` 直接补完状态，绝不重复生成日记。
* **防篡改保护**：派生记录对通用的 `memory_delete` / `restore` 接口保持不可变。

### 4. 记忆写入与召回接入真实对话主路径

* **自动落盘**：每轮对话结束自动写回记忆库，不再依赖外部脚本补录。
* **反刍闭环**：会话缓冲直接喂入临时反思链路，反刍行不再空转。
* **注入加固**：支持按 `id` 与 `recentIds` 去重、`margin` 阈值控制，命中与拦截原因全程可观测；上下文注入不计入回忆次数（`accessed_count` 仅在主动检索时递增，斩断正反馈死循环）。
* **单实例调度**：每个进程仅运行一个维护调度器（彻底解决以往“托盘跑一份 + 应用跑一份”的双重竞争）；启动时自动预热 memory bank，上下文注入块严格限制在 800ms 预算内。
* **孤儿会话对账**：新增会话盘点与孤儿对账 API（`orphanSessions` / `sessionInventory`）。

### 5. 桌面壳与系统托盘整合

* **托盘合一**：记忆维护与控制台入口并入系统托盘菜单，打开控制台默认落位「记忆体」视图。
* **目录解耦**：记忆栈根目录统一收敛至 `D:\castalia`（实现源码、运行时、数据库三者物理分离）。
* **启动脚本清理**：统一由 `scripts/start-airi.bat` 收敛启动逻辑，旧版 `启动AIRI.bat` 正式退役。
* **设置页减负**：不再重复造控制台轮子，记忆配置页交接给 Full 总线，长期记忆统一归口 castalia。
* **通道不阻塞**：桌面窗口独立认领 `chat-ingestion` 消费组；异步 runtime context provider 不再拖慢消息发送。

### 6. AMD NPU 本地语音识别（ASR）

新增 `packages/stage-ui/src/libs/providers/npu-whisper.ts`（含配套单测）：直接调用本机 Lemonade / FLM 的 AMD NPU 硬件加速接口，语音识别全程在本地完成，音频数据不进云端。

## 二、 核心代码目录地图

```text
packages/castalia-plugin/
├─ src/vendor/engine/          # 引擎镜像 52 个文件（脚本自动生成物，严禁手改！）
├─ src/vendor/sqlite-shim.ts   # better-sqlite3 → node:sqlite 无缝适配层
├─ src/                        # 插件胶水层 11 个文件：bank / memory / store / emotion / agent-state
└─ scripts/sync-engine.mjs     # 引擎镜像幂等同步脚本

scripts/castalia_*.py          # 托盘 / 配置 / 设置 / 控制台外壳（5 个脚本，共 4,911 行）
packages/stage-ui/.../npu-whisper.ts
apps/stage-tamagotchi/src/renderer/main.ts
```

**重要原则**：记忆引擎的唯一真源（Single Source of Truth）不在本仓库，而在 Castalia-Anima 的 `src/` 目录下。任何引擎逻辑修改必须在 Castalia-Anima 中完成并跑通回归测试，再通过 `sync-engine.mjs` 同步回本仓。

## 三、 数据与运行时路径

```text
D:\castalia\memory-banks\<project>\<memType>\memory.sqlite   # 核心记忆库（general / user / project / feedback / reference）
D:\castalia\run\Castalia-Anima\dist                          # 独立 MCP 服务形态（供 SillyTavern 酒馆 / 外部宿主调用）
D:\castalia\run\Castalia\scripts\castalia.config.json        # 托盘与实例全局配置（当前生效配置）
D:\system\AIRI\castalia\memory-banks → D:\castalia\memory-banks   # 目录软链接 (Junction)，兼容旧版启动参数
D:\system\AIRI\castalia\run          → D:\castalia\run
```

## 四、 构建与运行指南

```bash
# 1. 安装依赖（需 pnpm 11.24.0；postinstall 会自动运行 simple-git-hooks 与 build:packages）
pnpm install

# 2. 编译扩展包（引擎镜像随插件一起编译）
pnpm build:packages

# 3. 启动桌面端开发环境
pnpm dev:tamagotchi

# 4. 打包构建桌面端发行版
pnpm build:tamagotchi

# 5. 无头模式快速运行插件单测（无需启动 GUI）
node node_modules/vitest/vitest.mjs run --root packages/castalia-plugin
```

## 五、 引擎镜像同步（唯一正确的更新方式）

```bash
# 从默认真源目录（D:/AI/castalia/Castalia-Anima/src）同步
node packages/castalia-plugin/scripts/sync-engine.mjs

# 或指定自定义引擎源码路径
node packages/castalia-plugin/scripts/sync-engine.mjs --engine <src>
```

同步脚本内部自动执行的 4 个步骤：

1. 复制 `src/*.ts`（自动跳过 MCP 独立入口 `index.ts` / `fedServer.ts`）以及子目录 `federation/`；
2. 将 `better-sqlite3` / `sqlite-vec` 导入路径自动重写指向 `vendor/sqlite-shim`（子目录自动计算相对跳数）；
3. 自动注入 NOTICE 文件头与 `@ts-nocheck`，并将类型导入拆分为 `import type`（兼容 AIRI 开启的 `verbatimModuleSyntax`）；
4. 安全防删保护：先完整读取源目录并校验通过后，再清理目标目录（源路径失效时绝不先删目标文件——彻底杜绝曾踩过的“38 个文件被直接清空”的惨案）。

同步后必做检查：执行插件类型检查 `tsc --noEmit` 与 `vitest` 单测。

## 六、 工程完整性实测（2026-10-31）

| 检查项 | 实测结果 |
| :--- | :--- |
| Workspace 包结构 | 71 个子包，包名无冲突重复 |
| `workspace:` 依赖解析 | 0 处未解析（`catalog:` 中的 `@proj-airi/*` 均为正常 npm 外部包） |
| 引擎镜像 Import 图 | 0 断链 |
| 引擎内原生依赖残留 | 0 残留（100% 走 `sqlite-shim`） |
| 插件引用引擎导出 | 0 缺失 |
| `pnpm-lock.yaml` | 1.26 MB，完整覆盖全部工作区 |
| 插件 Typecheck | `tsc --noEmit` 0 Error |
| 插件单元测试 | 7 files / 30 tests 全部通过 |
| Castalia 目录软链接 | `memory-banks` / `run` 均正常可达 |

## 七、 已知限制与维护边界

* **跳过 ESLint 检查**：`vendor/engine` 镜像代码不走本仓 ESLint（因包含 `@ts-nocheck`、`node:process` 及 `.js` 后缀导入）；同步类 `git commit` 一律使用 `--no-verify`，代码质量门禁由上游 `tsc` + 本包 `vitest` 共同把关，切勿在本仓逐条手改 lint。
* **类型检查分工**：引擎镜像挂有 `@ts-nocheck`，其内部类型安全由上游 Castalia-Anima 的 `tsconfig` 保证；本仓 `tsc` 仅负责兜底插件胶水层自身的代码。
* **接口映射契约**：引擎到插件的接口为机械映射，无额外语义中间层；当上游删改导出函数时，`tsc` + 30 个 Vitest 单测是第一道也是唯一一道防线。
* **NPU 语音识别依赖**：本地 NPU ASR 依赖本机安装并运行 Lemonade / FLM 环境；未安装时该 Provider 自动降级为不可用。
* **核心不变量归属**：记忆链的核心行为边界（如 `abstain` 不推进状态、日记物理隔离不回流、`facts` 来源硬校验）全部由上游 Castalia-Anima 的 51+ 项回归测试担保，本仓不重复编写同类测试。

## 八、 上游与致谢

* **上游宿主项目**：Project AIRI（Moeru AI），采用 `AGPL-3.0-or-later` 许可，上游英文原版文档保留在 `docs/README.upstream.md`。
* **核心记忆引擎**：Castalia-Anima / Castalia / Castalia-Full。
* **第三方开源声明**：详见各子包目录下的 `THIRD-PARTY-NOTICES.md`。

本 Fork 仓库的所有新增与修改代码同样遵循 `AGPL-3.0-or-later` 协议发布。
