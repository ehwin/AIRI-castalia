# 推广前深度全链路检测（2026-11-06）

分支：`ehwin/feat/diary-partition`（AIRI 与 Castalia-Anima 同名）
部署包：`dist/verify-pack-20261106q` → `D:\system\AIRI\apps\stage-tamagotchi\dist\win-unpacked`
提交：`c489cdfe1`（fork/ehwin/feat/diary-partition）
asar SHA-256：`144eba9e7dc1a5ceb7f6ef80d992af718131f8a5bd8d054e8cbc5bcccd600f56`（源包与部署一致）
部署后实机：日记 6 天、念头 `6 天，180 行`、模块菜单无 autoregressive、启动日志 119 行 0 错误

## 1 结论

可以推，但先看第 8 节的六条遗留。门槛项这一次全部是绿的：

| 门槛 | 结果 |
| --- | --- |
| `pnpm typecheck`（仓根，55 个任务） | **55 successful，exit 0** |
| `stage-tamagotchi` 全量测试 | **113 文件 / 822 passed**，4 skipped，0 failed |
| `stage-ui` node 项目 | **157 文件 / 1283 passed** |
| `castalia-plugin` 全量 | **16 文件 / 126 passed** |
| `core-agent` | **700 passed** |
| 包内密钥 / 个人路径 | 真实密钥 0，`C:\Users\1` 0 |
| 自动更新 | 已关闭，不会把 fork 换成上游 |

这次之前 `pnpm typecheck` 是红的（castalia-plugin 与 stage-pages 各一批），根因都在
`d02629d25 vendor: upgrade AIRI fork to upstream v0.13.1` 那次大删文件之后的残留，与本批
日记/念头改动无关。这次一并修完，见第 7 节。

## 2 检测范围

1. 静态门槛：仓根 typecheck、四个工作区全量测试。
2. 包体：asar 结构、密钥、个人绝对路径、sourcemap、自动更新配置。
3. 首次启动：全新 `--user-data-dir` 实例，走 onboarding，读日志。
4. 记忆链路：真库分区隔离、日记写入、念头存档、页面读数与库内一致。
5. 端到端点击：设置 → 模块 → 日记 / 念头，以及「记住这一天」的真实写入。

## 3 包体

- `resources/app.asar` 333.9 MB，9981 个条目。
- `.map` 269 个，全部在 `node_modules/` 下（第三方发布自带），应用代码没有 sourcemap。
- 密钥扫描（分块正则）：`sk-…` 0、`ghp_…` 0、`AKIA…` 0、字面 `Bearer <token>` 0。
  `-----BEGIN … PRIVATE KEY-----` 命中 7 处，逐条看过，全是 PEM 构造工具的注释与模板字符串，
  没有真密钥。
- 个人路径：`C:\Users\1` 0 处。`D:/castalia` 2 处、`D:/AI/castalia-AIRI` 2 处：
  - `D:/castalia/run/Castalia-Anima/node_modules/sqlite-vec-windows-x64/vec0.dll`
    在 `vendor/sqlite-shim.ts` 的候选表里（第 8 节第 5 条）。
  - `D:/AI/castalia-AIRI/...` 是 rolldown 生成的 `//#region` 区段名，不含内容。
- 自动更新：`main/index.ts` 传 `enabled: false`，`package.json` 没有 `publish` 段，包内也没有
  `app-update.yml`。上游 `moeru-ai/airi` 的 release 不可能被装进来。

## 4 首次启动（全新 profile）

`--user-data-dir=D:/AI/hermes-home/cache/scratch/fresh-profile --remote-debugging-port=9223`

- 主窗 + onboarding 窗都起来，onboarding 停在「配置您自己的 AI 服务来源」。
- 日志 127 行，`error|exception|unhandled` 0 条。
- 会在 profile 里建 `castalia/memory.sqlite`（条目仓储，4 KB）。
- **没有** `castalia-engine.json` → 没有记忆库 → 状态是 `entry-only`。
- 修之前：日记页显示「还没写」、念头页显示「Nothing archived yet」——把「这台机器没有库」
  说成了「她没写」。修之后两页各自说明「没有配置记忆库」。
  见第 7 节第 7 条。

## 5 记忆分区（真库实测）

快照读法：把 `memory.sqlite`、`-wal`、`-shm` 一起拷到 scratch 再读。**不要用
`immutable=1` 读活库**，它会忽略 WAL，看到的是上一次 checkpoint 的旧状态（本轮踩过，见第 9 节）。

| 分区 | 活跃 | 总行 | 含 diary/thought 行 |
| --- | --- | --- | --- |
| user | 12 | 75 | 0 |
| feedback | 1 | 1 | 0 |
| project | 48 | 121 | 0 |
| reference | 2 | 2 | 0 |
| general | 218 | 340 | 0 |
| diary | 6 | 12 | 6（应然） |
| thoughts | 180 | 180 | 180（应然） |

- 日记：11-01…11-06 六天，每行 `# diary-YYYY-MM-DD`、`character_id = N_h4lzzOfl0AYehOR171-`、
  `mem_type = diary`、`source = diary_day`，有向量。同日重记是「软删旧行 + 插新行」，
  11-04 有一条 `is_active = 0` 的旧行，符合替换语义。
- 念头：180 行，`# thought-<id>`，**0 向量**（`skipEmbed`）。
- 五个普通分区里没有一条日记或念头（0 泄漏）——独立目录 + 不在 `MEM_TYPES` 这条设计成立。
- 端到端：12:45 在日记页点「记住这一天」（2026-11-06），库内同步出现该行，
  页面按钮变「已记住」。

## 6 设置页

- 模块菜单：日记、念头都在，`autoregressive-motion` 已不在（第 7 节第 1 条）。
- 日记页：六天 + 每天条数 + 「已记住 / 记住这一天」；`显示她写过的全部` 默认关闭。
- 念头页：`6 天，180 行`，默认只给条数，勾「显示原始的行」才出正文。
- 中文（zh-Hans）补齐了 `thoughts.*` 与 `diary.unsupported`，之前这两页在中文界面里是英文标题。

## 7 本次修掉的问题

1. **菜单链到一个没实现的页面**：`use-modules-list.ts` 的 `autoregressive-motion` 指向
   `autoregressive-motion.vue`，而页面绑的 `method` / `arHmmNoiseScale` / `arHmmOrder` /
   `arHmmStateCount` 在 `useLive2DMotionMagicSettings()` 里根本不存在（那个 store 只有
   `profileId` / `skipMouthOpen` / `forceViewTarget`）。点进去每个控件都是 `undefined`，
   typecheck 也红。删了页面与菜单项，原位留 `NOTICE` 说明恢复条件。
2. **stage-web 卡片页引用已删的 `useAnalytics`**：删掉跟踪调用（hosted 账号层已不在 fork 里）。
3. **kirie 应用 5 个文件引用 `useAnalytics`**：同样删掉；顺手清掉因此变成未使用的 `enablingGodot`。
4. **kirie 引用的 `SettingsSearchField` / `SettingsSearchResults` 没有从 barrel 导出**：
   组件文件在，`scenarios/settings/index.ts` 少了这两行，补回。
5. **`card-list-item.vue` 引用已删的 `CardSyncState`**：连同永远不显示的云同步角标一起删掉。
6. **`controls-island-speech-mute.test.ts` 缺 pinia**：组件在 setup 里读 remote-stage store，
   测试挂载时没有 active pinia 就抛 `getActivePinia()`。补 `setActivePinia(createPinia())`。
7. **`psyche-layered.test.ts` 类型不兼容**：`seeded()` 返回字面量类型（`valenceBias: number`），
   `transitionPsycheState()` 返回 `PsycheState`（`valenceBias?: number`），赋值处 TS2322。标注类型。
8. **首次启动把「没有库」说成「她没写」**：`CastaliaMemoryCapabilities` 加 `diary` / `thoughts`，
   主进程按引擎实际方法置位；没有库的分支把 `remember-day` / `search-diary` 也注册上并明确拒绝，
   不再撞「No handler registered」。渲染层 `applyCapabilities()` 用后端答案覆盖「端口有没有」
   的猜测，日记页与念头页在没有库时各自说明原因。

## 8 遗留（推广前请决定）

> 2026-11-06 晚更新：下面六条已按你的答复处理，逐条结果见第 11 节。仍然成立的只剩
> 「别人的机器是 FTS-only」和「桥要重启」两条。

1. **独立引擎落后**：`D:\castalia\run\Castalia\dist\memType.js` 里没有 `DIARY_MEM_TYPE` /
   `THOUGHTS_MEM_TYPE`。app 走进程内引擎不受影响，但 5 条桥（3310…3318）没有日记与念头。
   覆盖前要先看这五天的 diff。
2. **页面窗口上限**：日记页只列最近 200 行（约 6 天），念头页只取最近 2000 行（约两个月）。
   更早的写在库里，但页面翻不到。
3. **真库残留测试事实**：`airi/airi/general` 的 `facts` 里有 `('user','test_likes','coffee')`，
   `is_active = 1`，仍在事实候选里。这条是测试写进去的，建议删。
4. **日记分区 11 向量 / 6 活跃行**：历史替换留下的失效向量。检索按 `is_active` 过滤
   （`db.ts` KNN 连接带条件），不会读出已替换的文本，只占空间。
5. **向量扩展只认本机路径**：`vendor/sqlite-shim.ts` 的候选是 `CASTALIA_VEC_EXT` +
   两条 `D:/castalia/...`。换机器或换目录必须设环境变量，否则挂不上 `vec0.dll`，退化为 FTS。
6. **记忆引擎不随包分发**：包里没有 castalia 引擎与 bank。别人的机器上是「只有条目仓储」模式，
   日记与念头本来就不该有，页面现在会如实说明。如果推广要带记忆，得另做一份运行时。

## 9 踩过的坑

**用 `immutable=1` 读活库会骗人。** SQLite 在 WAL 模式下，新写入先在 `memory.sqlite-wal` 里，
主文件要等 checkpoint 才变。`immutable=1` 明确告诉 SQLite「这个文件不会变，别读 WAL」，
于是看到的是旧快照：本轮据此一度判断「点了记住这一天但库里没写」，实际 12:45 那行早在 WAL 里。
正确做法是把三个文件一起拷到 scratch，再打开副本。

## 10 复现命令

```sh
cd /d/AI/castalia-AIRI

# 门槛
pnpm typecheck
env -u PSYCHE_BAND_ENTER -u PSYCHE_BAND_HOLD -u PSYCHE_BAND_CENTER_OFFSET \
  pnpm -F @proj-airi/stage-tamagotchi exec vitest run
pnpm -F @proj-airi/stage-ui exec vitest run --project node
pnpm -F @proj-airi/castalia-plugin exec vitest run
pnpm -F @proj-airi/core-agent exec vitest run

# 打包
pnpm -F @proj-airi/stage-tamagotchi build
cd apps/stage-tamagotchi && pnpm exec electron-builder --dir \
  --config.directories.output=dist/verify-pack-20261106q \
  --config.electronDist=node_modules/electron/dist

# 部署
cp -a dist/verify-pack-20261106q/win-unpacked/. /d/system/AIRI/apps/stage-tamagotchi/dist/win-unpacked/
```

测试里带 `PSYCHE_BAND_*` 环境变量会让 `psyche-layered.test.ts` 假红（band 参数被外部覆盖），
所以复现命令里用 `env -u` 清掉。

## 11 第二轮：按你的六条答复落地（2026-11-06 晚）

你逐条答复后改的东西，六条对应如下。

### 11.1 独立引擎（第 1 条）

- `Castalia-Anima`：源码仓重新构建，`dist/` 同步到 `D:/castalia/run/Castalia-Anima/dist`
  （之前停在 11-01，没有日记/念头分区，也没有 psyche 那批修复）。
- `Castalia`（5 条桥用的那份，1.27.0）：把 `DIARY_MEM_TYPE` / `THOUGHTS_MEM_TYPE` 与
  `normalizeMemType` 的放行补进 `src/memType.ts`，`batchEmbedPending` 的遍历补上 `diary`
  （它不在 `MEM_TYPES`，换嵌入模型后日记永远没有向量），`memDir()` 导出给 store 用。
  重新构建后同步到 `D:/castalia/run/Castalia/dist`，提交 `94378dd`（本地，`origin` 是 ssh，
  推不动；同一个提交已在 `https://github.com/ehwin/Castalia.git` 的 `sync/v1.28-dedupe` 分支上）。
- 覆盖前先把两份旧 `dist` 打包到 `D:/castalia/run/_backup-dist-20261106/`。
- 实测：两份 `memType.js` 载入后 `normalizeMemType('diary') === 'diary'`，且两者都**不在**
  `MEM_TYPES` 里（隔离没有被顺手破掉）。
- 正在跑的桥进程还是旧代码，重启后生效（Guard 任务会拉起）。

### 11.2 日记与念头的反射（第 2 条）

按你说的口径：**日记进库算一条记忆（`mem_type=diary`、`source=diary_day`），念头只记录不反思**，
两者都不进 `MEM_TYPES`，所以反刍、跨库召回、衰减、星图都扫不到它们；只有提到日记/念头时，
模型通过 `builtIn_castaliaSearchDiary` 或页面调出来。这条没有改动代码，是现状与你的描述一致。

### 11.3 清数据（第 3、4 条）

- `airi/airi/general` 的 `facts` 里 `('user','test_likes','coffee')` 已软删（`is_active=0`），
  它是测试写进去的，不再进事实候选。
- 失效向量：用 sqlite-vec 打开各分区，删掉 `is_active=0` 行对应的向量。
  日记 11 → 6（正好等于 6 条活跃行），project 29 → 25，user/general 没有死向量。
  复查：四个分区的「向量指向不存在的行」数量均为 0。
- 注意：这一步必须加载 `vec0.dll` 才能删（`vec_memory` 是虚拟表，光有 shadow 表读得到、删不掉）。

### 11.4 向量扩展路径（第 5 条，原话「没懂什么意思」）

说的是这个：`sqlite-vec` 的 Windows 扩展 `vec0.dll` 不在包里，代码只在三个地方找它 ——
环境变量 `CASTALIA_VEC_EXT`，和本机运行库里的两条 `D:/castalia/...`。别人的机器上这三条
都不存在，于是向量检索整条链静默退化成 FTS（能搜到字面词，搜不到语义）。
现在 `vec0.dll` 随包走（`resources/castalia/vec0.dll`），查找顺序是：环境变量 → 包内 →
本机运行库。新增用例覆盖前两条。

### 11.5 包内全量（第 6 条）

原来「换台机器就只剩条目仓储」的根因不是缺引擎代码 —— 引擎的进程内镜像
（`packages/castalia-plugin/src/vendor/engine`）本来就在包里。缺的是库目录：
`castalia-engine.json` 不存在时，`describeCastaliaEngineConfig` 直接判定「没有引擎」。
现在：

- 没有配置文件 → 用 `<userData>/memory-banks`，目录自己建，`project=airi`、`character=default`；
- 这种库没有 `config.json`，`openBank` 改成允许无配置打开（固定 `EMBED_MODE=none`），
  否则引擎怕误清向量索引会拒绝开库；
- 有配置文件时完全按配置来，坏路径照旧报错，不会被默认值盖掉（新增用例）。

实测（全新 `--user-data-dir`）：启动后 `memory-banks/airi/{feedback,general,project,reference,thoughts,user}`
全部建好，`global.sqlite` 在，日志 123 行 0 错误；日记页「0 天」、念头页「0 天，0 行留着」——
不再是「没有配置记忆库」。你自己的 profile 不受影响，仍是 `D:/castalia/memory-banks/airi`，
6 天日记、20/13/13/57/50/28 条的读数不变。

### 11.6 还没解决的

- 别人的机器上是 FTS-only：嵌入要 API key 或本地 Ollama，包里不带模型。接上之后
  `batchEmbedPending` 会把日记补嵌（这条第一轮已经修过）。
- 桥进程要重启才用上新 `dist`。
- `Castalia` 仓库的 `origin` 是 ssh，当前 shell 没有可用 key；提交已推 https 分支。
