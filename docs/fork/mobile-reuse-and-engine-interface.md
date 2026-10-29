# 手机端复用与引擎接口（0.13.1 升级后实测）

写于 2026-10-29。第 2 节是**实测结果**（真的发过请求），第 4 节是仍然缺的东西。

## 1. 可复用矩阵

依据：`packages/*` 与 `apps/*` 共 60 个 workspace 包，按 `package.json` 的 electron 依赖筛；`core-agent`
按源文件逐个扫平台 API。

| 层 | 组件 | 复用 | 依据 |
|---|---|---|---|
| 大脑：人设 / 情绪 / 关系 / 危机 / 记忆策略 / 时间感 | `packages/core-agent`（103 源文件） | ✅ 纯 TS | 0 处 `node:fs` / `child_process` / `localStorage`；`window`、`document` 的命中全部在注释（"22 点到 7 点这个窗口""滚动窗口"） |
| 角色卡与人设数据 | `packages/ccc`、`packages/castalia-plugin` | ✅ 纯 schema / 数据 | 两端共享同一份卡，人设不分裂 |
| 记忆引擎 | `castalia/run/Castalia-Anima`（node 24 独立进程） | ✅ 作为 sidecar 服务 | 见第 2 节（MCP over HTTP 已实测） |
| 模型 / 供应商层 | `@xsai/*`、`packages/provider-inference` | ✅ 纯 TS HTTP | 换 `fetch` 即可 |
| UI 组件 | `packages/stage-ui`（Vue + Pinia） | ⚠️ 看形态 | Vue/Capacitor/PWA 近乎照搬；RN 或原生只复用 stores 逻辑，重写视图 |
| Live2D / VRM 渲染 | `stage-ui-live2d`、`stage-ui-three` | ⚠️ 换宿主 | 移动端用 pixi-live2d / three 重接；`.model3` / `.moc3` / VRM 资产通用 |
| 桌面壳 | Electron 主进程、托盘、自动更新、屏幕捕获 | ❌ 重写 | 依赖 electron 的 7 个包：`electron-eventa`、`electron-screen-capture`、`electron-vueuse`、`scenarios-stage-tamagotchi-electron`、`stage-ui`、`stage-tamagotchi`、`stage-tamagotchi-kirie` |
| AIRI 官方移动端那套 | `stage-pocket`(iOS/Android)、`packages/cloud-client`、`server`、auth | ⛔ 不用 | 账号 + 云同步 + 官方网关路线；本 fork 已删这三块 |

## 2. 引擎对外接口（实测）

**唯一的客户端入口是 MCP。** 引擎（`Castalia-Anima`）本身没有聊天 HTTP 接口：`/api/chat`、`/api/embed`
都是它**发出去**调 Ollama 的地址（`dist/emotion.js`、`dist/ollama.js`），不是它暴露的服务。
它自己只起一个可选健康检查：`HEALTH_PORT > 0` 时监听 `127.0.0.1:HEALTH_PORT`，`GET /health` →
`{ok, service, version}`，默认关闭且只绑 loopback。

对外的 HTTP 由 `mcp-proxy` 提供（`CastaliaNode.exe ... mcp-proxy.mjs --host 0.0.0.0 --port <port>`）：

```
POST http://<host>:3310/mcp
content-type: application/json
accept: application/json, text/event-stream
mcp-session-id: <initialize 响应头里给的>
```

实测序列（`POST /mcp`，JSON-RPC + SSE 回包）：

| 步骤 | 结果 |
|---|---|
| `initialize` | 200，`serverInfo {name: castalia, version: 1.25.4}`，协议 `2025-06-18`，响应头返回 `Mcp-Session-Id` |
| `notifications/initialized` | 202（不带 session 头会 400） |
| `tools/list` | 200，**32 个工具** |
| `tools/call stats_get` | `{ok: true, total: 213, vecCoverage: 1}` |
| `tools/call memory_index` | 真实记忆（id / memType / summary / updatedAt） |
| `tools/call memory_save` | `{ok: true, id: ...}`，随后 `memory_search` 能命中 |
| `tools/call memory_delete` | `{ok: true, deleted: true}`，sqlite 里该行 `is_active=0`（软删，行仍在） |

工具面（32 个，读写都有）：
`memory_search` `fact_search` `memory_save` `memory_delete` `memory_update` `memory_log` `auto_process`
`digest_run` `conversation_save` `context_get` `memory_context` `stats_get` `memory_list` `memory_get`
`events_ingest` `event_search` `memory_graph` `memory_recent` `memory_index` `recent_conversations`
`reflect_analyze` `reflect_apply` `reflect_auto` `reflect_deep` `reflect_batch_embed` `consolidate_deep`
`daily_summary_data` `project_list` `project_create` `instruction_save` `instruction_list` `instruction_delete`

### 端口 ↔ 记忆库（重要）

`castalia/run/Castalia/scripts/castalia.config.json` 的 `bridges` 段 + 托盘 `tray-status.json` 实测：

| 端口 | 桥 | 库 / 项目 | 绑定 |
|---|---|---|---|
| 3310 | lobehub-bridge | `memory-banks/lobehub/lobehub` | `0.0.0.0` |
| 3312 | shushu-bridge | `memory-banks/lobehub/shushu` | `0.0.0.0` |
| 3314 | federation-bridge | 联邦（`serverInfo.name = castalia-federation`） | `0.0.0.0` |
| 3316 | hermes-bridge | `memory-banks/hermes/hermes` | `0.0.0.0` |
| 3318 | dsh-bridge | `memory-banks/dsh/dsh` | `0.0.0.0` |
| 3344–3348 | 星图 / viz | — | `127.0.0.1` |
| 3398 | 托盘控制口 | — | `127.0.0.1` |

**`airi` 库没有桥。** AIRI 桌面应用不连桥，而是在自己的主进程里按
`%APPDATA%/@proj-airi/stage-tamagotchi/castalia-engine.json` 直接 spawn `Castalia-Anima`
（`engineEntry` / `bankDir` / `project` / `nodeBinary`），走 stdio MCP。手机端要连 `airi` 这个库，
得先给它加一条桥（照 `hermes-bridge` 抄，换 port / bank / project），或做成托盘按需启动。

实测留痕：probe 写进了 **3310 = lobehub 库**（`lobehub/lobehub/project/memory.sqlite`，`is_active=0`，
已软删）。连错端口就会写进别人的库，映射必须写死进客户端配置。

记忆库落盘：`castalia/memory-banks/<bank>/<project>/{general,feedback,project,reference,user}/memory.sqlite`，
表名 `memory`，软删 `is_active=0`。

## 3. 建议形态

**手机 = 纯客户端，大脑与记忆留在引擎。**

- 引擎跑在本机或一台常开的机器（树莓派/NUC 都行）
- 手机只做 UI + 麦克风/摄像头/通知，通过 MCP over HTTP 连引擎
- 人设与记忆只有一份真相源，换设备不迁移数据，桌面与手机是同一个"她"

## 4. 仍然缺的

1. **没有鉴权**：桥监听 `0.0.0.0`，同一局域网内任何人都能 `tools/call memory_save`。手机端上线前必须加
   token（`mcp-proxy` 支持 header 校验，或前面套反代）。
2. **没有 TLS**：明文 HTTP。
3. **`airi` 库没有桥**（见上）。
4. **`HEALTH_PORT` 只绑 loopback**，手机探活需要改为 `0.0.0.0` 或从外部探端口。
5. **记忆写入途径**：桌面靠 `hermes_memory_hook` 按会话日志注入；手机端直接调
   `memory_save` / `conversation_save` / `events_ingest`（已实测可用），不要再走 hook。

## 5. 不要做的事

- 不要把 `stage-pocket` 拉回来当手机端：它绑死官方账号与云同步
- 不要为手机端单独复制一份记忆库：那会让两个人格分叉
- 不要在引擎里引入常驻 LLM 进程：`reflect`/`triage` 是可选的，key 为空时自动跳过

## 6. 总线 vs 直连：实测对比（2026-10-29）

2026-10-29 把 3314 的 fedServer 重启到新配置后（此前它读的还是迁移前的 `D:\AI\castalia\...`），
同一批问句分别打总线与 Anima 直连：

| 问句 | Anima 直连（`memory_search`，情感+层级加权） | 总线（`memory_search_all(members:['airi'])`） |
|---|---|---|
| 你还记得我耳朵不太好使吗（语义改写） | 命中 5 条相关，score 1.19 | **0 条** |
| 漂泊者循着手镯（字面片段） | — | 2 条，但是**同一条重复两次** |
| 尤诺（字面） | — | 18 条 |
| 普罗米修斯（库里没有） | — | 0 条 |
| GPU 功耗（airi 无此内容） | — | 14 条，全是 hermes/dsh（作者的工作日志） |

结论：**总线对 airi 成员只有字面命中，没有语义召回**（它按 local-dir 直读 sqlite，不套 Anima 的
embedding + 情感/层级策略）。所以：

- 她的人设绑定与记忆召回 → 必须走 Anima（`MCP_TOOLS=store` 给 app，`agent` 给只读检索）
- 总线 → 只适合"知道关键词、跨库找原文"的管理/排查场景
- 总线跨库会把作者的工作记忆（hermes/dsh）混进她的上下文，人格场景要限定 `members:['airi']` 或干脆不用

## 7. 基本流程回归（0.13.1 升级后）

引擎侧（`CastaliaNode.exe scripts/<name>.mjs .`，注意参数是**仓库根**不是 bank）：

```
regression_anima_audit / cjk_recall / embed_dim / entities / facts / facts_bitemporal
/ facts_temporal / memory_injection / role_isolation / store_bridge / superseded_recall
/ v123_anima          -> 12/12 通过
eval_injection        -> 要点 13/14 = 93%，噪音 0/8，平均 3.7 条 / 584 字，重复 0
```

注入质量与升级前基线一致；`regression_store_bridge` 覆盖的正是 AIRI app 走的那 4 个 store 工具。
