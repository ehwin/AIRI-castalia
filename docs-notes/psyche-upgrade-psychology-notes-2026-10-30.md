# 心理传感器升级：心理学与测量边界

整理日期：2026-10-30。本文是对 `psyche-report-2026-10-30.md` 的心理学与心理测量补充，不是临床评估，也不把对话分类结果当成角色或用户的客观内心事实。文献 DOI/元数据通过 Crossref 或 arXiv API 核对；应用到本地模型的结论仍需在项目数据上验证。

## 先把测量对象拆开

当前的 `VAL` 是从一条对话文本推断出的情感线索或互动事件评价，不等同于“她此刻真实感到什么”。建议数据模型明确区分：

1. **可观察事件**：原句、说话者/目标、轮次、可由日志验证的行为（例如隔了几轮未回复）。
2. **事件评价（appraisal）**：该事件对角色当前目标是否相关、是否有利、是否可控等解释。它是模型对文本的推断，必须保留证据跨度和不确定性。
3. **核心情感 / 心境状态**：角色随时间变化的隐状态。可以用连续 valence 与 arousal 表示，并由代码结合上一状态、事件评价和时间间隔更新。
4. **表达与行为**：角色生成的语气、台词和行动。表达可能是礼貌、讽刺、扮演或策略，不能直接反推内在状态。
5. **人格基线**：稳定的响应倾向/基线参数，不应由一两条台词写入或覆盖。

Russell 的核心情感框架把 valence 与 arousal 作为基本的、连续变化的核心情感；离散情绪词是对核心情感与情境概念的进一步建构。Scherer 的 Component Process Model 则把相关性、目标一致性、因果归属、控制潜力等评价过程与情绪反应联系起来。它们支持把“事件评价”和“状态更新”拆开，但并未证明一个小型文本分类器能直接读取角色的真实内在状态。

Fleeson 将人格特质视为情境状态分布的稳定差异。对这个角色系统的工程含义是：把人格作为长期基线/参数，把 mood 作为可恢复的短期偏移；不要把每次 `VAL` 或情绪标签当成新的人格事实。

## 中性与未知必须分开

`neutral` 是一个关于观测单位的判断：在当前任务定义下，有证据支持情感强度位于校准后的近零区间。`unknown/abstain` 是证据不足、语义歧义、目标不清、上下文缺失或模型冲突。二者都不等于“模型没找到负面词”。

因此，不要把“问句”“短回复”“没有指向她的评价”直接规则化为中性：问题可能是挖苦或责备，短句也可能带明显态度；而“没有可见情绪”也不证明说话者没有情绪。先定义被测对象究竟是**文本表达的情绪**还是**角色对事件的评价**，再标注近零范围和可拒判范围。给输出保留至少三个结果：`negative / neutral / positive`，另加一个正交的 `abstain` 或 `insufficient_evidence` 标记；如果解析失败，失败不是中性。

报告中 0.8B 在两种契约下均未选 `VAL=0`，足以支持“当前契约不能可靠地区分中性”的工程结论，但不能单凭 36 条/68 条就证明某种确定性中性规则正确。纯信息问句、无指向评价等规则应先作为可审计的候选规则，以独立标注集测精确率、覆盖率和误伤，而不是直接把所有匹配项改写成 0。

## 状态注入的证据强度

把“她当前紧绷，连续三轮被冷落”显式写进提示后 API 4/4 跟着动，说明该模型对明确状态提示有响应；它没有证明这项状态是真的，也没有证明状态注入提升了正确率。`n=4` 太小，且让模型知道预设答案会产生确认偏差。若前一轮分类器的估计被反复作为事实喂回去，错误可能形成自我强化的反馈环。

建议把状态写为**有来源和时间戳的先验估计**，不是事实命令；提示里分隔“日志观察”“上一状态估计”和“本轮新证据”，要求本轮只判断新证据的增量。评估时随机/平衡有无状态提示，使用不知道提示条件的标注者给金标；分别报告对当前事件的识别和最终状态轨迹，不能只测模型是否顺从注入。

## 动态与校准

Kuppens、Oravecz 与 Tuerlinckx 对情感时间序列中的个体差异建模，研究对象是重复测量的体验数据。它支持考虑惯性/变化速度因人而异，不支持从这批短文本探针直接抄一个通用“持续几轮/几小时”的数值。可从简单、可回放的更新开始：事件评价形成增量，状态随实际 `dt` 向人格基线衰减，再由单一纯函数更新；用轨迹测试检查无事件时回归基线、正负事件不被同一条错误重复累加、时间跳跃行为可预测。

SDT 中 `d'` 表示给定分布假设下的区分能力，`c` 表示判定标准/偏向；它们不是同一个准确率指标。若“冷”定义为 signal，`c < 0` 可表示判为 signal 的标准较宽松。此解释依赖类别编码、公式和采样设计。报告摘要没有逐条真值、命中/虚报计数、零命中修正和区间估计，故这里无法独立复核 1.80/−0.51 等数值。61 条估计的抽样不确定性也应报告。

若要改判定偏置，优先在独立校准集上移动分类阈值或做适当的概率校准，再在另一个留出集验证；不要把 `c=-0.51` 直接转成 `delta × 0.6`。判据是阈值，不是效应幅度缩放。生成模型自报的 `certainty` 也不自动是概率；要用真实正确率做可靠性图、Brier score/对数损失等验证。Conformal abstention 可以在可交换校准样本假设下约束边际错误/覆盖指标，但不能保证每个类别或每个对话都同样可靠；时间相关轮次和分布漂移会破坏朴素交换性。应按对话/会话划分数据，避免同一角色、模板或同一对话泄漏到校准与测试两边。

## 报告引用的心理学说法需要收窄

- Baumeister 等人的综述题名为 “Bad Is Stronger than Good”，归纳了多个领域的负面优势现象；它不是“所有语言情绪应给负面乘 2”的通用参数。
- Kahneman 与 Tversky 的前景理论讨论带风险的收益/损失选择与损失厌恶。决策任务里的损失权重不能直接当作对话情绪 valence 的权重。
- “峰终规则”研究的是对过去体验的回顾性评价等特定测量，不足以规定一个在线角色状态机应如何保留或衰减每轮情绪。
- 情绪分化研究强调区分具体负面体验可能与适应有关，但不能据此要求一个低成本传感器每轮输出细粒度情绪标签；先证明标签在人类标注中一致且能改变产品行为。
- 关于面部动作与情绪推断的综述说明可观察表达与情绪推断之间的映射有限。它研究的是面部动作，不是文本，因此只能作类比警示，不能直接当作文本分类的误差率证据。

## 建议的升级次序

1. **先定目标与标注规范**：明确 `VAL` 描述的是句子情绪、事件 appraisal，还是角色状态；同一测试集双人标注并裁决，保留“无法判断”。
2. **隔离传感器与状态机**：传感器输出可审计的事件增量、目标与证据；纯函数做惯性、衰减、基线回归和迟滞。状态不由模型标签直接覆盖。
3. **显式处理拒判**：把 neutral、unknown、解析失败分开计数。以覆盖率-错误率曲线决定何时使用 0.8B、主模型或 API；未校准前不要承诺 conformal 错误率。
4. **重做状态注入实验**：扩大样本、随机化提示条件、平衡正负状态，并用盲标金标检查准确率是否上升，而不只是输出是否按提示移动。
5. **校准阈值而非凭感觉缩放**：先锁定一批按会话划分的标注数据，再在独立验证集选择阈值，报告混淆矩阵、置信区间、Brier/reliability 与 abstain 覆盖率；变更数据源后重校准。
6. **最后验证动态参数**：在真实会话轨迹上估计半衰期/惯性，并用合成事件序列做确定性回放。先确保传感器有消费者、每轮确实产生/拒绝增量，再讨论 LoRA 或更大模型。

## 可核对来源

1. Russell, J. A. (2003). “Core affect and the psychological construction of emotion.” *Psychological Review*, 110(1), 145–172. [https://doi.org/10.1037/0033-295X.110.1.145](https://doi.org/10.1037/0033-295X.110.1.145). 支持 valence/arousal 核心情感与离散情绪构建的区分；理论论文，不是对话模型验证。
2. Scherer, K. R. (2009). “The dynamic architecture of emotion: Evidence for the component process model.” *Cognition and Emotion*, 23(7), 1307–1351. [https://doi.org/10.1080/02699930902928969](https://doi.org/10.1080/02699930902928969). 支持事件评价分解和过程模型；不意味着工程系统应逐项模拟所有心理过程。
3. Fleeson, W. (2001). “Toward a structure- and process-integrated view of personality: Traits as density distributions of states.” *Journal of Personality and Social Psychology*, 80(6), 1011–1027. [https://doi.org/10.1037/0022-3514.80.6.1011](https://doi.org/10.1037/0022-3514.80.6.1011). 支持区分稳定特质与情境状态；不是“人格等于状态均值”的唯一理论。
4. Kuppens, P., Oravecz, Z., & Tuerlinckx, F. (2010). “Feelings change: Accounting for individual differences in the temporal dynamics of affect.” *Journal of Personality and Social Psychology*, 99(6), 1042–1060. [https://doi.org/10.1037/a0020962](https://doi.org/10.1037/a0020962). 支持用重复时间序列研究惯性等个体差异；数据是人的体验测量，不能直接给角色设参数。
5. Kashdan, T. B., Barrett, L. F., & McKnight, P. E. (2015). “Unpacking Emotion Differentiation: Transforming Unpleasant Experience by Perceiving Distinctions in Negativity.” *Current Directions in Psychological Science*, 24(1), 10–16. [https://doi.org/10.1177/0963721414550708](https://doi.org/10.1177/0963721414550708). 支持情绪分化作为有意义的个体差异；不证明细粒度自动标签可可靠测出这种能力。
6. Baumeister, R. F., Bratslavsky, E., Finkenauer, C., & Vohs, K. D. (2001). “Bad Is Stronger than Good.” *Review of General Psychology*, 5(4), 323–370. [https://doi.org/10.1037/1089-2680.5.4.323](https://doi.org/10.1037/1089-2680.5.4.323). 是跨领域综述，不能作为固定的 2 倍情绪权重。
7. Kahneman, D., & Tversky, A. (1979). “Prospect Theory: An Analysis of Decision under Risk.” *Econometrica*, 47(2), 263–291. [https://doi.org/10.2307/1914185](https://doi.org/10.2307/1914185). 讨论有风险选择中的损失/收益价值函数；不应外推为文本 valence 校正常数。
8. Barrett, L. F., Adolphs, R., Marsella, S., Martinez, A. M., & Pollak, S. D. (2019). “Emotional Expressions Reconsidered: Challenges to Inferring Emotion From Human Facial Movements.” *Psychological Science in the Public Interest*, 20(1), 1–68. [https://doi.org/10.1177/1529100619832930](https://doi.org/10.1177/1529100619832930). 对面部表情推断做综述；仅用于提醒“表达不等于内在状态”，不直接证明文本输入的表现。
9. Abbasi Yadkori, Y., et al. (2024). “Mitigating LLM Hallucinations via Conformal Abstention.” [arXiv:2405.01563](https://arxiv.org/abs/2405.01563). 提出用采样响应一致性及 conformal abstention 控制生成错误率；其理论保证依赖校准/测试分布假设，研究任务是问答，不是心理分类。

## 核查范围

本次可通过 Crossref API 核对以上 DOI 的题名、作者/年份和期刊元数据，并通过 arXiv API 读取 2405.01563 的摘要。未取得所有论文全文，以上适用范围以摘要、出版元数据及已知论文主题为限；没有对原始数据、附录或在线论坛帖进行独立复核。尤其报告列出的 2026 CPM-MultiAgent 及 `psyche-state-machine-survey.md` 中论坛/项目证据不在本次心理测量核验范围内。
