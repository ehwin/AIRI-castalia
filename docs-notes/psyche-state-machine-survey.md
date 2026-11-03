# 心灵状态机：论文 / 项目 / 论坛的实现方式（调研记录 2026-10-30）

问题：要不要用本地小模型做一个"心灵状态机"。
下面只记有出处的机制与数字；每条都标了它回答的是"用什么模型"还是"怎么组织"。

---

## 一、论文

### 1. CPM-MultiAgent — arXiv 2607.07824（2026）
《From Triggers to Emotions: A CPM-Grounded Appraisal Multi-Agent for Dynamic Emotional Evolution in Persona-Based Dialogue》

- 痛点陈述与本机现状一致：人设对话把情绪写成静态特质或表层文风；情感对话研究基本都在做"对用户共情"，**没人在建角色自己的情绪演化**。原文：*"Persona-based dialogue systems often encode emotions as static traits or surface-level stylistic cues"*。
- 结构：**情感触发器抽取 → CPM（Component Process Model，Scherer）协同评估 → 情绪状态更新**；情绪被建模为"由对话触发器持续重塑的隐状态"，不是固定属性。
- 消融：四个 CPM 检查项互补，**去掉 Relevance Check** 会削弱"这个触发器到底有没有情绪意义"的判断，后续评估整体塌方（附录 Table）；结论明确写着增益来自结构化分解，*"not merely due to backbone capacity"*。
- 人类评估（六维，含 EUC/TG/TC/PC/ARQ）GPT-5.4 一档 4.283 / 4.295 / 4.322；GPT-5.4-mini 4.261 / 4.272 / 4.306；nano 4.083 起。
- **可用结论**：把"抽触发器"和"判情绪"拆成两步、评估要看多维度，是能测出增益的做法；单维情绪标签不够。

### 2. OCC / Scherer 的工程落地（两个项目，见第二节）——共同模式
`appraisal 向量 → 投影到 PAD/VAD 核心情感 → 动力学`。不是"模型直接输出情绪"，而是模型输出**评估维度**，情绪由代码算。

### 3. Elysium X 500 FR（HuggingFace，Qwen2.5-1.5B + LoRA rank32）——小模型当情绪分类器的真实上限
输出 500 个情绪坐标 + 强度（0.25/0.5/0.75/1.0），严格 JSON。作者自己给的诚实数字（私测 1,195 行，无重叠）：

| 测试集 | 本版 run1 |
|---|---|
| 整体 exact match | **70.71%** |
| 句子里**有**情绪词（n=792） | **94.82%** |
| 句子里**没有**情绪词（n=403，hard） | **23.33%** |
| micro-F1（hard rows） | **24.24%** |

作者的原话：*"most 'accuracy' on easy rows is pattern-matching on the emotion word"*。
**可用结论**：专门训过的 1.5B 情绪模型，在"没有显式情绪词"的句子上只有 1/4 对。而"没有显式情绪词"恰好就是否定、反讽、上下文依赖那类——也就是词表最瞎的地方。所以"买个小模型当评估器"不能作为既定收益，必须自己测。

### 4. 自评能不能当信号
- LIA-Assistant：让**正在回复的那个模型**在回复尾部吐一个 `<psyche_eval/>`（valence / emotion / quality），解析后剥掉再显示，**不额外调用**；成本 +25 output tokens、+2ms。
- 《The Personality Illusion》(arXiv 2509.03730)：指令微调能让模型的自报**稳定且心理上自洽**，但与**行为**解离——自报是一套，行为是另一套。
- Martorell 团队 2026（媒体报道，未核原文）：LLaMA-8B 级模型对"幸福感"内省约 90% 精度。
- **可用结论**：自评适合当**连续性输入**（她记得自己刚才是什么心情），不适合当**事实断言**或唯一转移依据；写进记忆时必须标明"这是自述"。

---

## 二、项目（都能读到实现）

### 1. LIA-Assistant — ADR-068 Psyche Engine（2026-04）★形状最接近
五层：
1. Personality（永久）：Big Five → PAD baseline
2. **Mood（小时级）：PAD 空间，向 baseline 时间衰减**
3. **Emotions（分钟级）：22 个离散情绪，指数衰减**
4. Relationship（周级）：四阶段 depth/warmth
5. Drives（会话级）：好奇心、参与度

要点：
- **PAD 连续量优先于离散状态**：平滑过渡、可做数学（decay / push / contagion）、可做 mood-congruent 记忆召回。
- 全部动力学在**无状态、纯计算的 `PsycheEngine` 类**里（无 DB、无 LLM、无 async），**约 155 个单测**覆盖。
- 关系**单向不倒退**（ORIENTATION→EXPLORATORY→AFFECTIVE→STABLE）；缺席只衰减 warmth_active，深度与阶段保留。
- 成本：+65 input tokens / +25 output tokens / **+2ms 阻塞（读库+算），异步则 0ms**。

### 2. Murmur — 生产环境自 2026-07 跑真实陪伴 ★工程纪律最好
`conversation → LLM scorer → deltas → engine(dynamics) → state → 注入/前端`，另一条 `time → ticks → decay + absence`。
- 维度有 **baseline / inertia / saturation / decay**，核心是纯计算、**不需要 LLM**。
- 所有 delta（对话打分、缺席规则、你自己的代码/按钮/正则）走 `update()` 里的**同三条闸**——单一写入路径。
- 哲学：**"the mirror is not the reins"** —— 输出只写"她现在的状态是……"，从不写"你现在该发消息"，注入结尾写"yours to act on or not"。
- `examples/scorer_template.py` 就是感知层模板，可接任意小模型。

### 3. bhava（Rust）— OCC 落地
ADR-004：原来用硬编码 `MoodTrigger`(praised/criticized/surprised/threatened) + 固定增量，问题是 *"emotions disconnected from context — the agent doesn't know why it feels something"*。改成 OCC 四维（desirability / praiseworthiness / likelihood / attribution）+ 12 个具名情绪，Gratitude/Anger 随 affinity 缩放，**纯计算 18ns**。

### 4. emotional-memory（Python）— 可插拔评估 schema
`AppraisalSchema` 抽象：默认 Scherer CPM 五 SEC，也可配 OCC 子集；`LLMAppraisalEngine` 输出 `GenericAppraisalVector`，再用 `project_to_core_affect` 投到核心情感。优点：换理论不用改动力学。

### 5. 酒馆生态（MVU / 状态栏）— 规模最大的"事实上的状态机"部署，也是最大反面教材
做法：角色卡里塞变量更新命令（`<UpdateVariable>`），模型在回复里吐，前端解析成楼层变量，状态栏 iframe 读变量渲染。
论坛证据：
- NGA 帖《酒馆里那些轻前端角色卡里的状态栏不会随着进程更新信息》——装了 MVU、变量加载成功，但状态栏不随剧情走。
- 《玩家急救手册 v0.9.7》——整本手册专治"卡玩到一半数字不动 / 回复被切一半 / 开新聊天报错"，明确说"多数情况你可以自己救回来"。
- 《MVU 会让 AI 变蠢吗》——社区自己在担心：变量更新要吃输出 token，挤占正文。

### 6. 其它可参考
- **thymos**：连续神经调质 daemon（情绪当"体液"，持续泄漏/扩散）。
- **animus-sdk**："Tunable by physics, not prose"——"情绪持续更久"是一个参数 λ，不是一轮 prompt 工程。
- **BetterSimTracker / ScenePulse**：酒馆数值追踪，prompt 可编辑、支持"顺序抽取"（一次一轮，避免一次吐太多）。
- **promitheus.ai / magnumical.ca**：生产写法——情绪分类器"**永远在回复旁边，不在它前面**"（runs beside the reply, never in front of it）。

---

## 三、论坛 / 生产教训：三种失败形状

1. **算了但没接上（空转）**。hotmolts 的 build log：《Emotional Engine — Silent When It Should Talk》，引擎 v2 技术上正确，但状态既没进注入也没进 UI，等于不存在。本机同款：`affectLexicon.ts` 注释里的"262 条活跃记忆 0 条有 vad"（Ollama 没起）。
2. **跑在热路径（拖慢）**。magnumical：陪伴产品的情绪分类必须与回复并行；同步等分类 = 用户感到"她卡住了"。
3. **把状态写进模型输出（被吞）**。MVU 全家桶：截断、正则没匹配、token 预算被吃、开新聊天丢变量——于是需要一本急救手册。

---

## 四、结论（对这套引擎）

**要做，但模型只当传感器，状态机是确定性代码。**

采纳：
- LIA 的五层 + 纯计算 + 约 155 单测那种可回归性；
- Murmur 的"单一写入闸 + 倾向不是命令 + 只用 baseline/inertia/saturation/decay 四个旋钮"；
- CPM 的"触发器抽取 与 多维评估 分离"（消融证明 Relevance 那一步不能省）；
- 自评 tag（+25 tokens、0 延迟）作为**主传感器**，比现在这条 `queueForVad → ollamaDetectVAD` 再发一次请求更省更稳。

不采纳：
- 让 1.5B 专职情绪分类（Elysium 的 hard-row 23% 说明它只是"词表的高级版"）；只有在**用自己语料微调/或改成 4 维闭集 appraisal** 时才可能有收益，必须实测；
- 把状态存成模型输出（MVU 的教训），以及让模型当转移函数（不可回归）。

**建议的形状（三层 + 三闸）**
1. 传感器 A：主模型自评 `<psyche_eval>`（0 额外调用）；
2. 传感器 B：本地小模型（异步、闭集 4 维 + ~16 事件标签、temperature=0、JSON 约束），**只在自评缺失/冲突时兜底**；
3. 状态机：`next = transition(prev, appraisal, dt)` 纯函数，显式转移表 + 滞回（进入阈值 > 退出阈值、最小停留、冷却）+ 四旋钮动力学；离散状态由 PAD/VAD **派生**，不另存一份真相；
4. 注入：只给事实（"她在冷战，从 12:30 起，因为被忽略"+ 触发原句），不给命令。

**判据（先测再落）**
1. 否定/反讽探针：自造 100 句（「你终于想起来问我了」「行，你忙吧」），词表 / 1.5B / 主模型自评 三类，比**方向准确率**；预期下限按 Elysium 的 23%。
2. 延迟：自评 0 额外调用；本地小模型 p95 ≤ 400ms，超了只做异步。
3. 空转计数器：每轮是否真的产生 delta、标签分布、失败率——判活只看计数器（对齐"写路径判活只看库有没有长"这条纪律）。
4. 收益：人格 eval（13/14 命中、0/8 噪音）开/关状态注入对比，防止"加了状态反而不像她"。

---

## 五、下一步（记忆体之外，可立刻做）

1. `D:/AI/Lemonade/bin/LemonadeServer.exe` 拉起来（配置里已有"AIRI 分拣" 13305，onDemand），拉 Qwen2.5-1.5B/3B q4，量结构化 JSON 的 p50/p95。
2. 写 100 句否定/反讽探针集，跑 词表 vs 1.5B vs 主模型自评。
3. 给评估器做带计数器 + 词表兜底的断路器（外挂，不改引擎）。
