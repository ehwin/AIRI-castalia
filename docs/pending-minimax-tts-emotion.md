# 待做：把情绪送进 TTS（MiniMax `voice_setting.emotion`）

状态：**未开工**，2026-11-04 记下，避免忘。

## 要什么

MiniMax 的 `t2a_v2` 支持在 `voice_setting` 里带 `emotion`，同一句话可以读出不同情绪。我们的情绪/驱力状态（castalia 的 mood + 驱力）已经在进提示词，但**没有进语音**：不管心里什么状态，TTS 一律按中性读。目标是把当前心情映射成 `emotion`，随每个合成请求发出去。

## 现状（2026-11-04 实测，不是文档抄的）

| 项 | 结果 |
|---|---|
| 参数位置 | `POST /v1/t2a_v2` → `voice_setting.emotion` |
| 实测样本 | 文本「你回来了啊，我等你好久了。」，`voice_id=yunoclone1104`，`speech-2.8-hd` |
| neutral | 2.772 s / 46 068 B |
| happy | 3.132 s / 51 828 B |
| sad | 4.356 s / 71 412 B |
| angry | 3.168 s / 52 404 B |
| 计费 | 四次 `usage_characters` 相同 → 情绪不额外收字符费 |
| 模型兼容 | `speech-2.8-hd`、`speech-2.8-turbo`、`speech-2.6-hd` 均 `status_code 0` |

取值本次实测了 `neutral` / `happy` / `sad` / `angry`；文档另有 `fearful` / `disgusted` / `surprised`，上机前各测一遍。

AIRI 侧现状：

- `packages/provider-inference/src/providers/cloud/minimax-speech/index.ts` 的 `voice_setting` 写死
  `{ speed: 1, vol: 1, pitch: 0 }`：**没有 emotion**，且**没有读** provider 配置里的 speed/volume/pitch
  —— 设置页那三个滑杆对 MiniMax 目前是空转（注释却写着"provider definition maps speed/volume/pitch itself"）。
- 情绪源已经在手：
  - 引擎：`packages/castalia-plugin/src/vendor/engine/agentState.ts` → `currentMood`（-10..+10，带衰减）、`currentDesire`、驱力 fatigue / boredom / curiosity / focus。
  - 渲染侧：`packages/stage-ui/src/stores/modules/mind.ts` 持有 `castalia/mind-state[/<scope>]` 快照（drives、asleep、napping）。
  - 现状这些只进提示词（`formatSelfStatePrompt`），语音链路完全没有读。

## 落点（建议顺序）

1. **类型贯通**：给合成请求加一个中立的风格字段，别把一家厂商的名字焊进公共类型：
   `SpeechStyle { emotion?: string, intensity?: number }`，从 `TtsRequest`（`packages/pipelines-audio`）
   经 `SpeechOutput.synthesize`（`packages/core-agent/src/voice/output/response.ts`）传到
   `createOutput`（`packages/stage-ui/src/stores/modules/speech.ts`）。
2. **映射函数**（纯函数，可单测）：`mind 快照 + mood + drives → SpeechStyle`。
   - `mood ≤ -6` → `sad`；`-6..-2` → `sad`（弱）；`-2..2` → `neutral`；`2..6` → `happy`（弱）；`≥ 6` → `happy`
   - `boredom` 高且 `focus` 低 → 偏 `neutral` 拖沓；`curiosity` 高且 `focus` 高 → `happy`
   - `asleep || napping` → 不设（保持 neutral），不要醒着说梦话
   - 拿不到快照 → `undefined`（不发这个字段），不能因为缺字段让合成失败
3. **provider**：MiniMax 适配器把 `style.emotion` 放进 `voice_setting.emotion`；模型不支持时静默丢弃。
   顺手把 `config.speed / volume / pitch` 真正读出来塞进 `voice_setting`，让设置页滑杆生效。
4. **设置页**：MiniMax 语音页加「情绪」选择：跟随心情（默认）/ 固定某个值 / 关闭。跟随心情时显示当前映射结果，方便调。
5. **可观测**：把一次合成的 `(mood, drives, emotion, model, voice)` 写进 io-trace，事后能对照"这句听着对不对"。

## 不能违反的既有结论

1. **不额外发请求**：情绪只是同一请求里的字段，不能为它再调模型或再合成一遍。
2. **不改分块与并发**：情绪按轮（turn）取一次，分块只切文本；不要出现同一句话内情绪跳变。
3. **不把情绪写进 TTS 文本**（别在文本里加"（开心地）"）：会被念出来，还按字符计费。
4. **默认安全**：映射失败、字段缺失、模型不支持，都必须退回中性可用状态。

## 验收（可测，不靠观感）

- 映射纯函数：给定 mood/drives 断言输出 emotion，覆盖每条边界与空快照。
- provider 请求：mock `fetch`，断言 `voice_setting.emotion` 在传入时出现、缺省时不出现，且 `speed/pitch/vol` 来自配置。
- 端到端对照：同文本同 voice，`neutral` 与映射出的 emotion 各合成一次，音频字节数与时长必须不同
  （本次实测差 0.36–1.6 s，可作判据）。
- 计费不变：两次 `usage_characters` 相同。
