# LOCAL PATCH — 这个目录不属于上游

`packages/core-agent/src/mind/` 是本地新增代码，**AIRI 上游没有它**。

## 为什么要有这个文件

`AIRI/` 是上游 tarball 快照 + 本地基线提交，不是 clone。
重新拉取上游、`git clean -fd`、或者换机器同步，都会让这个目录消失。
这个文件的作用是：即使只剩下一行注释，也能让你知道"这里曾经有东西，去哪里找回来"。

## 内容

P0 的心智层，纯逻辑，不接模型也不接 OS。

| 文件 | 职责 |
| --- | --- |
| `drives.ts` | 驱力推进、门禁判定、动作决策 |
| `expression.ts` | L0/L1/L2 表达阶梯与两级冷却 |
| `index.ts` | 导出面 |
| `drives.test.ts` | 29 个用例 |

## 怎么找回

三处副本，任选其一：

1. **git 分支**（最推荐）
   ```powershell
   cd D:\AI\castalia-AIRI\AIRI
   git checkout local/mind-p0 -- packages/core-agent/src/mind
   ```

2. **备份目录**（不依赖 git）
   ```powershell
   Copy-Item D:\AI\castalia-AIRI\_backup\mind-p0\* packages\core-agent\src\mind\ -Recurse
   ```

3. **补丁**
   ```powershell
   git apply D:\AI\castalia-AIRI\patches\0001-mind-p0.patch
   ```

一键恢复并校验哈希（推荐，Node 不受 PowerShell 执行策略限制）：

```powershell
node D:\AI\castalia-AIRI\patches\restore.mjs
```

## 校验

`tools/refactor-guard` 的 `locals` 检查会盯住这个目录。
它消失或被改动时，`node guard.mjs check` 会直接失败，而不是静默通过。

## 来源

设计与依据见工作区根的 `DESIGN-mind-dual-loop.md`。
基线提交 `d6e8fe5`（AIRI main @ f1b81967）。
