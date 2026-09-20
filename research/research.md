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

### Non-empty two-Page diagnostics oracle

当前 controlled fixture 没有 nullness source，`opt-flat` 与 `hierarchical`
都返回空 diagnostics。这只证明该 fixture 上没有额外报警，不能证明
Page constraint 减少了 false positive，也不能证明合法污点路径未丢失。

下一步在现有 Home/Details fixture 中加入三类有明确 oracle 的路径：

1. Home 同 Page source → sink：两个模型都必须报警；
2. Home source → Details sink、且无 route：`opt-flat` 报警，`hierarchical`
   必须删除这个非法直连路径；
3. Home route source → Details sink：两个模型都必须保留报警。

验证时同时锁定 callback 集合、穷举 callback ordered pairs 和 diagnostics
source/sink key。只有三类 oracle 都通过，才能回答 Current Question 1。

## Latest Finding

- `hierarchical` 是唯一 canonical 生命周期结构模型；它在同一实现中融合 Ability ownership、Page scope 和 compact dispatcher。未知归属与动态目标继续走保守 fallback。
- controlled Page fixture 保留全部 4 个 callback；16 个候选有序 callback 对保留 11、删除 5，并保留显式 Home → Details route。
- 当前 fixture 的 diagnostics 仍为空，因此尚未建立非空 precision/recall oracle；Next Experiment 保持不变。
- 四个真实项目的 Page-local opportunity profiling 中，foreign Page synthetic invocation 只占 lifecycle processed edges 的 0.1614%、propagation attempts 的 0.1179%。该方向已停止，profiling instrumentation 已删除，结论归档。
- compact dispatcher 仍是归因最明确的结构优化；Page-local fact bypass 不再是当前优化候选。

## Research Mainline

- [Unified hierarchical lifecycle model](method/hierarchical-lifecycle.md)
- [Lifecycle CFG optimizations](method/lifecycle-cfg-optimizations.md)

## Parking Lot

- Page-local state machine：`onPageShow` / `onPageHide`、`router.back` 与 NavPathStack。
- 动态 callback / route resolution：`@Watch`、Promise/await、动态 URL。
- 多轮交替实验与方差分析。
