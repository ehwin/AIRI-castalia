# QQ / IM 聊天端接入方案（评审稿）

> 状态：**仅报告，未改任何代码**。
> 依据：读 `D:\AI\AIRI\AIRI` 主干 + `D:\AI\castalia` 三仓（HEAD 见文末）。
> 所有"事实"标注了文件与行号；所有"未核实"单独列在第 10 节，不要当成结论用。

---

## 1. 结论摘要

1. **不需要引入 AstrBot 或任何第三方 bot 平台，也不需要新写 8 个 port。** AIRI 仓库里已经有 **IM 渠道接入的官方契约**：`integrations/discord-bot` 用 `@proj-airi/server-sdk` 的 `ServerChannel` 连主进程内置的 channel server（默认 6121），靠 `input:text` / `output:gen-ai:chat:message` + `binding` 做会话隔离。**照这个模式写一个 `onebot-bot`，约 300 行，不改 AIRI 一行源码**（证据见 2.5 / 第 11 节）。
2. **真正要你拍板的只有一个决定：QQ 走哪条协议通道。** 桥本身两条都能接，事件层归一化之后上层无感（见 4）。
3. **接入点必须是 `createChatOrchestratorRuntime`，不是 `runTurn`。** `turn-loop.ts` 的注释自己写明了它不是生产编排器（见 2.2），用它接 QQ 会丢掉流式、provider 轮次和上下文续写。
4. **AGPL 不是新增风险。** `packages/core-agent/package.json` 已是 `AGPL-3.0-or-later`，AIRI 整体也是 AGPL。自建 bridge 若 `import @proj-airi/core-agent`，bridge 自身也是 AGPL——**自用无义务，对外分发才要开源**。这跟你排斥 AstrBot 的理由同源，结论同样是"自用即可"。
5. 建议分三期：P0 文本单群闭环（1–2 天）→ P1 多会话/媒体（3–5 天）→ P2 双通道/可视化（1–2 周）。

---

## 2. 已核实：AIRI 侧现在有什么

### 2.1 生产编排入口（可直接注入）

`packages/core-agent/src/runtime/chat-orchestrator-runtime.ts:531`

```ts
export function createChatOrchestratorRuntime(deps: ChatOrchestratorRuntimeDeps): ChatOrchestratorRuntime
```

`ChatOrchestratorRuntimeDeps`（同文件 :321）全部是 port，没有任何 Electron / DOM / 磁盘假设：

| port | 作用 | 是否必需 |
|---|---|---|
| `session` | 会话持久化 + 代次守卫（`commitUserMessage` / `commitAssistantMessage` / `getSessionMessages` / `getSessionGeneration`） | 必需 |
| `context` | 上下文登记（`ingest` / `snapshot`） | 必需 |
| `foregroundStream` | 前台流式输出（UI 侧） | 必需 |
| `llm` | provider 无关的流式 LLM port | 必需 |
| `getActiveSessionId` / `getActiveProvider` | 当前会话与 provider | 必需 |
| `getSystemPrompt` | 按 sessionId 出人格/格式规则 | 可选 |
| **`runtimeContextProviders`** | **记忆召回的挂载点**，注释原文：*"A provider can answer late: a recalled memory block costs one round trip to the memory backend, and dropping it is worse than waiting for it."* | 可选，但**这就是 castalia 的接口位** |
| `onEffect` / `onSendSettled` / `onLlmFirstToken` … | 观测钩子 | 可选 |

**结论：QQ 桥要做的事，就是把这 8 个 port 在 Node 里各实现一份。** 不碰渲染进程，不碰 Electron 主进程。

### 2.2 `runTurn` 的定位（为什么不能用它）

`packages/core-agent/src/loop/turn-loop.ts:190` 上方注释原文：

> This loop is deliberately not a second orchestrator. `runtime/chat-orchestrator-runtime.ts` and `runtime/llm-service.ts` already run streaming turns with providers, rounds, and continuations. **This loop exists for one purpose: a provider-free turn with a hard round and tool budget, so it can be replayed and tested without a model.**

即：`runTurn` 是**离线和单测用的确定性执行器**。用它接 QQ，等于放弃流式、续写、provider 容错，还得自己补回 runtime 已经做好的事——是自找重复。

它唯一适用的场景：给 QQ 桥写**无模型的回放测试**（构造 `TurnDeps`，断言端口被正确调用）。这个价值很大，建议 P0 就写。

### 2.3 记忆侧现成的件

| 件 | 位置 | 用途 |
|---|---|---|
| `MemoryPort { recall, record }` | `loop/ports.ts` | 最小记忆契约，注释点名 "Castalia implements this" |
| `createCastaliaMemoryRepository(db)` | `packages/castalia-plugin/src/memory.ts:13` | 本地记忆仓库 |
| `AgentState` / `decayEmotion` / `aggregateMood` | `packages/castalia-plugin/src/{agent-state,emotion}.ts` | VAD 情绪与状态 |
| castalia MCP（35 工具三档） | `D:\castalia\run\Castalia\dist\index.js`（v1.25.4） | 长期记忆；`MCP_TOOLS=agent` 给 7 个只读工具 |
| 孤儿对账 | `Castalia-Anima@41bf56c`（软删 + 可恢复 + 默认 dry-run） | **撤回/回滚在 QQ 场景有对应物**，见 7.5 |

### 2.4 `server-runtime` 不适合当消息入口

`packages/server-runtime/src/`（h3 + `better-ws` + peer/extension 注册表）是为 **Airi 多端互联**（桌面 ↔ 浏览器 ↔ 移动端互相发现）设计的，模型是 peer/extension 握手，不是"给我一条用户消息"。**不建议**把它改造成 IM webhook 网关。

---

## 3. 三层结构，决定点只有一个

```
 [QQ 账号]
     │  (协议)
     ▼
 ① 协议端：NapCat / LLOneBot / SnowLuma        ← 唯一的现实选择点
     │  OneBot v11 (WS) 或 官方 Bot API (HTTPS)
     ▼
 ② 桥：qq-bridge（新建，~900 行，Node/TS）      ← 本次要写的全部代码
     │  8 个 port
     ▼
 ③ AIRI 编排：createChatOrchestratorRuntime
     │
     ├── castalia（MCP，长期记忆）
     └── provider（LLM）
```

①在社区里没有第二个答案（NapCat 系几乎垄断），②是我们唯一要写的新东西，③已经存在。

---

## 4. 通道选型（这是要你拍板的）

| | **A. OneBot v11（NapCat / LLOneBot / SnowLuma）** | **B. QQ 官方 Bot API** |
|---|---|---|
| 能力 | 全：群/私聊/媒体/撤回/管理/戳一戳 | 受限：官方群里偏"客服式"，主动发言与自由群聊弱 |
| 合规 | **灰色**，违反用户协议；本质是挂一个真实 QQ 号 | **合规**，2026-03 起个人可创建（单号 ≤5 个） |
| 部署 | 协议端必须 Docker / Linux；**Windows 直跑封号风险高** | 需要公网 HTTPS + webhook 回调 |
| 稳定性 | 依赖协议端跟进腾讯风控；2026-07 有过大规模反复踢线，社区有转 SnowLuma 的记录 | 官方 SLA |
| 接入形态 | WS 正向/反向，事件推送，`echo` 配对 action | Webhook 收事件 + HTTPS 发消息 |
| 适合 | 自用、小群、要媒体 | 长期、多人、公开、不想被封 |

**建议**：桥的 ②层做成 `transport/` 双实现，内部统一成 `InboundMessage` / `OutboundMessage`。**先做 A 打通能力上限，B 作为长期稳定通道并行加**，切换成本只在一个文件。

> 若你只要自用且能跑 Docker：A 是对的，别再犹豫。
> 若要给别人用或要在线率：B 是唯一安全解，代价是功能天花板低。

---

## 5. bridge 模块设计

建议独立包，**不要塞进 `apps/stage-tamagotchi`**（那是 Electron 壳）：

```
packages/qq-bridge/            (或独立仓 D:\AI\airi-qq-bridge)
├── src/
│   ├── index.ts               装配：配置 → transports → runtime → 启动
│   ├── transport/
│   │   ├── onebot.ts          WS 正/反向、事件解析、action 调用、echo 配对
│   │   └── official.ts        webhook 验签、回调、主动发消息
│   ├── ports/
│   │   ├── session.ts         sqlite（better-sqlite3）实现 4 个会话方法
│   │   ├── context.ts         ingest/snapshot，按 session 分桶
│   │   ├── llm.ts             走 xsai / OpenAI 兼容 HTTP
│   │   ├── foreground.ts      流式 token → 累积 → 分片发送
│   │   └── memory.ts          castalia：MCP client（stdio）或 runtimeContextProviders
│   ├── session-map.ts         (群/私聊/用户) → sessionId / characterId / castalia project
│   ├── rate-limit.ts          分片 + 队列 + 令牌桶 + 退避
│   ├── persona.ts             按群/人加载人格（getSystemPrompt）
│   └── media.ts               TTS 出语音、图片下载/转存（P2）
├── test/
│   └── replay.test.ts         用 runTurn 做无模型回放
└── package.json
```

### 数据流（P0）

```
OneBot message event
  → 归一化 { channel, peerId, userId, text, messageId, isAtMe }
  → session-map 解析（群 → 一个 session；@ 才触发）
  → runtime.send({ text, source:'text' })
      → runtimeContextProviders → castalia memory_search
      → llm 流式
      → foregroundStream 累积
  → 分片 → send_group_msg（队列限速）
  → 完成后 castalia record / memory_save
```

要点：**`onLlmFirstToken` 之后不要边收边发**。QQ 没有编辑消息能力，流式只能"攒完再发"，否则会刷屏。流式只用于内部取消和超时判断。

---

## 6. 8 个 port 的落地方式

| port | 实现 | 工作量 | 备注 |
|---|---|---|---|
| `session` | better-sqlite3，`messages(session_id, id, role, content, created_at)` | ~100 行 | `getSessionGeneration` 用 session 行上的自增列 |
| `context` | 内存 Map<sessionId, ContextMessage[]> | ~120 行 | 无需持久化；重启丢失可接受 |
| `foregroundStream` | 累积 buffer + 完成回调 | ~40 行 | 不做增量推送 |
| `llm` | OpenAI 兼容 `/chat/completions`（stream） | ~80 行 | 复用 AIRI 现有的 provider 配置读取逻辑 |
| `getActiveSessionId` | 由当前处理的消息决定 | ~10 行 | 单线程串行消费队列 |
| `getSystemPrompt` | persona.ts：群设定 + 角色卡 | ~60 行 | 与桌面端同一份人设来源 |
| `runtimeContextProviders` | 调 castalia `memory_search`，格式化成 `ContextMessage` | ~80 行 | **注意 memory_search 返回被截断的问题，走 `memory_get` 补齐** |
| `tools` | P0 不接；P1 再加（castalia harness 组） | — | 工具面暴露给 IM 机器人要单独评审 |

合计 ≈ 480 行 port + 250 行 transport + 150 行装配 ≈ **880 行**。

---

## 7. 坑清单（按踩中概率排序）

1. **分片与速率**（几乎必踩）。QQ 单条长度有限，连续快速发言会触发风控。需要：队列 + 200–500ms 间隔 + 长文本按语义切分 + 429/风控码退避。
2. **会话隔离**（必踩）。群聊多人 → 若共用 session，A 的话会进 B 的上下文。需要明确：**群 = 一个 session、@ 才入上下文**；私聊 = 每人一个 session。
3. **身份映射**（必踩）。`castalia` 的 `project` 与 `character_id` 怎么分？建议 `group → project`、`qq号 → character_id`，否则群记忆会串到桌面角色身上。
4. **上下文膨胀**（大概率）。群聊刷屏很快打满 context。需要按轮数/字符窗口裁剪，而不是靠 provider 自己截断。
5. **撤回 = 你刚做的孤儿对账**（中等，但价值最高）。QQ 撤回消息有 `message_id`，正好是"会话被回滚"的真实信号——比桌面端重新生成更干净。建议在 P1 把它接上：撤回事件 → 找对应 `turnId` 的记忆 → `orphan` 软删。
6. **情绪状态分叉**（中等）。`AgentState`/VAD 目前存在 AIRI 本地（castalia-plugin 的 store），QQ 与桌面各跑一份会各衰各的。**要决定情绪是否跨端共享**——共享就要落库，不共享就要在文档里写清"两端不同人格状态"。
7. **不要保活**（设计红线）。协议端掉线就让它掉，交给 docker `restart: unless-stopped` / systemd `Restart=on-failure`，**不要写无限重连循环**——风控误判往往就是重连风暴打出来的。
8. **AGPL**。`import @proj-airi/core-agent` → bridge 是 AGPL 派生物。自用随便；**要分发给别人就得开源 bridge**。想绕开只有两条路：进程间调用桌面端（不是 import），或重写编排（不划算）。
9. **双实例写库**（中等）。桌面 AIRI 和 QQ 桥如果同时用同一个 castalia bank，注意 `sqlite` 的 WAL 并发与 `keys.enc`/`MEMORY_DB_DIR` 配置一致，否则会出现"桥读到旧库"。
10. **Windows 路径**。OneBot 的 `command`/`file://` 路径在 Windows 下要转义；`MEMORY_DB_DIR` 必须显式传，否则 castalia 会在 bridge 的 cwd 下新建一套空库（这个坑我在本机实测过）。

---

## 8. 分期

| 期 | 内容 | 出口标准 |
|---|---|---|
| **P0**（1–2 天） | OneBot 文本单群、@ 触发、固定人设、castalia 只读召回、分片限速、无模型回放测试 | 群里 @ 一句 → 10s 内回一段，且 `memory_search` 真的被调用（看日志） |
| **P1**（3–5 天） | 私聊/多群、身份映射、上下文裁剪、撤回 → 孤儿对账、写记忆（先 dry-run） | 撤回一条后对应记忆 `is_active=0` 且可恢复 |
| **P2**（1–2 周） | 语音（TTS → silk）、图片、官方 Bot API 双通道、简单面板 | 两条通道同一份人格/记忆 |

---

## 9. 不做什么（明确排除）

- ❌ 不引入 AstrBot / LangBot / Koishi 作为运行时。只把它们的**协议知识**当参考，不拉代码。
- ❌ 不把 bridge 打进 Electron 包（多一个 Python/Node 进程 + 打包体积 + 生命周期问题）。
- ❌ 不改 `server-runtime` 成 IM 网关（peer 模型不匹配，改动面远大于新写）。
- ❌ 不写保活/无限重连。
- ❌ 不让 bridge 绕过 castalia MCP 直连 sqlite 写入（双写会破坏你刚做的孤儿对账契约）。

---

## 10. 未核实项（不要当结论）

1. **NapCat / SnowLuma 当前版本的实际风控阈值与单条长度上限**——需实测，各家实现不一致。
2. **QQ 官方 Bot API 2026 年现状的群聊能力边界**——我只读到二手报道（"官方群里只能当客服"），未读官方文档原文。
3. **`ChatOrchestratorRuntimeDeps` 的完整字段语义**——我只精读了 :321–:400 与 `SessionPort`，未通读全部 474 行接口。
4. **是否已有第三方 AIRI IM 适配器**——未检索，若有可直接复用，省一半工作量。
5. **`castalia` 的 `memory_search` 在 MCP 文本返回上是否截断到 ~200 字符**（我在本机记忆里记过这个现象）——若成立，桥必须用 `memory_get` 补齐正文。

---

## 11. 复用复核：AIRI 自带的渠道接口（本节推翻第 5 节的部分设计）

### 11.1 找到了什么

`integrations/` 下有六个现成的接入件：

| 目录 | 走什么 | 能否复用到 QQ |
|---|---|---|
| `discord-bot` | **`@proj-airi/server-sdk` 的 `ServerChannel`**，连 AIRI 主进程 | ✅ **就是这个** |
| `satori-bot` | Satori 协议（Koishi 桥），自带 Mini-Core | ⚠️ 能接 QQ，但接的不是你的角色 |
| `telegram-bot` | 自建 LLM + 自建 DB，独立 agent | ❌ 与主进程无关 |
| `twitter-services`、`minecraft`、`vscode` | 其他用途 | ❌ |

**只有 `discord-bot` 走主进程。** 另两个"聊天软件接口"看起来像同一个东西，其实是各自独立的另一个 bot——这点必须在动手前分清，否则你会花一周接出一个"和桌面角色无关的第二个 AI"。

### 11.2 契约（`packages/plugin-protocol/src/types/events.ts`）

```ts
// :577 输入侧
export interface InputMessageOverrides {
  sessionId?: string
  /** Stable external scene identity. The host resolves it to a persistent persona session. */
  binding?: string
  messagePrefix?: string
}

// :599 输入事件
export interface WebSocketEventInputTextBase {
  text: string
  textRaw?: string
  overrides?: InputMessageOverrides
  contextUpdates?: InputContextUpdate[]
}

// :530 输入源联合（目前只有三个）
interface InputSource {
  'stage-web': boolean
  'stage-tamagotchi': boolean
  'discord': Discord
}

// :1084 输出事件——把输入源原样带回
type OutputGenAiChatMessageEvent = { message: AssistantMessage }
  & Partial<WithInputSource<'stage-web' | 'stage-tamagotchi' | 'discord'>>
  & Partial<WithOutputSource<'gen-ai:chat'>>
```

`binding` 的注释是全篇最重要的一句：**"host resolves it to a persistent persona session"** —— 会话隔离/持久化由主进程负责，桥只要给一个稳定字符串。

discord 用的是 `discord:channel:${channelId}`。**QQ 用 `qq:group:${groupId}` / `qq:c2c:${userId}`，字符串里自带回程路由，不需要新增 `InputSource` 字段，也不需要改 AIRI 任何一行代码。**

### 11.3 主机端已就绪

`apps/stage-tamagotchi/src/main/services/airi/channel-server/index.ts:78`

```ts
return env.SERVER_CHANNEL_PORT ? Number.parseInt(env.SERVER_CHANNEL_PORT) : 6121
```

桌面应用启动即监听 6121（可被 `SERVER_CHANNEL_PORT` 覆盖），设置界面里有对应的 Server Channel 面板（`renderer/stores/settings/server-channel.test.ts` 就在测它的 EADDRINUSE）。

### 11.4 `discord-bot/src/adapters/airi-adapter.ts` 可直接照抄的四个件

1. **连接**：`new ServerChannel({ name:'discord', possibleEvents:['input:text','input:text:voice','input:voice','module:configure','output:gen-ai:chat:message'], token, url })`
2. **收消息 → 注入**（`Events.MessageCreate`）：`@` 或私聊才触发，剥掉 `<@id>`，构造 `binding`，`send({ type:'input:text', data:{ text, textRaw, overrides:{ messagePrefix, binding } } })`
3. **收回复 → 发出**（`output:gen-ai:chat:message`）：取 `message.content`，**按 2000 字符切分（优先换行、其次空格）**——QQ 的长度上限更小，这个分片函数要改常量，但结构照搬
4. **热配置**（`module:configure`）：UI 下发 token/开关，带 `isReconnecting` 互斥

### 11.5 因此修正第 5 节的设计

| 原设计（自己实现） | 改为 |
|---|---|
| 8 个 port（session/context/llm/foreground/…）~480 行 | **全部删掉**，主进程已有 |
| `session-map.ts` | **删掉**，`binding` 字符串即路由 |
| `foreground.ts` 流式 | **删掉**，`output:gen-ai:chat:message` 直接给整段 |
| `memory.ts` 接 castalia | **删掉**，记忆在 AIRI 主进程里本来就接好了 |
| `persona.ts` | **删掉**，`getSystemPrompt` 在主进程 |
| 仍需保留 | `transport/onebot.ts`（WS/HTTP 编解码）、`rate-limit.ts`（QQ 独有）、`binding 路由表`、`media.ts`（P2） |

工作量从 ≈880 行降到 **≈280–320 行**，且不产生第二套编排。

### 11.6 剩下的真问题（复用解决不了的）

1. **`InputSource` 没有 qq 槽位**：不带 `source` 字段也能跑（`Partial`），但类型上无法强约束；要严谨就加一行联合类型——那是唯一需要碰 AIRI 源码的地方，且是纯类型。
2. **输出没有"@ 谁"的信息**：`AssistantMessage` 直接发到群里，群里多人时要知道回给谁，只能靠 `binding` 里的 group id，不支持 per-user 回复线程。
3. **`rate-limit.ts` 必须新写**：discord 的分片是"一次发完"，QQ 需要队列 + 间隔 + 风控退避，这是唯一不能抄的部分。
4. **`satori-bot` 不能直接拿来接 QQ**：它的 README 自己写着"core 是临时方案，将来要删，只保留 adapter 和 capabilities"。用它 = 接出第二个 agent，人格/记忆/情绪都跟桌面端不共享。要接 QQ 又不想写 OneBot，可以走"NapCat → Koishi `server-satori` → satori-bot"，但那是另一条产品线，不是"让 AIRI 角色说话"。

---

## 12. 自用场景（不进群、单人）

前提变了：不做群聊 → 砍掉 @ 触发、多会话隔离、防滥用、per-user 路由。**但风控限流不能砍**——平台风控针对账号行为，不区分你是一个人还是一群人。

### 12.1 先回答一个问题：你缺的是"IM"还是"手机能连"

AIRI 自带的东西：

| 件 | 位置 | 状态 |
|---|---|---|
| Android/iOS 客户端 | `apps/stage-pocket`（Capacitor） | 已有 |
| 扫码连桌面 | `src/pages/settings/connection/server-channel-qr-scanner.vue` + `modules/server-channel-qr-probe.ts`（`ServerChannelQrPayload`） | 已有 |
| 原生 WebSocket bridge | `apps/stage-pocket/src/modules/websocket-bridge.ts` + README 的 "WebSocket Bridge" 一节 | 已有 |
| 连接状态入口 | `src/components/websocket-status-button.vue` | 已有 |

即：**"在手机上用我的角色"这件事，AIRI 自己已经做完了，零代码。** 它连的就是同一个 6121，走同一套 `server-sdk`。

所以自用的正确排序是：

| 方案 | 代码量 | 出门可用 | 全功能（语音/渲染/情绪） | 代价 |
|---|---|---|---|---|
| **1. stage-pocket 扫码连桌面** | **0** | 仅同网/组网（Tailscale 等） | ✅ 全部 | 桌面必须常开 |
| **2. Discord DM** | **~0**（`isDM` 已实现） | ✅ 任意网络 | ⚠️ 只有文字（+语音频道） | 要注册 Discord 应用、需代理 |
| **3. Telegram 私聊** | ~150 行（ServerChannel 版） | ✅ | ⚠️ 文字/语音 | 需代理 |
| **4. QQ 官方 Bot API** | ~250 行 | ✅ | ⚠️ 文字为主 | 要注册开发者、审核 |
| **5. QQ + NapCat 私聊** | ~300 行 | ✅ | ✅ | **挂自己号，封号=号没了；要 Docker/Linux** |

**自用场景下第 5 条是最差的**：它把上面所有的能力优势，换成你主账号的存活风险，换来的是"在 QQ 里聊天"这个形式本身。

### 12.2 如果就是想在国内聊天软件里用

按代价排序：**QQ 官方 Bot API 私聊** > 微信客服/企微自建应用（自己给自己）> NapCat。
官方 Bot API 的私聊（C2C）是支持的，自用频率远低于群聊，不会触发频率限制；代价是注册与审核，不是钱。

### 12.3 自用必须关的三样（省钱包）

1. **`spark:notify` 主动发言**：`packages/core-agent/src/agents/spark-notify/` 是"生命舱主动触发"通道，会在他不在时也发起模型调用。自用要关掉，或至少把 `idleMs` 拉长（测试里用的是 `15 * 60_000`）。
2. **群聊自动回复**：不进群即天然关闭，但要确认没有任何"被 @ 就回"的默认路径。
3. **上下文无界增长**：自用时对话会很长，长上下文比多轮数更烧钱。按轮数裁剪，别靠 provider 自己截。

### 12.4 一个必须接受的事实

**无论哪条通道，AIRI 桌面必须开着。** adapter 是 client，不是第二大脑（`discord-bot` 的注释也这么说：连接的是 running character）。所谓"出门在外用"，真实形态是：**家里一台常开的机器跑 AIRI + 手机通过中转连上**。想省电关机，就没人接消息——这不是 bug，是架构。

---


## 13. 跨端会话/记忆同步（手机 ↔ 桌面，非串流）

### 13.1 先纠正一个前提：上游的跨端同步是**云端**实现的，已被删除

`packages/stage-ui/src/stores/chat/session-locality.ts` 的注释原文：

> Whether a session stays on this device. **Cloud chats** carry no task status and no scene bindings, so a hidden task session or a scene session never syncs. Otherwise **another device adopts** a scene as an owner conversation.

配套证据：

| 位置 | 内容 |
|---|---|
| `session-store.ts:756`（main 分支） | `Lookup local sessionId from a cloud chatId` |
| `session-store.ts:869`（main 分支） | `filter(meta => meta.userId === currentUserId && !staysLocal(meta))` |
| `server/apps/api/src/routes/*` | `character-cards`、`audio-speech-ws`、`apple-iap` 等成套服务端路由 |
| `packages/cloud-client/openapi.yaml` | 公告 / 站内信 / 钱包（运营面） |

**结论：跨端"另一台设备接管同一段会话"这件事，上游靠账号 + 云端 chatId 做的，而 `server/apps`（396 文件）与 `packages/cloud-client` 已经被 `033e236` 删掉。**

### 13.2 但同步的"积木"全都在，没有一起被删

| 积木 | 位置 | 作用 |
|---|---|---|
| `ChatSessionMeta` | `packages/stage-ui/src/types/chat-session.ts` | 已带 `userId` / `characterId` / `bindings[]` / `createdAt` / `updatedAt` —— 分区键 + 增量游标 + 场景身份，同步所需元数据一个不缺 |
| `staysLocal(meta)` | `stores/chat/session-locality.ts` | 明确哪些会话不该跨端（hidden / recipeId / bindings） |
| `mergeLoadedSessionMessages` | `core-agent/src/session/merge-loaded-session-messages.ts`（已从 `@proj-airi/core-agent` 导出） | 指纹去重合并（id + role + createdAt + content） |
| `chat-sessions.repo.ts` | `packages/stage-ui/src/database/repos/` | 会话仓储层，读写已抽象 |

**要做的不是"从零做跨端"，是把已删的 HTTP 传输换成自建的本地传输。** 语义层（谁该同步、怎么合并）上游已经写好了，缺的只有搬数据的管子。

### 13.3 三个可选形状

| | 形态 | 改什么 | 工作量 | 代价 |
|---|---|---|---|---|
| **A** | **桌面当唯一真相，事件同步** | `plugin-protocol` 加 2 个事件；`server-runtime` 加 handler；pocket 加 client | **~500 行 / 2–3 天** | 桌面必须开着 |
| B | 恢复上游云端 | 捞回 `server/apps/api` + `cloud-client` + auth | 大，且要把删掉的账号体系请回来 | 与"删商业代码"的意图直接冲突 |
| C | castalia 加 HTTP transport，两端都当 MCP client | 改 `Castalia/src/index.ts`（现在只有 `StdioServerTransport`）+ pocket 内跑 MCP client | ~600 行，且手机要能跑 node | 记忆与对话统一到一份真相，最正统但最重 |

**推荐 A**：复用 6121 与 `server-sdk`（已验证可用），不引入账号体系、不需要公网、不需要在手机上跑 node；冲突合并直接调现成的 `mergeLoadedSessionMessages`。

### 13.4 A 的具体设计

新增两个事件（`packages/plugin-protocol/src/types/events.ts`）：

```ts
'session:sync:pull' // { since: number }  → { sessions, messages, cursor }
'session:sync:push' // { sessions, messages } → 桌面落库，返回 accepted ids
```

- **方向**：pocket 连上先 `pull({ since: lastCursor })`，本地 `mergeLoadedSessionMessages(local, incoming)`；本地新会话再 `push` 回桌面。
- **游标**：用 `ChatSessionMeta.updatedAt` 的全局最大值，暂不建额外表。
- **分区**：`userId` 一致才合并；`staysLocal(meta)` 为真的（hidden/recipe/场景绑定）不下发——复用现成判断，不自己发明规则。
- **记忆不复制，走代理**：手机不跑 castalia（引擎是桌面二进制），发 `memory:recall` / `memory:record` 事件，桌面转给 castalia。两端看到的是**同一个库**，不是两份会分叉的副本。

### 13.5 为什么不做"记忆双向同步"

castalia 的库是 `<bank>/<project>/{general,feedback,...}/memory.sqlite`，带 `sqlite-vec` 向量索引、`supersede` 链、`is_active` 软删、反射账本。把这份东西在两端各存一份再由客户端合并，几乎必然破坏 `supersede` 链与向量索引的一致性——那不是同步，是制造两个真相。代理调用没有这个问题。

### 13.6 风险与边界

1. **桌面必须在线**：pull/push 只在连接期间有效；托管进程，不写保活。
2. **实时性**：A 是拉取式；要"桌面说了话手机立刻看到"，再推一个 `session:changed` 通知（+20 行）。
3. **冲突**：`mergeLoadedSessionMessages` 能合并"不同消息"，但**同一消息被两端改写**它不处理。单人自用可接受，写进文档。
4. **不碰上游语义**：`staysLocal`、`userId` 分区、`bindings` 全部沿用，将来上游改了也不用重写。

---

## 附：核对的 HEAD

| 仓 | HEAD | 说明 |
|---|---|---|
| `D:\AI\AIRI\AIRI` | `033e236`（`local/mind-p0`） | 上游 `main` = `d6e8fe5`；fork delta 25 commits / 1207 files |
| `D:\AI\castalia\Castalia` | `502d831` | v1.25.4 Lite |
| `D:\AI\castalia\Castalia-Anima` | `41bf56c` | 孤儿对账已就位 |
| `D:\AI\castalia\Castalia-Full` | `7800ab5` | 聚合检索在 `web/routes/aggregate.js`，不在引擎 |
