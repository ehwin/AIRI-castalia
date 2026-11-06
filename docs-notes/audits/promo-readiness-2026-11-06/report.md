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

## 12 记忆服务做成菜单（2026-11-06 21:00）

原来接嵌入/反思只能手改 `<bankDir>/config.json`，字段名还分模式（`api` 用 `api_url`/`api_model`，
`ollama` 用 `ollama_url`/`model`），写错不报错、只会静默退回默认模型。现在：

- 设置 → 模块 → **记忆服务**（`/settings/modules/memory-api`）：嵌入（后端/地址/模型/维度/密钥）、
  反思 LLM（地址/模型/输出预算/事实抽取/每轮事实上限/密钥）、分拣 LLM（地址/模型/密钥）。
- 读的是记忆库自己的 `config.json`；**密钥只进 `keys.enc`**（AES-256-GCM，`keys.key` 32 字节 hex，
  缺失时生成），页面只回「已设置/未设置」，永远不回明文；写密钥时会把 `config.json` 里的明文删掉
  （引擎先读 keys.enc，留着只会误导）。
- 合并写回：`db_dir`、`personas`、提示词路径这些不认识的键原样保留；写之前 `config.json.bak-<时间>`。
  空输入不落 `""`，只动一个通道时不会生成空 section（实测：全新库保存后文件里只有
  `embedding.mode` 和填过的 `ollama_url`）。
- 生效方式：引擎在启动时把 config.json 注入环境变量，所以保存后页面明确提示「重启 AIRI 才读到」；
  没有做热切换，因为换维度/换模型会让引擎按「嵌入空间变了」清派生索引，那是最不该在运行时发生的事。

实测：全新 profile 打开页面显示「还没有 config.json」，保存后生成 config.json + keys.enc + keys.key，
密钥不在 config.json；你自己的 profile 打开后各字段就是库里的真值（SiliconFlow + bge-m3 + 1024、
sidrune + deepseek-v4-1-flash + 32768 / auto / 15），密钥框留空表示沿用。

关于日记沉淀：**不进反刍**（你的判断对，沉淀成事实会直接进召回回路，正反馈会炸）。
日记/念头都不在 `MEM_TYPES`，反刍、跨库召回、衰减、星图都扫不到；只有提到时才由工具或页面翻出来。

## 13 记忆库 GUI 搬进 app（2026-11-06 22:10）

你问「为什么 GUI 放在网页」——真实原因有两个：控制台（3348，`viz/server.mjs` + 静态页）最早是
给所有客户端用的独立工具，app 只做了 `shell.openExternal`；再加上一条「跨库 UI 只做一份，别在 app
里再实现」的旧约定。对推广版这条不成立：不能要求用户再跑一个 Node 服务、再切一个浏览器标签。

按 A（原生重做）落地，但只做用户真会用的三件事，控制台里那些开发用的功能没搬：

| 能力 | app 内「记忆库」页 | 3348 控制台 |
| --- | --- | --- |
| 库/项目/分区浏览 + 条数 | ✅ | ✅ |
| 搜索（字面匹配，跨分区） | ✅ | ✅（还带向量融合） |
| 改正文 / 软删 | ✅（改完删旧向量，等补嵌重算） | ✅ |
| 建库/删库、星图、跨库向量 | — | ✅ |

实现：

- `castalia-bank-browser.ts`：扫 `<banksRoot>/<bank>/<project>/<partition>/memory.sqlite`，
  只读查询用只读连接，写入走同一个 shim（会挂 sqlite-vec，删向量才删得掉）；
  路径解析做了越界检查（`bank: '..'` 一律拒绝），有用例。
- 搜索用 `LIKE`（转义 `%` `_` `\`）而不是向量：跨库各用各的嵌入模型，分数不可比；
  这个页面要回答「我记得她说过这句话，是哪个字」。行上标了「还没有向量」，改过的行一看就知道待重嵌。
- 四条 invoke：`castalia:bank:tree` / `search` / `edit` / `delete`；页面 `设置 → 模块 → 记忆库`。
- 11 条单测：条数（软删仍计入 total）、分区遍历、`%` 字面量、排序与上限、越界拒绝、改/删。

实机：用 `CASTALIA_BANK_DIR` 指向临时库验证了浏览/搜索/改/删（改完 `updated_at` 变化、删完
`is_active=0`、页面从 2 行变 1 行）；再换回真库，页面列出 `airi / airi` 的最新 100 行，
搜「坦克世界」命中 5 行。

## 14 两个版本：这两页只在公开版（2026-11-06 23:20）

你说的口径改正了：**记忆库 / 记忆服务两页只进公开版；自己的非公开版不要它们**（私有版继续用
3348 控制台）。

- 开关：构建期 `VITE_AIRI_EDITION`。不设 = 私有版；`pnpm -F @proj-airi/stage-tamagotchi build:public`
  （= `electron-vite build --mode public`，读 `apps/stage-tamagotchi/.env.public`） = 公开版。
- 菜单：`use-modules-list.ts` 里两条目按 `PUBLIC_EDITION` 展开，私有版不出现。
- 页面自身也挡住：直接输 URL 进去只显示「这一页只在公开版里出现」，不读也不写库。
- 主进程的 IPC 保留（公开版要用；私有版只是没有入口）。

实测：
- 私有包（`verify-pack-20261106y`，默认构建）：模块菜单里没有「记忆库」「记忆服务」；
  直接访问 `#/settings/modules/memory-banks` 显示「这一页只在公开版里出现；自己的构建用 3348 控制台」。
- 公开包（`verify-pack-20261106-public2`，`build:public`）：两个条目都在，记忆库页正常列出真库。

注意：i18n 文案在两种包里都在（打包按语言整份带入），区别只在渲染出来的入口和页面守卫。
