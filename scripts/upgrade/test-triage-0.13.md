# 0.13.1 升级：stage-ui 测试失败分档

对象：`pnpm -F @proj-airi/stage-ui test:run` —— 1524 个用例里 61 个失败（32 个文件）。

A = 上游 0.13 为云同步/登录写的新测试；本 fork 删了那套面，测试与被测代码都不在树里，属于**不适用的测试**。
B = fork 有意的行为差异（语言默认、每轮多一次上下文 ingest），测试按上游预期写，需按 fork 改测试或接受。
C = fork 版本缺上游 0.13 新增方法的真缺口，会影响功能。
D = 浏览器用例断言/超时，需要逐条看是真回归还是测试环境。

## A 上游云/认证功能（本 fork 已删）
- `src/services/characters.test.ts` — 3 条
- `src/stores/onboarding.test.ts` — 1 条
- `src/stores/providers/config.test.ts` — 15 条

## B fork 有意改变（语言默认/聊天多一次 ingest）
- `src/stores/chat.contract.test.ts` — 1 条
- `src/stores/settings/general.test.ts` — 1 条

## C API 缺口（fork 版本缺上游新方法）
- `src/stores/characters.test.ts` — 4 条
- `src/stores/settings/stage-model.test.ts` — 4 条

## D 浏览器 UI 断言/超时，待逐条核对
- `src/components/misc/character-switcher-drawer.browser.test.ts` — 2 条
- `src/components/misc/profile-switcher-popover.browser.test.ts` — 2 条
- `src/components/scenarios/chat/components/history.browser.test.ts` — 2 条
- `src/components/scenarios/settings/check-bar.browser.test.ts` — 2 条
- `src/components/scenarios/settings/model-settings/live2d.browser.test.ts` — 1 条
- `src/stores/modules/hearing-status.browser.test.ts` — 1 条
- `src/stores/modules/stickers.browser.test.ts` — 1 条

## E 其他行为差异
- `src/components/scenarios/chat/components/send-button.browser.test.ts` — 1 条
- `src/components/scenarios/chat/components/voice-composer.browser.test.ts` — 1 条
- `src/components/scenarios/providers/voicevox-family-settings.browser.test.ts` — 3 条
- `src/components/scenes/stage-avatar-model-missing.browser.test.ts` — 1 条
- `src/features/devtools/motion/live2d/composables/use-playback-keys.browser.test.ts` — 1 条
- `src/stores/chat-background-tasks.browser.test.ts` — 4 条
- `src/stores/chat-stickers.browser.test.ts` — 2 条
- `src/stores/modules/airi-card.browser.test.ts` — 6 条
- `src/stores/modules/hearing.test.ts` — 1 条
