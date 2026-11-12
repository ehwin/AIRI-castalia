# 已知的 lint 债务

本仓校验以「类型检查 + 单测」为准，`eslint` 目前**不作为阻塞项**。原因是仓库里已有约 57 条错误，全部在这次功能改动之前就存在，逐条修会混进无关改动。

## 分类与处理顺序

| 类别 | 例子 | 数量级 | 怎么修 |
| --- | --- | --- | --- |
| 正则捕获组未使用 / 冗余分支 | `core-agent/src/mind/activity.ts`、`inner-voice.ts`、`persona/relational-policy.ts` | ~10 | 逐条改 `(?:...)`、删冗余分支，**必须配单测**（正则改写会改行为） |
| 全局变量用法 | `apps/stage-tamagotchi/.../castalia-settings.ts` 的 `Buffer`、`docs-notes/research/*.mjs` 的 `process` | ~40 | 换 `require('node:buffer').Buffer` / `node:process`，机械修改 |
| 单行多语句、顶层 await | `packages/castalia-plugin/src/bank/*.ts`、`docs-notes/research/*` | ~10 | 拆行或包一层 `main()` |
| 注释过长（warning） | 多处设计注释 | ~20 | 保留信息，压缩到 50 词内 |

## 建议做法

1. 先处理 `docs-notes/research/*.mjs`——它们只是分析脚本，直接在 `eslint.config.ts` 里给 `docs-notes/**` 加忽略即可，不必改代码。
2. 再处理 `Buffer`/`process` 这类纯机械项，一次提交。
3. 正则类单独提交，每条配一个断言当前行为的测试。
4. 清完后把 `.github/workflows/fork-ci.yml` 里的 lint 步骤打开，并设为阻塞。

## 已知的 browser 测试失败（2026-11-12 基线）

`packages/stage-ui` 的 browser 项目在本机全量跑时有 3 条稳定失败，另有若干条随负载抖动的时序失败（`src/workers/vad/silero-vad.browser.test.ts` 等）。稳定失败的是：

- `src/stores/modules/optional-modules.browser.test.ts` — `retains disabled modules…`、`cancels an active transcription…`
- `src/stores/modules/airi-card.browser.test.ts` — `initializes while another Pinia becomes active`

判据（已实测）：把当次功能改动 `git stash` 后重跑同样两条文件，失败一字不差。所以这些不是新引入的，`.github/workflows/fork-ci.yml` 也因此只跑 node 项目。修它们时请连带上游 issue #3153 的语义一起看，不要只改断言。

## 为什么写这一页

公开发布后第一个 PR 很可能带着 `pnpm lint` 的失败来问。这一页先给出“是不是我改坏的”的判据：只要报错落在上表的文件里，就不是新引入的。browser 测试同理，先跑 `git stash` 对照。
