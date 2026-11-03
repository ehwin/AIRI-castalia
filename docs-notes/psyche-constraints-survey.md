# 怎么"约束"这类判定：外部依据 + 落到本机的取舍

2026-10-30。配套：`psyche-autoregressive-logic.md`（自回归逻辑与实测）、`psyche-state-machine-survey.md`（状态机设计调研）。
本文只回答一件事：**一个会塌陷、会越界、会随字段顺序改口、还拿不到状态的模型，用什么手段把它约束成可信传感器。**

引用分两级：**[已读原文/摘要]** 与 **[二手引用，未核原文]**。前者我看到了摘要或正文里的原句，后者只看到别人转述。

---

## 一、输出空间：约束解码只消灭"结构失败"

**[已读原文]** Tam et al., *Let Me Speak Freely? A Study on the Impact of Format Restrictions on Performance of Large Language Models*, EMNLP 2024 Industry Track, pp.1218–1236
（aclanthology.org/2024.emnlp-industry.91）。
原文：*"we observe a significant decline in LLMs' reasoning abilities under format restrictions"*、*"stricter format constraints generally lead to greater performance degradation in reasoning tasks"*。
即：JSON/XML 这种格式约束**会掉分，约束越严掉得越多**。

**[已读原文]** OpenAI Structured Outputs 文档只承诺"输出符合 schema"，不承诺语义正确。
**[二手引用]** vLLM 论坛（2025-08、2026-07 两帖）：xgrammar / guidance 比 outlines 的首 token 延迟与吞吐明显更好 —— 换后端是性能问题，不是正确性问题。

**本机实测对应**：`response_format: json_object` 把 JSON 合法率做到 100%，语义照样错——
68 条里 1 条 `valence=3`（契约 −2..2）、0.8B 的 12 类标签只用了 9 类、44% 的输出挤在"被敷衍/被拒绝"。
约束解码保证的是"能解析"，不是"判对了"。

**落地**：
1. 闭集字段（tag）**只给 enum**，不给自然语言描述让模型自己归纳；能上 grammar 就别只靠 prompt。
2. **数值不要给区间，给档位**：`-2|-1|0|1|2` 五个 token，比"−2..2 的浮点"少一类失败（本机 0.8B 实际只吐 6 个值，其中 ±0.5 占 65%——它本来就是离散的，不如把契约说成离散）。
3. 服务端不支持 schema 就在**代码侧 clamp + 越界重试一次**，并且把"越界"计入失败率（现在是静默接受）。

## 二、弃权：不要问模型"你有多确定"，要问它"再答一遍还一样吗"

**[已读原文]** Xiong et al., *Can LLMs Express Their Uncertainty?*, ICLR 2024（arXiv 2306.13063）。
原句要点：*"LLMs, when verbalizing their confidence, tend to be overconfident"*；
*"Consistency among multiple responses is more effective in improving failure prediction and calibration compared to verbalized confidence"*；
黑盒法与白盒法的 AUROC 差距很窄（0.522 vs 0.605）。

**本机实测对应**：那条 certainty 字段完全没用——≥0.9 组方向 75%、0.8 组 71%、<0.8 组 100%，单调性不成立。和上面这篇的结论一致：**自报置信度不可当闸门。**

**[已读摘要]** Abbasi Yadkori et al., *Mitigating LLM Hallucinations via Conformal Abstention*, arXiv 2405.01563：
用"多次采样 + 一致性"当置信度，再套 conformal prediction，得到**分布无关的错误率上界**（abstention rate 与 error rate 都有保证）。
**[已读摘要]** Farquhar et al., *Detecting hallucinations in LLMs using semantic entropy*, Nature 630, 625–630 (2024)：把多次采样按语义聚类，用语义熵当不确定性。

**关键反例（我们自己的）**：5 票多数投票**更差**（0.75/0.667 vs 泄漏版的 0.917/0.833），因为错误是**系统性**的——"中性→被敷衍"5 票全错。
所以口径要分开：
- **一致性用于"弃权"**（几次采样不一致 → 这轮不写状态），这时系统性错误也会表现为"一致地错"，救不了；
- **一致性不能用于"取多数"**，系统性偏差会被投票放大成确定性。

**落地**：把"不确定/中性"做成**显式动作**（abstain 位），触发条件是采样不一致或与主模型自评冲突，
而不是模型自报的 0.9。要给出可承诺的错误率，就得有校准集 → 用真实 `conversation_log` 建（这也是后面微调的前置）。

## 三、顺序/位置偏差：模型侧消不掉，只能外置对称化

**[已读摘要]** Schilcher et al., *Characterizing Positional Bias in LLMs: A Multi-Model Evaluation of Prompt Order Effects*, EMNLP 2025 Findings（2025.findings-emnlp.1124）：
任务项在 prompt 里的排列位置会影响输出结构、连贯性，部分模型会重排或漏项。
**[二手引用，未核原文]** *Position Bias in Ordinal Classification: A Systematic Evaluation*（arXiv 2608.08869）：序数分类的预测依赖**选项顺序与标识符**。

**本机实测对应**：同一输入只把输出字段顺序从 `dims→tag` 改成 `tag→dims`，0.8B 有 **2/10 方向、3/10 标签**变了；
API 模型 10/10 不变。也就是说这是**小模型的容量问题**，但只要还在用小模型就必须防。

**落地**：
1. **字段顺序与选项顺序钉死**，写进契约文档，任何人不要再调；
2. 贵的判定做**双向跑**（顺序 A / 顺序 B 各一次，一致才接受，不一致弃权）——这就是位置偏差的标准对称化；
3. 对这一层不要指望 prompt 解决：文献里位置偏差是系统性的，不是提示词没写好。

## 四、状态机：模型只能进观测项，不能进转移函数

**[已读摘要]** *Learning POMDP World Models from Observations with Language-Model Priors*（NeurIPS 2026 poster 155829）；
**[已读摘要]** *From Tokens to Latent States: Leveraging Pre-trained Language Models for Improving Partially Observable RL*（AAAI 2026, ojs.aaai.org/39465）。
共同形状：语言模型提供**观测/先验**，信念更新与决策另有机制。POMDP 的正确定位是 `P(o | s)`，不是 `s' = f(s)`。

**生产工程侧 [已读原文片段]**：
- LangGraph 类的"图是代码、LLM 只在节点里填槽"：节点接收 Pydantic state 返回**部分更新**，条件边是纯函数；
  置信度不足时路由到 clarification 节点而不是硬判（theneuralbase.com/agent-patterns/learn/intermediate/deterministic-control-flow/、
  github.com/ExplorePrabuRamaraj/production-ai-engineering-playbook W1D6）。
- 上一轮调研已记录的情感引擎（LIA / Murmur / bhava）：动力学全是纯计算，模型只给 appraisal 向量；Murmur 的"单一写入闸"。

**本机实测对应**：把"她当前的状态"以一行显式事实注入 prompt，并明确要求"判定要受它影响"——
API 模型 **4/4** 判定随状态移动（2/4 方向翻转）；0.8B 只有 **1/4**。
另一种注入方式（把前几轮原文塞进 messages，不改契约）**两个模型都不动**，因为 rubric 写的是"读一轮对话"——
**是契约禁止了状态，不是模型不会看上下文。** 这条很关键：想让它条件化，就得改契约并显式给状态摘要，别塞原始历史。

**落地**：
1. `next = transition(prev, delta, dt)` 纯函数 + 进入/退出**双阈值** + 最小停留 + 冷却（控制论里的 deadband / Schmitt trigger；情感计算的 hysteresis 也有先例：qu3ry.net 的 affective-state 系列、老年人情感计算 hysteresis 论文 [二手]）；
2. 注入只给**事实 + 触发原句**，不给命令；
3. 离散状态由连续量**派生**，不另存一份真相。

## 五、多传感器：谁主、谁兜、谁弃权

**[二手引用，未核原文]** learning-to-defer / selective classification 这条线（IEEE *Learning to Decide When Not to Decide: Coverage-Constrained Selective Classification with Abstention*；NeurIPS 2025 *Selective Omniprediction and Fair Abstention*）：
分类器可以不预测，用覆盖率换准确率，阈值由部署方按成本定。
**[二手引用，未核原文]** PoLL / panel-of-LLM-evaluators（Verga et al. 2024，在 arXiv 2602.16610 里被引）：多评委面板优于单一大评委。

**本机实测对应（同契约、同探针）**：

| | 0.8B(NPU) | API deepseek-v4-1-flash |
|---|---|---|
| 干净留出集 方向/标签 | 0.60 / 0.45 | **0.90 / 0.90** |
| 与自身标签矛盾 | 3/20 | 0/20 |
| 会判"中性" | 0/68 | 会（2/20） |
| 同义三说法 | 0.75 | 0.958 |
| 状态注入生效 | 1/4 | 4/4 |
| 字段换序后判定不变 | 8/10 | 10/10 |
| 延迟 p50 | 1.55 s | 2.35 s（含 75–200 reasoning token） |
| 边际成本 | 0（2.1 GB 常驻） | 每次 API 计费 + 对话内容出本机 |
| 失败率 | 0/100 | 0/100（12-shot，`max_tokens` 必须 ≥600，否则被 reasoning 吃光） |

**API 也不是白给**：zero-shot（去掉 12 个示例）方向掉到 0.737/0.70，但 prompt 从 1259 token → 358 token。
也就是说示例在云端模型上仍值 ~3 条准确率，得按"每轮都跑 vs 只在边界跑"来算账。

---

## 六、对这套系统的结论（可执行）

1. **传感器分层**：主传感器＝主模型自评（0 额外调用、+25 output token）；本地 0.8B **只取方向**（1.55 s / 0 成本 / 隐私本地）；
   冲突或状态边界时才请 API（4/4 能吃到状态、0.90/0.90）。
2. **契约**：只输出 `{"valence": 档位, "abstain": bool}`；tag 降级为解释文案，**不参与转移**；数值给档位不给区间；代码侧 clamp。
3. **弃权**：采样一致性 / 与自评冲突 → abstain，按 0 处理；不要用模型自报 certainty。
4. **对称化**：字段与选项顺序钉死；边界判定双向跑、不一致就弃权。
5. **状态**：确定性纯函数 + 双阈值 + 最小停留 + 单一写入闸；状态以一行事实注入（不是塞原始历史），且契约要明写"受它影响"。
6. **校准**：用真实 `conversation_log` 建标注集 → 得到可承诺的错误率（conformal 阈值），同时是微调的前置。
