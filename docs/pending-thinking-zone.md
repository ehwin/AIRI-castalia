# 待做：记忆库里的「思考区」（图上做成黑洞）

状态：**未开工**，2026-11-01 记下，避免忘。

## 要什么

记忆模块里与日记（`agent_diary`）并列的一层**不可见的思考区**：她自言自语的东西写在这里，
平时谁也看不见；星图上用**黑洞**表示——有引力（日记/对话能引用它），但不发光（不进提示词、
不参与检索），只有点开才看得见。

## 现状（2026-11-01 实测）

| 东西 | 落在哪 | 谁读 |
|---|---|---|
| 自循环日记 | `memory-banks/airi/airi/project/memory.sqlite`，`source='agent_diary'` | 引擎自循环、`memory_recent` |
| 内心独白（念头） | AIRI 渲染进程 IndexedDB `inner_thoughts`，`topic='self-cycle' / 'held-back'` | `mind` store、`poke()` |

两处分离，且念头**不在**记忆库里——所以召回、维护、图谱都看不到它。这正是要补的那一层。

## 不能违反的既有结论

1. **不参与任何评分/排序/决策。** `D:\新论文\2026-10-31_反思旁路\报告.md §10` 与
   `docs/affect-placement-2026-11-01.md`：零效应的项占住排序只会变差（`WEIGHT_EMOTION=1.0` 时
   17:0 变差）。思考区同理：只存、只可查，不进 `computeScore`、不进注入门、不进 psyche。
2. **默认不可见**：`recallForInjection` / `memory_recall` / `memory_index` / 事实提取一律排除；
   只有显式查询（带 `memType: 'thinking'` 或点开黑洞节点）才返回。
3. **可审计、可删**：行里要带 `created_at`、证据 id、产生它的驱力快照；软删用 `is_active=0`。

## 落点（建议顺序）

1. `Castalia-Anima`：`memType` 加 `thinking`（与 general/project/… 同级），写入口只给
   self-cycle 收尾用；`excludeRawMaterialSql()` 与所有召回路径统一排除，避免"写进去就被自己读到"。
2. 迁移：AIRI 的 `inner_thoughts`（IndexedDB）→ 引擎思考区，双写一段再切；IndexedDB 保留只读副本。
3. 星图（3344–3348）：新节点类型 `blackhole`，半径按条目数、吸积盘按最近 24h 写入；边 = 念头→证据。
4. AIRI 面板：`Castalia 长期记忆与自我状态` 页加一块只读列表，默认折叠。

## 验收（可测，不靠观感）

- 写入一条念头后：`memory_recall` / `memory_index` / 注入渲染的返回**条数不变**（前后逐位比对）。
- `memory_recent` 默认不返回思考区；带 `memType: 'thinking'` 时返回。
- 图上出现黑洞节点，点开能列出该区条目，条目带证据 id 且能跳到对应日记/对话。
- 删一条（软删）后，黑洞半径变化，召回结果仍不变。
