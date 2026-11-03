# 心灵传感器升级：小模型与工程证据

2026-10-30。为 `psyche-report-2026-10-30.md` 的外部证据核验与工程升级建议。已读取公开论文页/全文与 GitHub issue；社区 issue 是单个环境的使用者报告，不按论文级证据处理。结论以本机同一评测的直接结果为准，外部研究用于选择要比较的方案、设计评测和限定推论。

## 先校正报告中的外推

- **约束输出的风险有依据，具体掉分幅度仍是本机结果。** Tam et al. 在 EMNLP 2024 Industry Track 研究格式约束与多项 LLM 推理/知识任务，摘要报告格式限制显著降低推理表现，约束更严通常退化更大；这不是“JSON 对所有分类任务都掉分”的普遍定律，更不能替代本机 VAL 与旧契约的配对 A/B。Ray 的 *The Constraint Tax*（2026-05 arXiv v1）报告 15,000 次生成中硬 schema 把有效率从 61.5% 提到 100%，但正确率从 19.7% 降至 11.0%；其 calendar tool-call 受控类比中，prompt-only JSON 执行正确率 91.5%，硬约束为 48%，两者格式有效率都 100%。论文明确说合成任务是推理压力测试、calendar 是受控类比，扩展接口结果样本较少，属于设计证据；它不是 FLM/NPU 上同一分类任务的复现。报告的本机 36 条配对实验才是新契约更快且分数略高的直接证据。
- **`reason free, constrain late` 不等于给 0.8B 加 CoT。** Ray 讨论的是在需要中间推理时，减少答案阶段的硬约束、延后打包；不能由此推出“先让小模型自由思考会更准”。本机已经测到自由推理提示更差，应维持这个本地结论。当前任务只需要一个离散类别，首选测试短、无 rationale 的分类输出；如要试“自由判定再打包”，需单独配对评测，且打包阶段不得重新推断类别。
- **自报 certainty 不该直接做闸门，但一致性也不是可信置信度。** Xiong et al. (ICLR 2024) 发现模型自报置信度容易过度自信；他们测试的一致性与聚合方法可在部分任务帮助校准/失败预测，但摘要特别指出没有任何一种方法在所有任务上一贯胜出，困难任务仍差。因此此文不支持“多采样普遍比自报 confidence 强”的无条件规则。相同 0.8B、相同提示的重复采样可能系统性一致地错，且增加延迟。报告里的 5 票探针只能说明这份小样本里多数票没有修复错误，不能一般化为所有投票方案都更差。
- **Conformal 不是自动兑现的生产错误率保证。** Abbasi Yadkori et al. 的 conformal abstention 用校准数据为特定非一致性分数构造拒答策略，并在可交换性等条件下给统计保证；不是仅凭多次采样一致就有上界。真实对话按用户/时间连续且会漂移，随机拆分消息可能泄漏同一个人的语气。需要按用户/会话及时间留出，按目标覆盖率报告风险，并监控漂移；否则只把阈值称作经验校准。
- **状态注入 4/4 是提示词敏感性信号，不是正确性证据。** 明写“受当前状态影响”能使 API 的输出移动，说明契约与摘要设计重要；4 个配对用例不足以证明方向移动符合心理构念。把模型自己的旧状态再次送回去还可能形成确认偏差与自我强化。测量时应区分“本轮表达/事件 appraisal”与“跨轮状态”；对状态条件化的问题，状态只提供有来源、有时间范围的事实，不要让它覆盖本轮反证。
- **不要把中性等同于语法规则或弃权。** GoEmotions 用人类标注的 27 类情绪加 neutral，显示类别边界/多标签本身就是标注任务，不等于 `?` 或短句可确定判中性。信息问句可能带焦虑，单字“好”可能表示不耐烦。对于没有足够证据的输入，应有 `unknown/abstain`，并让状态机“不更新”；只有校准标签明确是中性时才给 neutral。规则可以可靠地跳过纯协议/空输入，但不要靠表面句式给情绪标注。
- **SDT 的 c 不能直接变成 `delta *= 0.6`。** 判据 `c=-0.51` 表示在这批二分类材料及其阈值下有偏向；它不是原始输出量纲的缩放系数。需要在未参与拟合的样本上用阈值移动/校准曲线重估决策边界，并按正负类别的误报成本选择 operating point。若传感器返回的是五档 ordinal 值，更不能未经验证把档位当作等距比例尺。

## 针对当前系统的工程路线

1. **先锁定可标注的目标。** 标注“这轮互动文本表现出的 appraisal/方向/证据充分度”，不要把它写成读取角色真实内心。给 neutral 和 unknown 分开定义；对话中同时出现正负证据时允许混合/弃权。把标签指南、正反例和歧义裁定写成版本化 rubric。GoEmotions 可借鉴细粒度标签和 neutral 的标注形式，但 Reddit 群体标签不直接迁移到 Castalia 的互动语境。
2. **以判别式文本分类器作认真基线。** 这个输出只有小型闭集标签，不需要自回归模型生成 why/tag/JSON。建议在同一数据上比 majority、简单词典/规则、MiniLM/DistilBERT + 线性头、SetFit、当前 VAL 0.8B；如果有效标签很少，SetFit 用文本对比微调句向量再训分类头，比手工持续调 prompt 更容易复现。DistilBERT/SetFit 的论文证明了压缩 encoder 与少样本句向量分类的可行路线，但没有证明它们在本机 NPU 或本领域必胜；先在 CPU/ONNX 跑出质量—延迟—内存曲线，再决定硬件部署。
3. **把当前 0.8B 当低成本候选，不当真值。** 新 VAL 短输出值得保留为基线；精确验证 `VAL=-2|-1|0|1|2`，值域外或无法解析应记为 invalid/abstain，而不是 clamp 成有效强信号。Clamp 适合防程序越界，不能把模型越界的证据错误静默变成 `2`。另行记录 parse validity、方向/标签准确度、宏平均 F1、每类混淆、平衡准确率、覆盖率—错误率、p50/p95 延迟、超时和峰值内存。
4. **用校准风险路由 API，不用未经验证的 certainty。** FrugalGPT 与 RouteLLM 展示了以级联/路由在价格和质量间取舍的方法；RouteLLM 的路由器依赖偏好数据，不是一个通用 confidence 阈值。对本系统先做离线路由回放：满足高风险条件（模型间分歧、未见话题、边界标签、传感器 invalid）才路由；分别比较固定比例和达到同一覆盖率的错误率、成本、p95、隐私暴露，再 shadow 验证。主模型自评也是新候选传感器，必须证明它对目标标签有增量，不因为它来自生成模型就视作已校准。
5. **动力学继续由代码持有单一真相。** LLM 输出观测/候选 appraisal；状态更新由纯函数消费上一状态、可信度/弃权、时间衰减及明确事件。边界进入/退出用单独阈值并对停留时间做离线敏感性分析。对 abstain 应“不新增证据”，不可当负向、不可假装 neutral。加状态注入前先做同句 × 状态 × 反事实证据的成对测试，检查状态是否只在语境确实相关时改变判定。
6. **训练集拆分要匹配部署形态。** 建议以用户/会话分组，另加严格时间留出；同义改写、连续轮次和 few-shot 示例不能跨 train/test。两名标注者对歧义样本独立标注并复核分歧；报告人类一致性、各类别召回率和 abstain 覆盖率。现有 20 条 clean holdout 和 4 对状态探针适合发现明显故障，不适合精调校准参数或宣称稳定增益。

## 可直接核验的来源

论文与数据集：

1. Tam et al., [Let Me Speak Freely?](https://aclanthology.org/2024.emnlp-industry.91/), EMNLP 2024 Industry Track。格式约束与 LLM 推理任务的实证研究；外推到简单分类时要谨慎。
2. Ray, [The Constraint Tax](https://arxiv.org/abs/2605.26128), arXiv:2605.26128 v1, 2026-05-20。报告中 61.5→100、19.7→11.0 和 calendar 类比数据可在摘要/全文核对；预印本，作者自己限定了合成推理任务和小样本扩展实验的外部效度。
3. Tunstall et al., [Efficient Few-Shot Learning Without Prompts (SetFit)](https://arxiv.org/abs/2209.11055), 2022。展示句向量对比微调 + 轻量分类头的 few-shot 方法；需要本域标签与部署基准。
4. Sanh et al., [DistilBERT](https://arxiv.org/abs/1910.01108), 2019。展示蒸馏 encoder 的模型压缩路线；通用 benchmark 的质量/尺寸结果不能当作当前硬件实测。
5. Demszky et al., [GoEmotions: A Dataset of Fine-Grained Emotions](https://aclanthology.org/2020.acl-main.372/), ACL 2020。约 58k Reddit 评论、27 种情绪与 neutral 标签的人类标注数据；可参考标签/标注问题，域与任务均不同。
6. Xiong et al., [Can LLMs Express Their Uncertainty?](https://arxiv.org/abs/2306.13063), ICLR 2024。测 verbalized confidence、采样和一致性；不支持把一致性当普遍有效的置信度。
7. Abbasi Yadkori et al., [Mitigating LLM Hallucinations via Conformal Abstention](https://arxiv.org/abs/2405.01563), arXiv:2405.01563。基于校准集和特定相似度/一致性分数构造 conformal abstention；保证依赖可交换性及方法前提。
8. Chen et al., [FrugalGPT](https://arxiv.org/abs/2305.05176), 2023。研究模型级联节省 API 成本；说明路由值得评测，不给当前传感器现成阈值。
9. Ong et al., [RouteLLM](https://arxiv.org/abs/2406.18665), 2024/2025。用偏好数据训练强/弱模型路由器；数据、模型对和目标不同，不能直接复用成基于自报置信度的阈值。
10. Shi et al., [Large Language Models Can Be Easily Distracted by Irrelevant Context](https://arxiv.org/abs/2302.00093), 2023。数学任务上测无关上下文干扰；支持测试摘要与历史输入，不能证明任何对话状态摘要都会更准。
11. Greshake et al., [Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection](https://arxiv.org/abs/2302.12173), 2023。支持把被分类的原文视作不可信数据并做注入/对抗性探针；这是安全风险类比，不是情绪分类准确率证据。
12. Kuncheva & Whitaker, [Measures of Diversity in Classifier Ensembles and Their Relationship with the Ensemble Accuracy](https://doi.org/10.1023/A:1022859003006), Machine Learning 51, 2003。集成收益与误差/多样性关系复杂；相同模型的相关错误不能靠多数票自动消除。

社区工程讨论（经验性证据）：

13. vLLM [issue #62442](https://github.com/vllm-project/vllm/issues/62442), 2026-10-19，开放的结构化输出解码吞吐回归报告。报告者在自己的工作负载中给出 v0.21 到 v0.24/v0.28 的吞吐对比并指向 grammar bitmask staging；不能推广到 FLM，但提醒约束解码开销属于 serving backend，要测目标栈的端到端延迟。
14. AMD [RyzenAI-SW issue #398](https://github.com/amd/RyzenAI-SW/issues/398), 2026-08-30，开放的 VitisAI EP / XDNA2 长推理 TDR 用户报告，列了驱动、软件版本、可复现步骤和系统影响。它报告的是特定 VitisAI workload 且推理本身未失败，不等同于本项目 ERT_CMD_STATE_TIMEOUT；可作为 NPU 生产测试要包含长时运行、系统内存和错误恢复的理由。

## 对原报告建议的处理

**保留并推进：** VAL 短契约作为当前基线；输出语法/值域单独计错误；标签由代码派生；状态机纯函数；建立按会话隔离的校准集；按质量—成本做 API 路由实验；给 0.8B 增加中性与 abstain 的明确目标后再测。

**降级为待验证假设：** “中性用确定性规则给”只适用于明确可判定的协议类输入；“delta 乘 0.6”不能从 SDT `c` 直接推出；“主模型自评为主”必须先测增量与校准；“边界才走 API”需要风险—覆盖率回放；多次采样只可作为一个候选拒答信号，不能假设能抓住一致性系统错误。

**先不要把这些当结论：** 当前 4/4 状态注入、20 条留出集差异、36 条新契约提升、NPU 外部 issue 都不能证明跨用户、跨时间或跨版本的稳定性能。先扩大有代表性的配对留出集，再做状态阈值、LoRA 和线上消费者集成。
