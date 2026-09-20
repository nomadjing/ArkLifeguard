# Finite Unroll as the Primary Model

## 归档结论

`finite-unroll(K)` 不再作为主研究基线。它保留为兼容模型和未来 K 敏感性消融工具。本条是被否定的实验设计，不是已经完成的负向性能实验。

## 原方案

通过 `maxCallbackIterations=K` 静态展开 lifecycle/callback 分支，并结合 Ability 与 navigation budget 控制分析规模。当前 `bounded-unroll` 默认 `K=1` 时生成有限 DAG。

## 为什么退出主线

改变 K 会同时改变两件事：

1. 可表达的重复生命周期行为；
2. DummyMain CFG 的 block/edge 数量。

因此直接比较不同 K 的耗时，无法判断收益来自“删除不可能顺序”还是“单纯缩小 CFG”。它也不能替代 clean cyclic baseline 或状态感知模型。

此外，不应把无界精确次数加入 IFDS fact 的 `equals/hashCode`；那会人为扩大事实域，把生命周期控制问题混入数据流事实身份。

## 已吸收的经验

- 顺序约束实验应固定事件集、实例抽象、fact domain 和 solver，只改变允许的 transition。
- 如果将来研究 K，只回答重复敏感性：比较 `K=1,2,3,5,∞`，报告结果集合 retention，而不是把它称为 ground-truth recall。
- state-aware M2 与 finite-unroll 是不同方向；前者仍在 `research.md` 的 Parking Lot，尚未实现和验证。

## 重新启用条件

先有稳定的 cyclic baseline 和规范化结果集合，再把 K 当作独立消融变量；否则不再为该方向运行真实应用大实验。
