# 手机端复用与引擎接口（留档，未验证项已标注）

写于 0.13.1 升级之后。用途：将来要把"她"扩散到手机时，从这份清单接着做，不必重新摸一遍。
**标注「待验证」的条目只是从代码里读出来的线索，没有实际连过。**

## 1. 可复用矩阵

依据：`packages/*` 与 `apps/*` 共 60 个 workspace 包，按 `package.json` 的 electron 依赖筛；`core-agent`
按源文件逐个扫平台 API。

| 层 | 组件 | 复用 | 依据 |
|---|---|---|---|
| 大脑：人设 / 情绪 / 关系 / 危机 / 记忆策略 / 时间感 | `packages/core-agent`（103 源文件） | ✅ 纯 TS | 0 处 `node:fs` / `child_process` / `localStorage`；`window`、`document` 的命中全部在注释（"22 点到 7 点这个窗口""滚动窗口"） |
| 角色卡与人设数据 | `packages/ccc`、`packages/castalia-plugin` | ✅ 纯 schema / 数据 | 两端共享同一份卡，人设不分裂 |
| 记忆引擎 | `castalia/run/Castalia-Anima`（node 24 独立进程） | ✅ 作为 sidecar 服务 | 见第 2 节 |
| 模型 / 供应商层 | `@xsai/*`、`packages/provider-inference` | ✅ 纯 TS HTTP | 换 `fetch` 即可 |
| UI 组件 | `packages/stage-ui`（Vue + Pinia） | ⚠️ 看形态 | Vue/Capacitor/PWA 近乎照搬；RN 或原生只复用 stores 逻辑，重写视图 |
| Live2D / VRM 渲染 | `stage-ui-live2d`、`stage-ui-three` | ⚠️ 换宿主 | 移动端用 pixi-live2d / three 重接；`.model3` / `.moc3` / VRM 资产通用 |
| 桌面壳 | Electron 主进程、托盘、自动更新、屏幕捕获 | ❌ 重写 | 依赖 electron 的 7 个包：`electron-eventa`、`electron-screen-capture`、`electron-vueuse`、`scenarios-stage-tamagotchi-electron`、`stage-ui`、`stage-tamagotchi`、`stage-tamagotchi-kirie` |
| AIRI 官方移动端那套 | `stage-pocket`(iOS/Android)、`packages/cloud-client`、`server`、auth | ⛔ 不用 | 账号 + 云同步 + 官方网关路线；本 fork 已删这三块，手机端不必背 |

## 2. 引擎对外接口（现状）

- 进程：`castalia/run/Castalia-Anima/dist/index.js`，由 `CastaliaNode.exe` 拉起（ABI 137 / node 24）
- 桥：端口 `3310 / 3312 / 3314 / 3316 / 3318`（每个 bank 一路），星图 `3344`（+3345/3346）
- 端口与 bank 的对应写在 `castalia/run/Castalia/scripts/castalia.config.json`
- HTTP：`/api/chat` 存在，且同一份 dist 里出现 `chat/completions` → **待验证**：它是否 OpenAI 兼容（`POST /v1/chat/completions` 形态、是否需要 `model` 字段）
- MCP：Hermes 侧通过 stdio 用；仓库里另有 `mcp-proxy` 相关脚本 → **待验证**：是否有 HTTP/SSE 传输，还是只能 stdio
- 绑定：桥监听 `127.0.0.1`。手机要连必须开 LAN + token 鉴权（现在**没有**鉴权）
- 记忆库落盘：`castalia/memory-banks/<bank>/<project>/{general,feedback,project,reference,user}/memory.sqlite`，
  表名 `memory`，软删 `is_active=0`

## 3. 建议形态

**手机 = 纯客户端，大脑与记忆留在引擎。**

- 引擎跑在本机或一台常开的机器（树莓派/NUC 都行）
- 手机只做 UI + 麦克风/摄像头/通知，通过 WS/HTTP 连引擎
- 人设与记忆只有一份真相源，换设备不迁移数据，桌面与手机是同一个"她"

## 4. 接手前要验的三件事

1. `POST /api/chat` 的真实请求/响应形状（是否 OpenAI 兼容、流式用什么协议）
2. MCP 是否有非 stdio 传输；没有的话手机端得自己包一层 HTTP 工具网关
3. 记忆写入路径：现在按桌面会话日志经 hook 注入（`hermes_memory_hook`）。非桌面客户端要写记忆，
   需要走引擎自己的写入接口（`memory_save` 一类），要确认它对任意调用方是否开放

## 5. 不要做的事

- 不要把 `stage-pocket` 拉回来当手机端：它绑死官方账号与云同步
- 不要为手机端单独复制一份记忆库：那会让两个人格分叉
- 不要在引擎里引入常驻 LLM 进程：现在 `reflect`/`triage` 是可选的，key 为空时自动跳过
