# 手机（pocket）与桌面（tamagotchi）对话/记忆打通 — 现状报告

> 写于 2026-10-30，供新上下文接手。自包含，不依赖之前的对话。
> 目标形态是 **B**：桌面是唯一真相（人格/模型/记忆都在桌面），手机只做 UI 与本地副本。

---

## 0. 一句话结论

> **2026-10-30 13:40 更新**：下面第 1–7 节是当天的现场记录，仍然有效但有两处已被推翻——
> P1 已修复（桌面不再需要补注册脚本），P2 已定位并修复（不是"闪一下就没了"，是消息**从来没有发出去**）。
> 先读 **第 8 节**，它是当前状态；第 1–7 节保留作证据。

**协议层已全部打通并实测通过**（手机发 `input:text` → 桌面按 `binding` 处理 → 回复原样带回 `binding`）；
**卡在最后一环**：桌面窗口不会自动在服务端登记为 `chat-ingestion` 消费者，必须靠 CDP 脚本补一次注册才能工作。
**手机端还有一个未定位的问题**：用户点发送"闪了一下就没了"。

---

## 1. 环境事实（最容易踩的坑）

**本机有两份独立的 AIRI 代码库，不是同一个仓库：**

| 用途 | 路径 | 当前 HEAD |
|---|---|---|
| 桌面**实际运行**的副本 | `D:\system\AIRI` | `674ad3f85` |
| fork 源码（推 GitHub，APK 从这里出） | `D:\AI\AIRI\AIRI` | `035353f`（remote `mine` = `https://github.com/ehwin/AIRI-castalia.git`） |

- 改**桌面行为** → 改 `D:\system\AIRI`，在那里跑 `electron-vite build`，然后重启。
- 改 **APK** → 改 `D:\AI\AIRI\AIRI`，push 到 `mine/main`，CI 出包。
- **改错目录的表现是"改了没反应"**——本次排查在这上面浪费了大量时间。

其他：

- 桌面 channel server：`0.0.0.0:6121`（`hostname` 已从 `127.0.0.1` 改为 `0.0.0.0`）
- 配置文件：`C:\Users\1\AppData\Roaming\@proj-airi\stage-tamagotchi\server-channel-config.json`
  ```json
  {"authToken":"a922931e-...","hostname":"0.0.0.0","tlsConfig":null}
  ```
  备份在 `server-channel-config.json.bak-002919`
- 桌面日志：`C:\Users\1\AppData\Roaming\@proj-airi\stage-tamagotchi\logs\*.log`（主进程+server-runtime，**不含 renderer console**）
- 桌面带调试端口启动：
  ```
  cd /d/system/AIRI/apps/stage-tamagotchi
  node_modules/electron/dist/electron.exe . --remote-debugging-port=9444
  ```
- Tailscale：桌面 `100.79.165.94`，手机（rog-phone-9）`100.106.131.19`，手机到桌面 6121 实测可达（HTTP 404 = 有服务）。**局域网/P端 6122 曾被 Windows 防火墙拦，Tailscale 接口不受影响。**
- 手机包名 `ai.moeru.airi_pocket`，当前安装 versionCode **24**（`AIRI_VERSION_NAME=0.12.0`）

---

## 2. 已实现（代码 + 验证）

### 2.1 pocket 侧：把对话转发到桌面（双模式）

**文件**：`D:\AI\AIRI\AIRI\`

| 文件 | 改动 |
|---|---|
| `packages/stage-ui/src/stores/chat.ts` | 新增 `RemoteChatTransport { canSend(): boolean; send(payload) }` + `setRemoteChatTransport()`；`send()` 在 `remoteChatTransport?.canSend()` 时走远端，否则回落本地 `executeSend` |
| `apps/stage-pocket/src/modules/remote-chat.ts`（新） | 本地落用户消息 → 发 `input:text`（`overrides.binding = pocket:<sessionId>`）→ 等 `output:gen-ai:chat:complete` → 按 binding 写回本地 session；180s 超时；`canSend = () => channel.connected` |
| `apps/stage-pocket/src/App.vue` | `possibleEvents` 增加 `output:gen-ai:chat:message` / `output:gen-ai:chat:complete`；`installRemoteChat()` |
| `apps/stage-pocket/android/app-version.properties` | `AIRI_VERSION_CODE` 23 → 24 |

**设计要点**：

- `binding` 回传是协议保证的：
  ```ts
  // packages/plugin-protocol/src/types/events.ts:546
  interface OutputSource { 'gen-ai:chat': { input?: InputEventEnvelope, ... } }
  ```
  所以 `event.data['gen-ai:chat'].input.data.overrides.binding` 能拿到原始 binding，**不需要在手机侧维护 turn 映射表**。
- 只认 `complete` 结算，`message` 只用于更新累积文本（流式片段不落库）。
- **双模式**：连上桌面走远端，断开自动回落本地（`canSend()` 每次 send 都检查）。两条记忆线不合并。

**状态**：typecheck 通过、`vite build` 通过、已推 `035353f`、CI `40908231697` 成功、APK 已安装。

### 2.2 桌面侧：补 consumer 注册（**未真正生效**）

**文件**：`D:\system\AIRI\apps\stage-tamagotchi\src\renderer\App.vue`（`onMounted` 内，约 374 行）

```ts
if (windowContext.stageRuntime !== 'minimal') {
  const chatChannel = useModsServerChannelStore()
  void chatChannel.ensureConnected()
    .then(() => {
      for (const event of ['input:text', 'input:text:voice', 'input:voice']) {
        chatChannel.send({
          type: 'module:consumer:register',
          data: { event, mode: 'consumer-group', group: 'chat-ingestion' },
        } as never)
      }
      console.info('[AIRI] claimed chat-ingestion consumer group')
    })
    .catch(error => console.error('[AIRI] consumer registration failed:', error))
}
```

**注意**：`D:\system\AIRI` 的工作区是脏的（未提交），改动就在上面这个文件。`D:\AI\AIRI\AIRI` 里也有一份同类改动（`createFullStageRuntime` 内），**那份跑不到**（见下）。

---

## 3. 协议层验证证据（已通过）

探针 `D:\AI\AIRI\_secrets\probe_binding.mjs`：连 6121，发 `input:text` 带 `binding: probe:binding:<ts>`，监听 output。

**先跑 `cdp_register_consumer.mjs` 补注册，再跑探针**：

```
[connected] binding=probe:binding:1793329259157
[message]   binding=probe:binding:1793329259157  text=收到
[complete]  binding=probe:binding:1793329259157  text=收到
RESULT bindingEchoed=true
```

**结论：链路、认证、binding 回传、桌面回复全部正常。**

---

## 4. 未解决的问题（按优先级）

### P1 — 桌面不自动登记 consumer（必须靠脚本补）

**现象**：
- 桌面日志出现 `[warn] [server-runtime:websocket] no consumer registered for event delivery`，`input:text` 被**静默丢弃**（发送方收不到错误）。
- `input:text` 的投递模式在协议里写死是 `consumer-group`（`events.ts:1287`），服务端必须在该组挑一个消费者。

**根因链（已查清的部分）**：
1. `context-bridge.ts` 的 `initialize()` 里 `if (initialized) return` —— 第二次调用直接早退，不再注册。
2. 桌面 `App.vue` 的 `createFullStageRuntime()` 里虽然调用了 `contextBridgeStore.initialize()`，但**主窗口根本没走这条路**：
   ```ts
   // App.vue:356
   const fullStageRuntime = windowContext.stageRuntime === 'full' ? createFullStageRuntime() : null
   ```
   `windowContext.stageRuntime` 默认是 `'full'`（`window-context.ts`：`stageRuntime === 'minimal' ? 'minimal' : 'full'`），但实测主窗口里 `startupStore` 不存在（`D:\system\AIRI` 的 App.vue **没有** `useStartupResourcesStore`，与 fork 版本不同），说明两份代码版本差异较大，不能想当然套用。
3. 把注册移到 `onMounted`（无条件）后，**console 打印了** `[AIRI] claimed chat-ingestion consumer group`（CDP 重载页面捕获到 2 次），但探针仍超时；且 `no consumer registered` 警告**消失** → 说明注册成功但**服务端把消息派给了别的 peer**。
4. 加 `stageRuntime !== 'minimal'` 限制后重建重启，探针仍超时。

**当前唯一可用方案**（每次桌面启动后执行一次）：

```bash
node D:\AI\AIRI\_secrets\cdp_register_consumer.mjs
```

该脚本通过 CDP（9444）在主窗口里执行注册，返回 `{"sent":true,"connected":true}`。执行后再跑探针即通过。

**下一步建议**：在 `packages/server-runtime/src/index.ts` 的 `selectConsumer` 分支打印 `selectedConsumer` 的 `peerId/name`，看清楚消息被派给了谁（哪个窗口注册了 `chat-ingestion`）。需要改 `D:\system\AIRI` 并重建。

### P2 — 手机上"点了闪了一下就没了"

用户报告：点发送后界面闪一下、消息不见了。**未定位**。

已排除：
- app 没崩（`pidof` 有值，logcat 无 FATAL / AndroidRuntime / JS Uncaught）
- 桌面侧没有新的 `no consumer registered`

**待查方向**：
1. `remote-chat.ts` 的 `send()` 里 `commitUserMessage` 成功后，`chatChannel.send()` 是否真的发出（pocket 可能因为 `connected` 状态判断错误而没有真正发送）
2. `channel.connected` 在 pocket 里是不是 `ref`（`canSend: () => channel.connected` 依赖 pinia 解包；**已验证主窗口的 `channel.connected` 是 boolean**，但 pocket 侧未验证）
3. **pocket 自己也注册了 `chat-ingestion` 消费者**（它的 `contextBridgeStore.initialize()` 会注册）→ 可能与桌面抢消息，形成"pocket 收到自己的消息 → 转给桌面 → 桌面回 → 回到 pocket"的循环或吞掉
4. 消息可能落库了但 UI 没渲染（`storeMessage` 的 id 冲突 / session 未加载）

**可能的修法（未实施）**：pocket 装上远端通道后**主动注销**自己的 consumer：
```ts
channel.send({ type: 'module:consumer:unregister', data: { event: 'input:text', mode: 'consumer-group', group: 'chat-ingestion' } })
```

### P3 — 两处代码未提交

- `D:\system\AIRI` 工作区脏（`App.vue` + 其他历史改动），未提交。
- `D:\AI\AIRI\AIRI` 已提交并推送（`035353f`）。

---

## 5. 关键文件与命令速查

**探针/诊断脚本**（都在 `D:\AI\AIRI\_secrets\`）：

| 脚本 | 作用 |
|---|---|
| `probe_binding.mjs` | 发 `input:text` 验证回复与 binding 回传 |
| `cdp_register_consumer.mjs` | **补注册（当前必需）** |
| `cdp_all_windows.mjs` | 列出各窗口的 store / connected 状态 |
| `cdp_init_probe.mjs` | 在 renderer 里调 `initialize()` 并报告结果 |
| `cdp_reload_console.mjs` | 重载主窗口并抓 console（验证注册代码是否执行） |
| `cdp_bridge_state.mjs` | 查 channel / bridge store 状态 |

**跑法**（需要 Node 26 在 PATH）：

```bash
export PATH="/c/Users/1/AppData/Local/hermes/tools/node-26.12.1-win32-x64:$PATH"
cd /d/AI/AIRI/_secrets
node cdp_register_consumer.mjs
node probe_binding.mjs
```

**桌面重建**：

```bash
cd /d/system/AIRI/apps/stage-tamagotchi
export PATH="/c/Users/1/AppData/Local/hermes/tools/node-26.12.1-win32-x64:$PATH"
node ./node_modules/electron-vite/bin/electron-vite.js build   # ~48s，输出 out/bundle/
```
**构建期间不要并发跑第二个构建**——会把 `out/bundle/renderer` 删掉导致桌面起不来（已踩过一次）。

**APK 出包**：

```bash
export PATH="/c/Users/1/AppData/Local/hermes/tools/gh:$PATH"
cd /d/AI/AIRI/AIRI
gh workflow run release-pocket-android.yml -R ehwin/AIRI-castalia -f build_only=true
# 注意必须带 -R，否则 gh 默认指向上游 moeru-ai/airi 报 403
```

**手机侧**：

```bash
ADB="/c/Users/1/AppData/Local/MTK-Android/platform-tools/adb.exe"
"$ADB" reverse tcp:6121 tcp:6121
"$ADB" shell monkey -p ai.moeru.airi_pocket -c android.intent.category.LAUNCHER 1
```

---

## 6. 建议的接手顺序

1. **先跑 `cdp_register_consumer.mjs`**，确认探针能拿到 `bindingEchoed=true`（证明环境没坏）。
2. **查 P2**（手机闪一下就没了）：在 pocket 的 `remote-chat.ts` 里加 `console.info` 打点，用 `adb logcat | grep -i capacitor` 看 WebView console。这一步不需要出包就能定位（改完要出包才生效）。
3. **查 P1**：改 `server-runtime` 的 `selectConsumer` 打日志，看清楚消息派给了哪个 peer。这决定了是"pocket 抢消息"还是"注册没到"。
4. P1 修好后，把 `cdp_register_consumer.mjs` 的角色从"必须"降级为"诊断工具"。

---

## 7. 一个必须接受的产品事实

B 形态下**手机离线时桌面不可达**，双模式会回落到本地。两条记忆线**不合并**：
- 补**对话**可以（按 `binding` 回放消息）
- 补**记忆**不行——castalia 的条目带衰减、显著度、supersede 链、双时间轴，外部塞进去的条目在语义上是二等公民，且没有"导入已发生对话"的入口。

这符合你之前的判断（"最近的没有就算了，记忆体里有存"），但新上下文不应把它当成 bug 去修。

---

## 8. 接手记录（2026-10-30 12:xx）— P1 已修、P2 已定位并修

### 8.1 先纠正三个状态假设（第 1–7 节的前提有两处不成立）

| 假设 | 实际 |
|---|---|
| "桌面和手机都还在跑" | 接手时**桌面进程已经没了**（无 `electron.exe`、6121 无监听），手机在跑 |
| 手机没连上 6121 | 手机**是连着的**：`ss -tn \| grep 6121` 有 ESTAB（走 `adb reverse` 的 `127.0.0.1:6121`）。用 `/proc/net/tcp` 按十六进制端口（`17D9`）grep 会漏，**别用它下结论** |
| "用 adb logcat 抓 WebView console 就能定位 P2" | 走不通。release APK `run-as` 报 not debuggable，logcat 里没有任何 `chromium/CONSOLE` 行。要读手机内部状态必须出带 `webContentsDebuggingEnabled` 的包（8.4） |

### 8.2 P1 已修复：桌面不再需要补注册脚本

**根因不是"没注册"，是注册消息发在错的时机被 SDK 丢了**，外加组里有第二个消费者。

1. `packages/stage-ui/src/stores/mods/api/channel-server.ts` 里 `connected` 在 `module:authenticated` 就置 `true`，而 `@proj-airi/server-sdk` 要到 announce 完成（`status === 'ready'`）才真正接受 `send()`；`Client.send()` 返回 `false` 时 store 的 `send()` 不检查返回值 → **启动那一瞬的注册被静默丢弃**。这就是"console 打印了 claimed，但探针仍然超时"。
2. 组里还有第二个消费者：**手机（pocket）也注册 `chat-ingestion`**（`contextBridgeStore.initialize()` → `module:consumer:register`）。`selection:"first"` 按 `registeredAt` 挑 → 桌面即使注册成功也可能输给手机；而手机收到外来 `input:text` 后会**改写 binding 再转发一遍**（`ensureBoundSession(外来binding)` 建新本地会话 → `remote-chat` 用 `pocket:<新会话>` 重发），所以探针收到的是别人的 binding。

**修复（`D:\system\AIRI`，未提交）**

- `packages/stage-ui/src/stores/mods/api/channel-server.ts`：新增 `onReady()`（SDK ready 后触发）。不动 `connected` 的语义、不改 `onReconnected` 的既有测试契约（"仅重连时触发"）。
- `apps/stage-tamagotchi/src/renderer/App.vue`：注册改挂 `onReady`，并带 **`priority: 100`**；优先级高于注册时间，所以手机在组里也抢不过桌面。窗口已 ready 后挂载的情况补一次即时注册。

**证据**

- 修前（手机在组内，已跑补注册脚本）：`RESULT bindingEchoed=false`，收到 `binding=pocket:<session>`；服务端 `sending event to selected consumer { toPeer=<手机> }`，紧接着 `fromPeer=<手机> → toPeer=<桌面>` 是手机转发的那条；随后 `no consumer registered`（转发的消息没人接）。
- 修后（**冷启动** + 手机在组内 + **不跑任何脚本**）：`RESULT bindingEchoed=true`；renderer 重载后再次 `true`。
- 单变量对照：手机 `am force-stop` 后探针即 `true`，启动手机后旧包即被抢 —— 同一根因的两面。

### 8.3 P2 已定位并修复：不是"闪没"，是从来没发出去

**手机上点发送是彻底静默的 no-op**（文字留在框里、无气泡、桌面零事件、console 无错误）。

- `apps/stage-pocket/src/App.vue` 的 `loadStartup()` **从不调用 `chatStore.initialize(syncedPinia)`**（stage-web、stage-tamagotchi 都调）。于是 `chat-session` store 从未初始化：实测 `ready=null`、`index=null`、`activeSessionId=''`、`sessionMetas` 为空（IndexedDB 里的会话根本没加载，加载后是 9 个）。
- `apps/stage-pocket/src/modules/remote-chat.ts:98` 第一行：`if (!chatSession.sessionMetas[payload.sessionId]) throw new Error('This chat session is not ready yet')`。
- `packages/stage-ui/src/components/scenarios/chat/composables/use-chat-composer.ts:133` 捕获后返回 `'restored'`：**草稿原样回来，不打日志、不弹提示**；`chat.ts` 的 `appendSendError` 也因为会话未加载而早退（`chat.ts:1194`）。所以界面上什么都不发生。
- 用户说的"闪一下就没了"：**推断**（未逐帧验证）它和"没反应"是同一条路径的两种表现——有会话时 `appendSendError` 会先写一条 error 消息再被回滚/切走，看起来就是"亮一下又消失"。要证伪只需在下次出现时用 8.4 的 CDP 抓 `sessionMessages`。

**修复（fork，已提交 `8213e7c` + `83a06c0`，已推 `mine/main`）**

```ts
// apps/stage-pocket/src/App.vue
startup.register([... 'card', 'chat', 'services' ...])              // id 必须先在 register 里登记
await startup.run('chat', () => chatStore.initialize(syncedPinia))  // 在 card 之后、services 之前
```

坑：`startup.run(id)` 对未登记的 id 直接抛 `Unknown startup resource`，`loadStartup()` 的 catch 会吞掉它并**跳过后面所有步骤**（channel、remote transport、模型、音频全不初始化）。第一次提交漏了登记，装出来的包 `channel.connected=false` —— 别只看 `metaCount`，连不上通道就是这个症状。

**验证**

- 旧包 + CDP 运行时补 `session.initialize()`：`metaCount 0 → 9`、`activeSessionId` 有了；手机发 `pocket-ping-1`，桌面回"早上好呀！……"。
- 新包（CI 41007845763）冷启动：`chat-session.ready=true`、`metaCount=9`、`activeSessionId` 已选中，**无需任何注入**；点发送后草稿清空（`'restored'` 的反面）、桌面日志出现 `sending event to selected consumer`、手机界面出现用户句 + 三条桌面回复气泡。

### 8.4 现在可以自己看手机内部了（不用再让人当测试员）

- `apps/stage-pocket/capacitor.config.ts` 加了 `android.webContentsDebuggingEnabled: true`（**自用包**；对外分发前要删）。
- 用法：
  ```bash
  PID=$($ADB shell pidof ai.moeru.airi_pocket | tr -d '\r')
  $ADB forward tcp:9223 localabstract:webview_devtools_remote_$PID
  node D:\AI\AIRI\_secrets\pocket_cdp.mjs          # connected / chatReady / activeModel / draft / 发送按钮
  node D:\AI\AIRI\_secrets\pocket_send2.mjs        # 写值(绕开输入法) + 点发送 + 抓 console
  node D:\AI\AIRI\_secrets\pocket_session.mjs      # 会话 store 状态
  ```
- `D:\AI\AIRI\_secrets\pocket_verify_fix.mjs` 是"运行时补初始化 + 发一条"的端到端验证。
- 界面自动化别用肉眼估坐标：`python D:\AI\AIRI\_secrets\find_blobs.py <shot.png>` 按颜色找蓝色圆按钮。键盘弹出/收起时发送键 y 相差约 800px（1492 vs 2315），估错就会点空，然后误判成"点了没反应"。
- 输入法坑：`adb shell input text` 会被搜狗当拼音组合，`isComposing` 卡住时 `submit()` 直接 `return 'ignored'`。要往输入框塞文字就用 CDP 设 `textarea.value` + 派发 `input` 事件。

### 8.5 仍没做 / 建议下一步

1. **pocket 不该注册 `chat-ingestion`**：优先级只是让它抢不过桌面；桌面不在时它仍会吃掉 `input:text`、按外来 binding 新建本地会话（实测留下 4 个标题为"只回复两个字：收到"的垃圾会话）。彻底修法：pocket 装上远端通道后 `module:consumer:unregister` 那三个事件，或干脆不在 pocket 调 `contextBridgeStore.initialize()`。需要出包。
2. **`D:\system\AIRI` 的桌面改动未提交**（`App.vue`、`channel-server.ts`），工作区本来就是脏的。
3. 手机只落文本：`output:gen-ai:chat:message` 只用来更新累积文本，不落库，`complete` 才写会话。
4. 上一条报告里的 P3（两处未提交）仍然成立，另加本次的 `D:\system\AIRI` 两个文件。

### 8.6 新脚本（都在 `D:\AI\AIRI\_secrets\`）

| 脚本 | 作用 |
|---|---|
| `cdp_register_consumer_prio.mjs` | 按 `PRIORITY` 环境变量注册（验证优先级路由） |
| `cdp_watch_boot.mjs` | 重载主窗口并抓 console（看启动注册是否执行） |
| `cdp_peer_id.mjs` | 列窗口的 channel 状态 |
| `pocket_cdp.mjs` | 读手机 WebView 的 channel / chatReady / draft / 发送按钮 |
| `pocket_send.mjs` / `pocket_send2.mjs` | 手机端写值并点发送（抓 console） |
| `pocket_session.mjs` | 手机 `chat-session` store 状态与 `ensureCurrentSession` 探测 |
| `pocket_verify_fix.mjs` | 运行时补 `session.initialize()` 后发一条，端到端验证 |
| `find_blobs.py` | 截图里按颜色定位蓝色按钮 |

### 8.7 交接时的环境状态（2026-10-30 13:40）

- **桌面**：`D:\system\AIRI` 的构建（含 8.2 两处改动，未提交），以普通实例在跑，PID 由 6121 占用人给出，`--remote-debugging-port=9444`，stdout 在 `D:\AI\AIRI\_secrets\desktop-live.log`。**冷启动自动注册已经生效，不用再跑 `cdp_register_consumer.mjs`。**
- **手机**：`ai.moeru.airi_pocket` versionCode 24，装的是 CI 41007845763 的包（webview 可调试 + chat store 初始化）。`adb reverse tcp:6121` 在，devtools 转发按 8.4 重建（进程重启后 pid 变）。
- **桌面日志**：正常实例只写 `%APPDATA%\@proj-airi\stage-tamagotchi\logs\*.log`；要 `debug` 级别（看路由到哪个 peer）必须用 `LOG_LEVEL=debug` 重启。
- 遗留垃圾会话：手机会话列表里 4 个标题为"只回复两个字：收到"的会话是 8.5 第 1 条那段转发逻辑留下的，可以手动删。

