# What the literature recommends for text before a TTS request

This note records what papers, providers and practitioner projects say about the text that reaches a
speech engine. It also records where this repository follows the advice and where it does not.

## Findings

### 1. Remove markup in the pipeline, not with a prompt

Home Assistant issue #121819 was opened because a voice read `**heading**` as
"asterisk asterisk heading asterisk asterisk". The reporter tried prompt instructions, including
"never use markdown", and the markdown stayed. The fix belongs to the text-to-speech path.

The `tts-proxy` project in the Home Assistant community implements exactly that path. It sits
between a model and a speech service and applies regex replacements, markdown removal and emoji
removal. Home Assistant architecture discussion #1120 asked for the same removal inside the core.

This repository does the removal in `packages/core-agent/src/voice/output/speech-transformation`.
A model cannot be relied on to keep its answer free of markup.

### 2. A chunk ends at a sentence, not at a character count

KugelAudio documents one logical speech request per turn. Its server buffers text and synthesizes a
sentence when the closing `.`, `?` or `!` arrives. Text without a sentence end is synthesized after
two seconds without new input. The same page compares flush granularity: once per reply is best,
per sentence creates one turn per sentence, and per clause or word creates the most turns. Every
turn pays a full model prefill, so time to first audio grows.

`fastkokoro` names the same trade-off. Its `sentence` strategy gives the best prosody, and the
`phrase` and `word` strategies lower time to first audio at the cost of naturalness.

The research agrees. arXiv 2603.06444 (Interspeech 2026) states that streaming speech with
incremental text has two failures: unnatural prosody from missing lookahead, and long-form collapse
from unbounded context. Its fix keeps a sliding window of previous text and speech tokens, so
context continues across chunks. Its long-text result lowers word error rate from 71.0% to 4.8%.

A character budget is therefore a guard for text with no sentence end at all. It is not a chunk
size. `chunkTtsInput` keeps a budget of 2000 characters and treats it as a guard.

### 3. One streaming session per reply beats one request per chunk

The Alibaba Cloud streaming speech interface accepts text in several `RunSynthesis` messages inside
one WebSocket session. The documentation gives these limits: 10,000 characters per message, 100,000
characters per session, and one character per Chinese character, letter, punctuation mark or inner
space. The server returns audio as a binary stream.

That session is the shape KugelAudio and arXiv 2603.06444 recommend: the engine sees a continuous
reply, and the audio joins without a seam. Each separate HTTP request starts a new engine state, so
prosody restarts at every chunk.

The Alibaba provider in this repository goes through the `unspeech` gateway, which sends one request
and then fetches the audio URL. One reply with ten chunks starts ten engine states. A streaming
session is the correct long-term path for this provider.

### 4. Meaningful tokens are spoken, not deleted

Text normalization literature separates non-standard words into classes and usually speaks them as
words, for example "twenty twenty-four" for a year. Deleting is the cheap fallback.

Deleting a link leaves a gap in the sentence. A reply of "连接 `https://…` 时不会再拼错" becomes
"连接时不会再拼错" after removal, and the object of the sentence is gone. A short spoken
placeholder keeps the grammar, at the cost of a few characters.

The current code deletes links and paths. A placeholder such as "一个链接" is a small change.

## What this repository does now

| Advice | State |
| --- | --- |
| Remove markup in the path, not by prompt | Done: `toSpeechText` strips headings, emphasis, code blocks and lists |
| Drop data that no listener can use | Done: bare links, table rows, JSON payloads, link-like or path-like inline code |
| Keep numbers and money, speak them | Done: money and math preprocessors |
| End chunks at sentence boundaries | Done: `MarkdownSegmenter` splits at sentence ends |
| Use a character count only as a guard | Done: `maximumCharacters` is 2000 and covers text with no sentence end |
| One streaming session per reply | Not done: `unspeech` sends one request per chunk |
| Speak a placeholder instead of a gap | Not done: deletion leaves the gap |

## MiniMax, measured (2026-11-04)

The work above is not specific to one vendor. MiniMax offers three synchronous interfaces and one
asynchronous interface, and the reply-playback path maps to the HTTP one.

| Interface | Endpoint | Shape |
| --- | --- | --- |
| HTTP | `POST /v1/t2a_v2` | whole text in one call, `stream: true` streams the audio only |
| WebSocket sync | `wss://.../ws/v1/t2a_v2` | one message per sentence, the client decides the boundary |
| WebSocket bidi | `wss://.../ws/v1/t2a_v2_bidi` | the server aggregates sentences, `task_cancel` interrupts |
| Async | `t2a_async_v2` | a task and a file, for long text |

One 130-character reply, `speech-2.8-hd`, a cloned voice:

| Path | Requests | First audio | Total | Billed characters |
| --- | --- | --- | --- | --- |
| HTTP, one call | 1 | 458 to 528 ms | 2.4 to 2.9 s | 236 |
| HTTP, one call per sentence | 5 | 512 to 723 ms | 1.7 to 3.8 s | 236 |
| WebSocket sync, one message per sentence | 5 | 587 to 667 ms | 3.6 to 4.0 s | not reported |
| WebSocket bidi, pieces every 120 ms | 6 | 828 ms | 3.0 s | not reported |

Two conclusions follow from the numbers.

The socket is not a latency improvement for reply playback. Bidi pays about 300 ms for its
server-side aggregation, which is the feature a full-duplex voice agent needs and this path does not.

The billed count does not change with the split. A 汉字 counts as 2 characters and every other
character counts as 1, so 130 characters bill 236 whether one call or five carries them. Cleaning the
text is therefore the lever for the bill, and the split is not.

Two more measured facts. Text normalization keeps the billed count equal: the same line billed 35
characters with and without `text_normalization_mode: 'basic'`. About ten requests within a few
seconds answer `base_resp.status_code 1002`, `rate limit exceeded(RPM)`, so the client must surface
that code rather than report a silence.

## Price, and why the model tier matters more than the path

MiniMax sells speech as character packs: HD at ¥700 per 2,000,000 characters and Turbo at ¥400 per
2,000,000, which is ¥0.35 against ¥0.20 per 1,000 characters. A 汉字 bills as 2 characters, so 1,000
spoken 汉字 cost ¥0.70 on HD and ¥0.40 on Turbo.

A reply of 130 汉字 bills 260 characters: ¥0.091 on HD, ¥0.052 on Turbo. Over a thousand replies that
is ¥91 against ¥52, and the split between one call and five changes neither number.

The documentation places Turbo at voice chat and digital humans, and HD at emotion rendering. A chat
voice that defaults to HD pays 1.75 times the rate of the tier meant for the same job.

The pack page also states the rate limit that decides a probing budget: the smallest pack allows RPM
60, and a burst above it answers `1002 rate limit exceeded(RPM)`.

## Sources

- https://arxiv.org/abs/2603.06444 — prosodic boundary aware streaming generation
- https://docs.kugelaudio.com/streaming/chunking-and-latency — flush granularity and server chunking
- https://pypi.org/project/fastkokoro/ — chunk strategy and prosody
- https://help.aliyun.com/zh/isi/user-guide/interface-description.md — streaming speech session limits
- https://github.com/home-assistant/core/issues/121819 — markdown spoken as asterisks
- https://community.home-assistant.io/t/tts-proxy-sits-between-your-llm-and-tts-service-and-allows-reg-ex-replacements-markdown-emoji-stripping-and-more/1018627
- https://github.com/home-assistant/architecture/discussions/1120 — markdown removal for TTS
- https://platform.minimaxi.com/docs/guides/pricing-speech — HD and Turbo character packs, RPM per pack
- https://platform.minimaxi.com/docs/api-reference/speech-t2a-websocket-bidi — sentence aggregation and interruption
- https://platform.minimaxi.com/docs/guides/speech-t2a-websocket — model tiers and text normalization modes
