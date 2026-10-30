# AIRI · Castalia 整合分支

本仓是 [Project AIRI](https://github.com/moeru-ai/airi) 的个人 fork（`ehwin/AIRI-castalia`，分支 `upgrade/v0.13.1`），在**上游原样保留**的前提下，把 Castalia 记忆引擎以**进程内镜像**的形式接进 AIRI 主进程，并带一套 Windows 托盘 / 启动脚本与 AMD NPU 本地语音识别 provider。

上游 README（英文原文）在 [docs/README.upstream.md](docs/README.upstream.md)，其余语言版本见 `docs/README.*.md`。上游项目本身的介绍、社区与赞助信息以那些文件为准；本文只讲**这个 fork 相对上游改了什么、怎么跑、怎么维护**。

- 上游版本：AIRI **v0.13.1**（`package.json` `version`，`packageManager: pnpm@11.24.0`）
- 许可：**AGPL-3.0-or-later**（沿用上游；改动的文件同样受此约束）
- 运行形态：Electron 桌面端（`apps/stage-tamagotchi`）+ 进程内记忆引擎（`packages/castalia-plugin`）

---

## 1. 这个 fork 做了什么

| 改动 | 位置 | 说明 |
|---|---|---|
| **Castalia 记忆引擎镜像** | `packages/castalia-plugin/src/vendor/engine/` | 把 [Castalia-Anima](https://github.com/ehwin/Castalia-Anima) 的引擎源码镜像进插件，**52 个文件**。改 `better-sqlite3` → `vendor/sqlite-shim`（node:sqlite），因此不需要原生模块、不需要按 Node ABI 重编译、不起子进程 |
| **情感/状态链路** | 同上（`psycheState.ts` / `emotion.ts` / `selfCycle*.ts` / `memoryProvenance.ts`） | 证据链（conversation_log → VAD 队列 → psyche_state）、派生链（self_cycle → agent_diary）、隔离面（日记与状态快照默认不进检索/注入/反思） |
| **托盘与启动脚本** | `scripts/castalia_tray.py`、`castalia_config.py`、`castalia_settings.py`、`castalia_shell.py`、`start-airi.bat`、`sync_to_instances.py` | 记忆维护、控制台入口、按 `castalia.config.json` 解析路径；`启动AIRI.bat` 已退役并合并进 `start-airi.bat` |
| **NPU 语音识别** | `packages/stage-ui/src/libs/providers/npu-whisper.ts`（+ `.test.ts`） | 走 Lemonade / AMD NPU 的本地 ASR provider |
| **渲染层钩子** | `apps/stage-tamagotchi/src/renderer/main.ts` | 启动时接记忆引擎的初始化钩子 |

记忆引擎的**逻辑不在本仓手改**：上游真源是 `D:\AI\castalia\Castalia-Anima\src`，本仓的 `vendor/engine` 是生成物。改引擎要在 Castalia-Anima 那边改、跑回归、再同步过来。

## 2. 数据与运行时在哪

本仓只管代码；记忆数据与运行时实例在仓外：

```text
D:\castalia\memory-banks\<project>\<memType>\memory.sqlite   # 记忆库（general/user/project/feedback/reference）
D:\castalia\run\Castalia-Anima\dist                           # 独立 MCP 服务形态（酒馆 / 外部宿主用）
D:\castalia\run\Castalia\scripts\castalia.config.json         # 托盘与实例配置（活的这份）
D:\system\AIRI\castalia\memory-banks  → D:\castalia\memory-banks   # junction，兜旧 argv
D:\system\AIRI\castalia\run           → D:\castalia\run
```

AIRI 走的是**进程内**引擎（`packages/castalia-plugin`），与 `run\Castalia-Anima\dist` 那份 stdio MCP 服务**读同一批库、跑同一份源码**，只是宿主不同。

## 3. 构建与运行

```bash
pnpm install            # pnpm 11.24.0；postinstall 会跑 simple-git-hooks + build:packages
pnpm build:packages     # 先建 workspace 包（插件的 vendor 引擎是 .ts，随包编译）
pnpm dev:tamagotchi     # 开发态：Electron 桌面端
pnpm build:tamagotchi   # 出包：apps/stage-tamagotchi
```

- Node 用仓库外置运行时亦可（本机实测 `node v24.21.0` / 打包用 `D:\sillytavern\runtime\node\node.exe`）。
- 桌面端由 `scripts/start-airi.bat` 拉起，托盘脚本从 `scripts/castalia.config.json` 读实例与端口。
- 想在**不开 GUI** 的情况下验插件：`node node_modules/vitest/vitest.mjs run --root packages/castalia-plugin`。

## 4. 引擎镜像的同步方式

```bash
node packages/castalia-plugin/scripts/sync-engine.mjs                  # 默认源：D:/AI/castalia/Castalia-Anima/src
node packages/castalia-plugin/scripts/sync-engine.mjs --engine <src>   # 指定源
```

脚本做的事（幂等，重复跑结果一致）：

1. 复制 `src/*.ts`（跳过 MCP 入口 `index.ts` / `fedServer.ts`——插件不用），外加子目录 `federation/`（5 个文件）；
2. 把 `better-sqlite3` / `sqlite-vec` 导入改写成 `vendor/sqlite-shim`（子目录多上跳一层）；
3. 加 NOTICE 头 + `@ts-nocheck`，并把 `import { 类型 }` 拆成 `import type`（AIRI 开了 `verbatimModuleSyntax`）；
4. 先读源、再清目标目录（源路径失效时绝不先删，2026-10-29 踩过 38 个文件被清空的坑）。

**不要提交对 `vendor/engine` 的手改**——下一次同步会覆盖。同步完必须跑：插件 `tsc --noEmit` + `vitest`。

## 5. 完整性检查（2026-10-31 实测）

| 项 | 结果 |
|---|---|
| workspace 包 | 71 个，包名无重复 |
| `workspace:` 内部依赖 | 0 处未解析（`catalog:` 的 `@proj-airi/*` 是 npm 外部包，不参与工作区解析） |
| 引擎镜像 import 图 | **0 断链**（`federation/` 补齐后 `reflectAll.ts` 的 `./federation/index.js` 已可解析） |
| 引擎内原生依赖残留 | 0 处（`better-sqlite3` / `sqlite-vec` 全部走 shim） |
| 插件引用引擎导出 | 0 处缺失 |
| `pnpm-lock.yaml` | 1.26 MB，覆盖全部工作区 |
| `castalia-plugin` typecheck | `tsc --noEmit` **0 error** |
| `castalia-plugin` 单测 | **7 files / 30 tests 全过** |
| `D:\system\AIRI\castalia` junction | `memory-banks` / `run` 均可达 |

## 6. 已知限制

- `vendor/engine` 是镜像代码，**过不了本仓的 eslint**（`@ts-nocheck`、`node:process`、`.js` 后缀导入等都会报）。同步类提交一律 `git commit --no-verify`，质量门用上游 tsc + 本包 vitest，别在这里逐条改 lint。
- 引擎代码以 `@ts-nocheck` 镜像，插件内的类型安全靠**上游** tsconfig 保证；本仓 tsc 只兜插件自己的代码。
- 引擎 → 插件的接口靠 `sync-engine.mjs` 的机械映射，没有语义校验：上游删/改名导出时，`tsc --noEmit` 与 30 个单测是第一道也是目前唯一一道闸。
- NPU ASR 依赖本机 Lemonade / flm 运行时；没装就是 provider 不可用，不影响其它管线。
- 记忆链路的行为边界（abstain 不推进状态、日记不作为证据回流、facts 来源硬校验）由 Castalia-Anima 侧的回归脚本担保，不在本仓重复实现。

## 7. 许可与致谢

- 上游：[Project AIRI](https://github.com/moeru-ai/airi)（Moeru AI），AGPL-3.0-or-later；
- 记忆引擎：[Castalia-Anima](https://github.com/ehwin/Castalia-Anima) / [Castalia](https://github.com/ehwin/Castalia) / [Castalia-Full](https://github.com/ehwin/Castalia-Full)；
- 第三方声明见各包目录下的 `THIRD-PARTY-NOTICES.md`（如 `packages/castalia-plugin/`）。

本 fork 的所有改动同样以 **AGPL-3.0-or-later** 发布。
