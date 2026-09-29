# Superseded Heavy Hierarchical CFG

## 归档结论

“只要把 Flat 改成 Hierarchical，就会自动降低 IFDS 成本”这一假设不成立。原始 M1 已被 compact dispatcher 版本替代，不应继续作为主线实现或性能证据。

## 当时的做法

原始 M1 为每个 Ability、Component 和 callback 生成较重的条件分派结构。虽然 ownership scope 删除了一些全局直接转移，但新增的条件节点和循环节点会产生额外 path edge。

## 负向证据

- 48 项资源分析：Flat → 原始 M1 的 IFDS 时间仅 -0.27%，`processedEdges` 反而 +0.07%；变化与 Scene 构建波动同量级，不能归因于模型。
- 4 项空指针补充实验：IFDS 34.042 s → 35.001 s（+2.82%），`processedEdges` +0.58%，四个项目均未变快。
- 两组诊断集合一致，但真实应用没有 ground truth，不能据此声称精度等价。

## 为什么失败

hierarchy 删除的传播不足以抵消 CFG 表达开销。尤其在单 Ability 或大量 callback 处于 fallback 时，分层结构几乎没有 transition 可裁剪，却仍要支付额外节点成本。

## 已吸收的经验

1. 必须把“结构约束”和“CFG 表达方式”作为两个变量分开。
2. Flat 公平基线必须共享 compact dispatcher、Ability pruning 和 empty-scope removal。
3. 性能归因优先使用 blocks、edges、`processedEdges`、`propagationAttempts`，单轮时间只作辅助。
4. 新 hierarchy 设计只有在能直接记录被删除 transition 时才进入真实应用实验。

后续正向方案见 [Lifecycle CFG Optimizations](../method/lifecycle-cfg-optimizations.md)。
