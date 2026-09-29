# Research State

## Main Goal

在不丢失合法生命周期路径和诊断语义的前提下，用可解释的 Ability/Page ownership 约束降低生命周期 CFG 的过近似。

## Current Questions

1. 统一模型能否在带非空 diagnostics oracle 的 Page 场景中减少 false positive，且不丢失合法路径？
2. 哪类真实应用的 Page owner 与静态路由覆盖足以让 pruning 抵消额外 scope CFG？
3. 局部 Page 状态（show/hide、back stack）能否进一步减少过近似而不引入漏报？

## Active Hypothesis

Ability owner 是外层边界，Page owner 是内层 callback scope。唯一归属的 callback 只在自己的 Page 中循环，静态 route 才进入目标 Page；未知或歧义信息进入保守 fallback。该方法首先追求结构精度，不预设性能收益。

## Next Experiment

暂无。K-bound screening 已完成并停止该方向；下一项实验需根据 Current Questions 重新选择。

## Latest Finding

- [K-bound screening](uncategorized/k-bound-screening.md)：四项目 16 次运行全部成功，
  K=1 的 `processedEdges` / `propagationAttempts` 仅下降 1.65% / 2.43%，且两个
  项目完全不降；K=2/3 因复制 CFG 反而使 workload 显著高于 K=∞。所有 K 的
  diagnostics exact set 与基线一致。本方向停止。
- `hierarchical` 是唯一 canonical 生命周期结构模型；它在同一实现中融合 Ability ownership、Page scope 和 compact dispatcher。未知归属与动态目标继续走保守 fallback。
- controlled Page fixture 保留全部 4 个 callback；16 个候选有序 callback 对保留 11、删除 5，并保留显式 Home → Details route。
- 当前 fixture 的 diagnostics 仍为空，因此非空 precision/recall oracle 仍是尚未完成的问题。
- 四个真实项目的 Page-local opportunity profiling 中，foreign Page synthetic invocation 只占 lifecycle processed edges 的 0.1614%、propagation attempts 的 0.1179%。该方向已停止，profiling instrumentation 已删除，结论归档。
- compact dispatcher 仍是归因最明确的结构优化；Page-local fact bypass 不再是当前优化候选。

## Research Mainline

- [Unified hierarchical lifecycle model](method/hierarchical-lifecycle.md)
- [Lifecycle CFG optimizations](method/lifecycle-cfg-optimizations.md)

## Parking Lot

- Page-local state machine：`onPageShow` / `onPageHide`、`router.back` 与 NavPathStack。
- 动态 callback / route resolution：`@Watch`、Promise/await、动态 URL。
- 多轮交替实验与方差分析。
