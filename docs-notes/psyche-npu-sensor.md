# 心灵传感器（NPU）· 内存开关与实测量

2026-10-30。范围：记忆体之外的代码（`D:/castalia/run/Castalia/scripts/psyche_npu.mjs`），
不动 Castalia-Anima 的 `src/`／`dist/`。

> ⚠️ **2026-10-30 续测更正**：本文所有 `0.917 / 0.833` 数字来自**示例泄漏**（12 条示例里 7 条与探针逐字相同）。
> 干净留出集上 0.8B = **0.60 / 0.45**、2B = 0.60 / 0.55；而且 0.8B 从不输出中性（0/68，valence −0.5 占 54%）。
> 4B 在本机 45% 调用直接 `HTTP 500 (ERT_CMD_STATE_TIMEOUT)`，不可用。
> 见 `psyche-autoregressive-logic.md`。下文的**内存/延迟实测与失败尝试清单仍然有效**，只有准确率结论要按这条更正读。

## 一、内存实测（本机 31.1GB，`Process.WorkingSet64`）

前提：**它是异步传感器，不在回复路径上**，语言交互全交给 API 大模型。
所以延迟不是验收门槛，**内存和判断准确率才是**。

| 配置 | 常驻 RSS | 12 探针 方向 / 标签 |
|---|---|---|
| **Qwen3.5-0.8B + 12shot（当前默认）** | **2118 MB** | **0.917 / 0.833** |
| Qwen3.5-0.8B + 3shot | **2346 MB** | 0.667 / 0.667 |
| Qwen3.5-2B + 3shot | **3822 MB** | 0.75 / 0.583（服务路径）· 0.75 / 0.667（裸模型） |
| Qwen3.5-4B + 3shot | **5611 MB** | 0.833 / 0.75 |
| 2B 零样本（无示例） | 3822 MB | 0.50 / 0.58 |
| 4B 零样本 | 5611 MB | 0.75 / 0.67 |
| Qwen3-4B 纯文本 | 4339 MB | 0.42 / 0.50 |
| 卸掉模型 | **0**（flm 进程退出） | — |
| LemonadeServer 空转 | 54–71 MB | — |

三条硬结论：

1. **示例比模型大小更值钱**：0.8B 加 3 个示例（0.667/0.667）≈ 4B 零样本（0.75/0.67），内存只要 42%。
   2B 加示例追到 0.75 / 0.58–0.67。先上 few-shot，再考虑加模型。
2. **`--ctx-len` 不省内存**：2B 在 2048 与 32768 下都是 3749 / 3751MB。KV 不是主要占用。
3. **`--pmode` 不影响速度**：turbo/balanced/performance 差 <10%。别在这两个旋钮上耗时间。

真实占用（本机常态，AIRI/Electron/5 桥/WSL/Edge 都在跑）：基线空闲 6.3GB →
载入 2B 后 **剩 2.7GB**、整机 91%。这就是为什么必须有闸门和自动卸载。

## 二、延迟（不是约束，但要知道代价）

FLM 每次响应回 `usage`，可以拆：

- 417 token 提示词（长 rubric + 3 示例）：`prefill_speed_tps ≈ 695–717`，TTFT ≈ **0.60s**
- `decoding_speed_tps ≈ 25`，36 个输出 token ≈ 1.43s
- 热请求 ≈ **2.6s**；冷启动（含拉起 flm 子进程）≈ **27s**

prompt 越长 prefill 每 token 反而越快（批处理），所以 few-shot 的实际代价只有 ~0.1s。

## 三、开关（三层保护）

配置 `castalia.config.json`：

```json
"psycheSensor": {
  "enabled": true,
  "model": "qwen3.5-2b-FLM",     // 0.8B=2346MB / 2B=3822MB / 4B=5611MB
  "port": 3352,
  "idleUnloadSeconds": 600,      // 闲 10 分钟自动卸
  "maxRssMb": 4200,              // 载着时 RSS 超线立即卸
  "minFreeMb": 2500,             // 加载前剩余内存门槛：不够就拒绝加载，绝不推进 swap
  "promptMaxTokens": 128
}
```

```bash
node psyche_npu.mjs --status        # 开关/模型/是否已载/RSS/空闲秒
node psyche_npu.mjs --on  --model qwen3.5-2b-FLM --idle 600
node psyche_npu.mjs --off           # 立刻卸模型并置 enabled=false
node psyche_npu.mjs --serve         # HTTP 传感器（托盘「心灵传感器(NPU)」也是这个）
```

HTTP：

- `GET /health` → `{enabled, model, loaded, device, rssMb, idleUnloadSeconds, idleSeconds}`
- `POST /appraise {"user":"…","assistant":"…"}` → `{ok, appraisal:{valence,tag}, ms, loaded:"cold|warm"}`
- `POST /unload`

已验证的语义：

- `enabled=false` → `/appraise` **0ms 返回 disabled**，永不加载、0MB；
- 剩余内存 < `minFreeMb` → `{ok:false, lowMemory:true, freeMb, needMb}`，**不拉起 flm**
  （门槛临时设 30000 实测：`freeMb 6324 < 30000` → 直接拒绝，flm 进程数 0）；
- 空闲超时 → 回收器卸模型，RSS 3822MB → **0**，flm 进程退出；
- `--off` 对正在运行的服务**实时生效**（每请求重读配置，不用重启）。

## 四、两个真坑（都踩过，已修）

1. **`lemonade load` 这个 CLI 会阻塞到超时**：实测 188s 后报
   `Could not connect to Lemonade server (Failed to read connection)`。
   正解：**不要调 `load`**，直接 POST `/v1/chat/completions` —— Lemonade 自己会按需拉起模型
   （日志 `(FastFlowLM) Loading model … Model loaded successfully`）。
2. **首次加载会被 Whisper 的 NPU 缓存下载拖死**：Lemonade 在载模型时同时启 whisper，
   它要从 `huggingface.co` 拉 `ggml-tiny-encoder-vitisai.rai`，国内 5 次重试 × 16s ≈ **145s**，
   把 26s 的冷启动拖成 172s。
   正解：`lemonade config set whispercpp.backend=cpu`（本机已设）。改前/改后：172s → 26.6s。

## 与托盘的关系

`extraServices` 新增 `psyche-npu`（`node psyche_npu.mjs --serve`，port 3352，onDemand）。
为此给 `castalia_config.py` 的 `_extra()` 加了 `args` 支持——否则脚本类服务只能套一层 bat 壳。
「服务常驻、模型不常驻」是这套的安全默认：服务 ~40MB，模型只在判定时存在。

## 五、0.8B 压榨（最终选型）

主杠杆不是模型大小，也不是输出格式，是**示例数量**。同一套 12 条探针、服务路径：

| 配置 | RSS | 方向 | 标签 |
|---|---|---|---|
| 0.8B + 3 示例 | 2346 MB | 0.667 | 0.583 |
| 0.8B + 8 示例 | 2346 MB | 0.75 | 0.75 |
| **0.8B + 12 示例（当前默认）** | **2118 MB** | **0.917** | **0.833** |
| 0.8B + 16 示例 | 2346 MB | 0.667 | 0.833 |
| 2B + 3 示例 | 3822 MB | 0.75 | 0.583 |
| 4B + 3 示例 | 5611 MB | 0.833 | 0.75 |
| 4B 零样本 | 5611 MB | 0.75 | 0.67 |

**0.8B + 12 示例 (2118MB) 已超过 4B 零样本、也超过 2B/4B+3示例——用 38% 的内存拿到最高的准确率。**

试过但**无效甚至变差**的手段（都实测过，别再重复）：

| 尝试 | 结果 | 原因 |
|---|---|---|
| 标签换成两位不透明代码（`-K`） | 0.333 / 0.5 | 模型会丢符号位；且本任务靠语义定义，不靠去重名 |
| 只输出一个标签字母 | 0.667 / 0.333 | 去掉 rubric 的语义解释后混淆加剧 |
| 删 rubric 语义定义（"只扛 3–5 条约束"） | 0.583 / 0.5 | 对**格式**约束成立，对**语义区分**不成立 |
| 5 票多数投票（T=0.8） | 0.75 / 0.667 | 引入的系统性错误比噪声大（`中性→被敷衍` 5 票一致） |
| 纯文本 4B（Qwen3-4B） | 0.42 / 0.5 | 代差 > 体积；无视觉塔省 1.3GB 但判断更差 |

结论：**默认 0.8B + 12 示例**（2118MB，约 1.9s/次）。内存更紧时只能减示例，别换输出格式。
下一步若还要涨点，只有蒸馏/微调（有实测帖：Qwen3-0.6B 微调 10%→92%），但 NPU 侧 FLM 不支持训练，
需要另做 ONNX 转换链路。
