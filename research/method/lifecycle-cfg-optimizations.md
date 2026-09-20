# Lifecycle CFG Optimizations

## 状态

当前研究主线。compact dispatcher 有清晰正向证据；Ability reachability pruning 有小幅正向证据。

## 方法动机

早期 Hierarchical 模型虽然增加了结构约束，却用很重的条件链表达 callback dispatcher，新增 CFG 节点抵消了 hierarchy 的收益。这里的目标是保持事件集合和 scope 语义不变，只减少 DummyMain 的结构放大。

## 核心机制

### Compact dispatcher

一个 scope head 直接连接所有可调用 invocation block；每个 invocation 执行后回到同一个 head。它替代“每个 callback 一个条件节点并串联”的表达，保留非确定选择语义，但显著减少 block、edge 和中间传播状态。

### Conservative Ability pruning

从 entry Ability 出发，只保留静态 `startAbility` 可达闭包。出现以下任一情况时关闭裁剪并保守保留：

- 缺少 entry Ability；
- `startAbility` 目标无法解析；
- 含 `startAbility` 的 Component 没有可解析 owner。

`ohosTest` 和 `src/test` Ability 在公共收集阶段统一过滤，Flat 与 Hierarchical 使用相同规则；它不是 M1 的专属收益来源。

## 实现方式

- compact dispatcher：[`HierarchicalLifecycleModelCreator.ts`](../../src/lifecycle/HierarchicalLifecycleModelCreator.ts) 与 [`FlatLifecycleModelCreator.ts`](../../src/lifecycle/FlatLifecycleModelCreator.ts)
- 可达 Ability 与保守退化：[`LifecycleModelCreator.ts`](../../src/lifecycle/LifecycleModelCreator.ts)、[`AbilityCollector.ts`](../../src/lifecycle/AbilityCollector.ts)
- 优化开关：`LifecycleModelConfig.optimizations`，可分别关闭 `compactDispatcher`、`pruneUnreachableAbilities`。
- `opt-flat` 复用相同通用优化，作为隔离 hierarchy 独立贡献的基线。

## 关键实验

4 个真实应用的 M1 消融中，关闭 compact dispatcher 后：

| 指标 | M1 Full | No Compact | 变化 |
| --- | ---: | ---: | ---: |
| DummyMain blocks | 1,636 | 3,245 | +98.35% |
| DummyMain edges | 3,252 | 6,470 | +98.95% |
| lifecycle `processedEdges` | 1,496,415 | 1,729,246 | +15.56% |
| `propagationAttempts` | 2,047,128 | 2,512,790 | +22.75% |
| lifecycle IFDS | 20.055 s | 26.950 s | +34.38% |

五个消融配置均完成 4/4 项目，诊断集合相同。结构计数、传播计数和时间同向变化，compact dispatcher 是当前归因最明确的优化。

关闭 Ability pruning 会额外增加 7 个 block、14 条 CFG edge、2,330 条 lifecycle path edge 和 3,733 次 propagation attempt。收益较小，但方向由确定性计数支持。

作为组合效果，优化后的 Hierarchical 在 47 个共同成功真实应用上相对旧 Flat：IFDS 累计时间 -20.00%，`processedEdges` -11.37%，诊断集合一致。这个结果包含 compact dispatcher、Ability pruning 和 hierarchy，不能用来声称 hierarchy 单独贡献 20%。

原始数据：[`out/rq1.5/m1-full.json`](../../out/rq1.5/m1-full.json)、[`out/rq1.5/m1-no-compact.json`](../../out/rq1.5/m1-no-compact.json)、[`out/rq1.5/m1-no-ability-prune.json`](../../out/rq1.5/m1-no-ability-prune.json)、[`out/nullness-m1opt-full48-m0.json`](../../out/nullness-m1opt-full48-m0.json)、[`out/nullness-m1opt-full48-m1.json`](../../out/nullness-m1opt-full48-m1.json)。

## 当前证据

- compact dispatcher：已满足“机制明确、消融正向、语义门一致”，可作为论文方法组成部分。
- Ability pruning：已有小幅正向工作量证据，可作为辅助优化，不应包装成主要贡献。

## 为什么效果较好

IFDS 的成本不仅取决于业务方法数量，也取决于事实需要穿过多少合成控制流节点。compact dispatcher 直接删掉大量只用于表达非确定选择的中间节点，所以在不减少事件的情况下，同时降低 reached statements、path edge 和 propagation attempts；这比仅提升 ownership 覆盖更直接。

## 已知限制

- 所有时间数据均为单轮运行，主要归因依据应是确定性结构和传播计数。
- Ability pruning 只覆盖可静态解析的 `startAbility`，动态路由会触发保守退化。
- 组合实验不能分摊 hierarchy 与各通用优化的贡献；论文中必须同时报告 `opt-flat` 公平基线。
