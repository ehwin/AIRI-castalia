# 手机当舞台、电脑只当脑子（复用 MTK 架构）

状态：草案 / 待决策
日期：2026-11-04
范围：`apps/stage-pocket`（表现端）、`apps/stage-tamagotchi`（宿主）、`packages/plugin-protocol`（协议）、`packages/stage-ui`（编排与语音）

## 结论

复用 MTK 已经跑通的那套东西，比自建一套"舞台协议"便宜：

- **表现层整套在手机里跑，而不是从手机连回去画**。手机自己渲染 Live2D；电脑一个像素都不画、一声都不出。
- 电脑侧只多两件事：用 HTTP 把 `apps/stage-pocket/dist` 发出去；给 6121 补上 MTK 式连接码/设备令牌。
- 局域网与外网用 MTK 实测过的**双地址 + 先 LAN 后 Tailscale**，不新造一套。
- 副作用是最大的收益：**改 UI 不用重打 APK**——UI 在电脑侧，壳只负责装页面、给麦克风、保持常亮。

## MTK 可复用的四层（源码在 `D:\AI\MTK-source-2026-10-29\rebuild`）

| 层 | MTK 实现 | 为什么够用 |
| --- | --- | --- |
| 安卓壳 | `android/src/app/mtk/remote/*`（Launcher/Main/Settings/Dsh/StreamActivity + StreamPlugin）、`android/README.md` | 约 33 KB 薄壳：存多个地址 + 长期设备令牌，全屏 WebView 打开电脑页面，地址按顺序试（先 LAN 后 Tailscale），持久化 Cookie，屏幕常亮、返回菜单 |
| 网关与配对 | `mtk/remote.py` | 6 位连接码（去 0/O/1/I/L/5/S/8/B）→ HttpOnly 会话 Cookie 24 h，错 5 次锁 2 min，设备 Cookie 365 天；默认关闭，开才监听 `0.0.0.0`；代理本机 UI，不维护第二套 API |
| 双入口路由 | `tools/dsh_relay.py` | 按 `Host` 头选 LAN / Tailscale 的带令牌 URL 并 302，令牌轮换不必重打 APK |
| 托管与保活 | Castalia 托盘 `services.mtk-remote` | autoStart、60 s 探活、判据是"端口在听 **且** `/` 能应答"、起不来退避 120 s |

不复用 Moonlight/Axixi 串流（`app.mtk.stream`）：它把画面在电脑上编码再传，正好违背"Live2D 不要吃电脑性能"。
AIRI 跨端流量是文本 + 音频 + 低频情绪，量级几十 KB/s，不需要视频串流。

## 现状证据（AIRI 侧）

| 事实 | 位置 |
| --- | --- |
| 编排器在渲染进程（store，不是主进程服务） | `packages/stage-ui/src/stores/chat.ts` |
| 桌面把回复广播到通道 | `packages/stage-ui/src/stores/mods/api/context-bridge.ts:1034`、`:1053` |
| 桌面已认领三种输入（含语音） | `apps/stage-tamagotchi/src/renderer/App.vue:435` |
| 桌面自己也会主动开口 | `apps/stage-tamagotchi/src/renderer/App.vue:476`（`selfInitiatedSpeechStore.start()`） |
| 手机只订阅 UI 配置 + 两档回复 | `apps/stage-pocket/src/App.vue:107` |
| 手机把一轮发给桌面 | `apps/stage-pocket/src/modules/remote-chat.ts:92-140` |
| 手机自己也初始化编排器（双重主动性风险） | `apps/stage-pocket/src/App.vue:113` |
| TTS 合成后在同进程解码播放 | `packages/stage-ui/src/stores/voice.ts:94` |
| 口型来自"播放设备本地"的音频分析 | `packages/stage-ui/src/components/scenes/Stage.vue:485-541` |
| 字节通道协议存在但无生产者 | `packages/plugin-protocol/src/types/events.ts:1102-1120`；全树仅 `packages/server-sdk/src/client.ts:362` 与测试引用 |
| 协议里没有任何 stage/affect/speech 事件 | 事件全集见 `packages/plugin-protocol/src/types/events.ts` |
| 手机端已带渲染与合成能力 | `apps/stage-pocket/package.json`：`stage-ui-live2d`、`stage-ui-three`、`@xsai/generate-speech`、`unspeech` |
| 手机端已有宿主桥约定，不绑死 Capacitor | `apps/stage-pocket/src/modules/websocket-bridge.ts`（`window.AiriHostBridge` / `webkit.messageHandlers`） |
| 记忆在桌面主进程（已实测落库与召回） | `apps/stage-tamagotchi/src/main/services/airi/castalia-memory.ts`、`memory-banks/airi/airi/*` |

关键推论：口型不需要下发 viseme。`Stage.vue` 从**正在播放的那段音频**算开口量，音频在手机上播，口型就在手机上成立。

## 已验证（2026-11-04，真机 + 真后端）

把 `apps/stage-pocket/dist` 用 `VITE_AIRI_WS_URL=ws://192.168.10.18:6121/ws` 构建后从电脑用 HTTP 发出，
**手机自带浏览器（Edge 156）直接打开就能跑完整链路**：

| 验证 | 结果 |
| --- | --- |
| 纯 `http://192.168.10.18:6180/` 直接打开 | ❌ 停在"启动失败"：`TypeError: Cannot read properties of undefined (reading 'request')` in `tab-election.hasLeader` → `navigator.locks` 不存在 |
| 补 `navigator.locks` 后 | 仍失败：`crypto.randomUUID is not a function` → 启动链在 card 阶段中断，连通道都不初始化 |
| 再补 `crypto.randomUUID` + `window.AiriHostBridge`（原生 WebSocket 版） | ✅ `connected: true`，Live2D 渲染出来、对话可发 |
| 手机发一轮 | 3.2 s 由电脑回答"收到。"；电脑 `chat-session` 出现 `pocket:WvfMKelrx_WoMF_YzPi-Z`（2 条消息） |
| 记忆落库 | 电脑 `memory-banks/airi/airi/general` 新增 `bc0d627a`（对话原文） |

**结论：`navigator.locks` 与 `crypto.randomUUID` 都只在安全上下文（HTTPS 或 localhost）存在**，所以
"像 MTK 那样用局域网 HTTP 发页面"**不能照搬**；另外 `websocket-bridge.ts:39` 在浏览器里没有回退，
必须由壳提供 `window.AiriHostBridge`。三个坑都是确定性的，不是猜测。

安全上下文的解法（推荐顺序）：

1. **HTTPS via `tailscale serve`（已在本机验证）**：`tailscale serve --bg --https=8443 http://127.0.0.1:6180`
   → `https://win-j5m7va687v8.tail675ef5.ts.net:8443/` 返回 200，真证书、浏览器直接可信。
   局域网走 tailnet 直连、外网走 DERP，**一套 URL 解决 LAN/外网两条路**，无需双监听。
2. 壳内注入 `navigator.locks` + `crypto.randomUUID` 垫片（已证明可行），并实现 `AiriHostBridge`；
   代价是只补已知 API，往后用到别的安全上下文 API 还会再撞一次。
3. 自签 HTTPS + 壳里放行证书：仅局域网，且换证书就得重建壳。


## 她的模型与卡怎么到手机（已做）

手机上的"角色"是两样东西，缺一不可：

1. **人设卡**（`localStorage['airi-cards']`，Map 序列化成 `[id, card]` 对）。卡里的 `activeCardId` 是
   普通 ref、**不持久化**，启动固定从 `'default'` 开始——所以让尤诺成为开机角色，做法是把 `default`
   这个 key 的内容换成尤诺卡，旧卡另存 `relu` 键。
2. **Live2D 模型**。桌面用的是导入的 `Nahida.zip`（存在 `localforage` 的
   `keyvaluepairs/display-model-*`，值形如 `{ id, format, type:'file', file: Blob }`，**要取 `.file`**）。
   手机拿不到桌面的 IndexedDB，所以模型必须**打进 APK**：把 zip 放进
   `packages/stage-ui/src/assets/live2d/models/`，在 `stores/display-models.ts` 的 `displayModelsPresets`
   里加一条 `preset-live2d-yuno`，卡里的 `defaultAvatarModelId` 与 `avatarModels[].id` 都改成这个 preset。

实测（2026-11-04）：17 MB 的 Nahida zip 从桌面 CDP 分块取出（1.5 MB/块、base64 回传），放进 APK 后
手机顶部显示「尤诺」、画面渲染出纳西妲风格模型，`settings-stage-model-selection.selected = preset-live2d-yuno`。

## 分工（谁跑什么）

| 能力 | 电脑 | 手机 |
| --- | --- | --- |
| 模型调用、工具、Castalia 记忆 | ✅ 唯一真源 | ❌（安卓无引擎二进制，别开假开关） |
| 人格、情绪、psyche/VAD | ✅ 唯一真源 | 只消费 |
| Live2D / VRM 渲染、口型 | ❌ 不挂 Stage | ✅ WebGL，本地音频分析算口型 |
| TTS 合成 | ✅ 默认（音色统一） | ✅ 可切本地合成（断连也能说话） |
| 出声 | ❌ 手机接入即静音（`settings/speech/output-muted`） | ✅ |
| 麦克风采集 | — | ✅ 采集；STT 建议留电脑（一套 hearing 配置） |
| 网页与静态资源 | ✅ HTTP 发 `stage-pocket/dist` | 加载 |
| 主动性（自己开口） | ✅ 唯一所有者 | ❌ 必须关（`App.vue:113` 随连接状态切） |

## 局域网 vs 外面（一套 HTTPS 入口，按优先级回退）

现状实测：

- 局域网 `192.168.10.18`；6121 已绑 `0.0.0.0`（今天改的），本机防火墙三个 profile 全关。
- Tailnet 本机 `100.79.165.94`；`tailscale serve` 原有 `443 → 127.0.0.1:8000`，2026-11-04 又加了
  `8443 → 127.0.0.1:6180`（本次验证用，已确认 200）。
- **手机 Tailscale 现在 `offline, last seen 2d ago`**，外网入口前必须先登录并常驻。
- MTK 自己的蜂窝实测（`docs/stream-plugin.md`）：Tailscale 走 DERP 约 150 ms、0% 丢包；视频串流在 CGNAT 下只有 9 fps，
  而 AIRI 的文本/音频不受此限。

因为安全上下文是硬要求，页面入口只有 HTTPS 一条稳路（`http://<lan-ip>` 会缺 `navigator.locks` 与
`crypto.randomUUID`，见"已验证"）。于是 LAN 与外网不是两套代码，而是同一套 URL 的两种可达路径：

```
手机壳
 └─ https://win-j5m7va687v8.tail675ef5.ts.net:8443/   （tailnet only）
     ├─ 在家：tailnet 直连 192.168.10.18            → 低延迟
     └─ 在外面：tailnet 走 DERP                      → 约 150 ms，文本/音频够用
     通道：wss://<同一主机>:<port>/ws（或继续走 ws://192.168.10.18:6121，见下）
```

补充要点：

- 通道（6121）目前是明文 `ws://`。页面在 HTTPS 下会因混合内容被拦，所以要么把 6121 也纳入
  `tailscale serve`（`--https` + 反代到 6121 的 `/ws`），要么壳允许混合内容（不推荐，且浏览器路径不可用）。
- 只想要局域网直连时，可以保留 MTK 式"局域网 HTTP + 壳内垫片"作为**降级模式**：功能已证明可用，
  代价是垫片维护。
- 外网入口不做端口映射、不开 `tailscale funnel`（沿用 `docs/remote-coding.md` 的既有约定）。

## 协议增量（缩到最小：四件事）

```ts
interface HelloEvent { protocolVersion: number }        // 两端独立升级，缺了会静默"半懂"

interface SpeechSegmentEvent {                          // 仅在"桌面合成"开关下使用
  binding: string, turnId: string, seq: number
  mimeType: string, data: string                        // Base64，句子级 1–3 s
  durationMs?: number, text: string
}

interface AffectUpdateEvent {                           // 低频，不是逐帧
  characterId: string, valence: number, arousal: number, dominance: number
  mood?: string, expression?: string, at: number
}

interface TurnCancelEvent { binding: string, turnId?: string }   // 手机点停 → 取消电脑那一轮（省钱）
```

`context:update` 不能拿来塞这些：那条通道的语义是"给下一轮当上下文、不触发说话"。

## 实施顺序与验收

| 步 | 内容 | 验收 |
| --- | --- | --- |
| 1 | 电脑侧静态服务：发 `stage-pocket/dist`；手机**浏览器**先跑通 | 浏览器里完整一轮；电脑窗口全关也不影响 |
| 2 | 桌面隐藏 + 静音 + 不挂 Stage（`backgroundThrottling:false`） | 电脑无窗口无声音；GPU 不再随 Live2D 波动；6121 仍监听 |
| 3 | MTK 式壳：多地址、连接码/设备 Cookie、常亮、返回菜单 | APK 装一次，之后改 UI 不重打 |
| 4 | 音频下发 + 手机播放 + 本地口型（开关：桌面合成 / 手机合成） | 手机会响、口型跟着动；电脑不出声 |
| 5 | 情绪下发 → 手机表情 | 改 psyche，手机表情跟着变 |
| 6 | 打断 + 手机麦克风走 `input:voice`（桌面已认领） | 手机点停 → 电脑那轮 abort；说话能被识别 |

## 未核实 / 已知小毛病

- 手机 Tailscale 未登录（`offline, last seen 2d ago`），所以 `https://…:8443` 与 `wss` 的**手机侧**还没实测；
  电脑侧已 200。
- HTTPS 页面里连明文 `ws://192.168.10.18:6121` 属混合内容，浏览器会拦；要么把通道也放到同一 HTTPS 入口，
  要么只在壳里放行。壳里放行等于放弃浏览器路径。
- 桌面 `input:voice`（原始音频）是否真的跑 STT：契约与认领都在（`App.vue:435`），没实测过一帧。
- WebView 里 Live2D WebGL 在 ASUSAI2501A 上的帧率与发热：浏览器里能渲染，但没量过帧率。
- 安卓后台/锁屏下 WebView 的 WS 存活，未测（MTK 的做法是屏幕常亮，应照抄）。
- 隐藏窗口下 `backgroundThrottling:false` 是否够（还有 `powerSaveBlocker`）。
- `D:\system\AIRI` 打包产物来自哪棵树未定论（无 git），开关落地后必须重打包部署。
- `better-ws` / server-runtime 对二进制帧的支持：现全是 JSON 文本，Base64 音频未压测。
- **已知小毛病**：连上远端后，手机仍显示"尚未正确配置聊天 Provider"横幅（本地 provider 为空），
  该横幅在远端可用时应隐藏，否则看起来像没配好。

## 不要做

- 不要用 Moonlight 串流实现"手机显示"：渲染回到电脑，违背前提。
- 不要给手机开本地 Castalia/记忆模块：安卓没有引擎二进制，开了只有假象。
- 不要两端都跑主动性：`apps/stage-pocket/src/App.vue:113` 与 `apps/stage-tamagotchi/src/renderer/App.vue:476` 会双双开口。
- 不要为改 UI 重打 APK：UI 在电脑侧，壳一次装好。
- 不要把 `pinia-plugin-synced` 当跨设备同步：它的运行时只有 `MessageChannel`，是进程内的。
- 不要把页面用 `http://<lan-ip>/` 发出去就指望能跑：`navigator.locks`（`tab-election.hasLeader`）与
  `crypto.randomUUID` 都只在安全上下文存在，手机上一开就"启动失败"。要么 HTTPS（tailscale serve 已验证），
  要么壳内垫片 + 实现 `window.AiriHostBridge`（`websocket-bridge.ts` 在浏览器里没有回退）。
- 不要把 8766/新端口做公网端口映射或 `tailscale funnel`。
