# Scope-propagation profile（scope 循环迭代 + 跨 scope fact 流动）

## Question

`hierarchical` 生命周期模型把 DummyMain 切成 Ability / Page scope 与 fallback。本实验回答两个
决定"能否利用 scope 结构降低 IFDS 成本"的前置问题：

1. **scope 循环迭代**：fact 是否在 Page scope 内绕圈并产生大量 per-scope 的 fact 变体？
   （若是，scope-aware widening 有收益。）
2. **跨 scope fact 流动**：到达 fallback 分发器与"属于别的 Page"的 fact 有多少？
   （若少，分离式求解 / SCC 分层有收益。）

本实验只做 profiling：新增一个只读 introspection（`getScopeModelInfo()`）和一个独立脚本，
不改 Scene、CFG、flow function、调度或 path-edge 去重；求解语义与正常分析完全一致。

## 实现

- `src/lifecycle/LifecycleTypes.ts`：新增 `ScopeModelInfo` / `PageScopeInfo`。
- `src/lifecycle/LifecycleModelCreator.ts`：新增 `protected scopeModelInfo` 与
  `public getScopeModelInfo()`（非分层模型返回 `undefined`）。
- `src/lifecycle/HierarchicalLifecycleModelCreator.ts`：在 `buildDummyMainCfg()` 里记录
  ability head、每个 Page scope 的 head/eventHead、fallback head/returnHead，以及各 scope
  的合成实例 Local 名。
- `scripts/profile-scope-propagation.ts`：对 DummyMain 主 root 跑生产版
  `NullnessProblem`/`NullnessSolver`（配置与真实应用分析一致），再按 scope 统计
  `solver.getReachedFacts()`。

事实归属（owner）按 fact 的 access-path base 是否落在某个 scope 的合成实例 Local 上划分：
`pageId`（某 Page scope 的实例）、`<fallback>`（fallback 组件实例）、`<other>`
（非页面合成实例，如 `Want`/`WindowStage`/参数等入口创建的全局对象）。

## Configuration

- 日期：2026-09-21；分支：`experiment/scope-profiling`；HEAD：`e383984`
- Node.js：`v22.19.0`；ArkAnalyzer：`1.0.90`；SDK：`sdk/default`
- lifecycle model：`hierarchical`；compact dispatcher / ability pruning / ViewTree：开；inferTypes：开
- 求解范围：DummyMain 主 root（与归档 page-local profile 的 "lifecycle" 口径一致，不含 supplemental roots）
- nullness：maxAccessPathLength 5，maxPropagationDepth 40
- 项目：与归档 page-local profile 相同的 4 个真实应用
- 原始 JSON：`out/scope-profiling/{CoolMallArkTS,harmony-utils,JellyFin_HarmonyOS,jingmo-for-HarmonyOS}.json`

## Results

| 项目 | Page scopes | ability head facts | fallback head facts | 每 page head facts | page-head owner 签名种数 | foreign facts @page heads | facts@fallback owned-by-page |
|---|---:|---:|---:|---:|---:|---:|---:|
| CoolMallArkTS | 1 | 550 | 653 | 653 | **1** | 0（单 scope） | 84 |
| harmony-utils | 60 | 34 | 34 | 34 | **1** | 177 | 3 |
| JellyFin_HarmonyOS | 1 | 12 | 12 | 12 | **1** | 0（单 scope） | 1 |
| jingmo-for-HarmonyOS | 9 | 145 | 154 | 154 | **1** | 32 | 4 |

绝对规模参照（同一 solve）：

| 项目 | DummyMain 非零 fact 总数 | processedEdges | foreign 占 processedEdges |
|---|---:|---:|---:|
| CoolMallArkTS | 226,634 | 313,432 | 0 |
| harmony-utils | 50,645 | 939,756 | 177 / 939,756 = **0.019%** |
| JellyFin_HarmonyOS | 894 | 32,699 | 0 |
| jingmo-for-HarmonyOS | 94,250 | 211,823 | 32 / 211,823 = **0.015%** |

owner 分布（ability / fallback head 一致）：

| 项目 | `<other>` | `<fallback>` | page-owned |
|---|---:|---:|---:|
| CoolMallArkTS | 101 | 370–468 | 79–84（EntryPage） |
| harmony-utils | 30 | 1 | 3 |
| JellyFin_HarmonyOS | 1 | 10 | 1 |
| jingmo-for-HarmonyOS | ~0 | 141–150 | 4 |

## 关键发现：scope 并未切分 fact 空间

**四个项目的所有 Page scope head 都携带完全相同的事实集合**（owner 签名种数恒为 1），且与
ability head / fallback head 相同。也就是说，同一个全局 fact 集合流遍了 DummyMain 的每一个 scope，
scope 边界并没有把 fact 空间切成更小的子集。

成因分两类：

1. **`<other>` 全局 fact**：入口创建的 `Want`/参数/全局对象等，经 Ability 级循环广播到所有
   scope。它们本来就与具体 Page 无关，任何分离求解都无法消除，也不是模型表达造成的浪费。
2. **page-owned fact 经 fallback 扩散**：fallback 与所有 scope 双向连通（"解析失败绝不剪枝"
   的保守设计），于是某个 Page 的实例 fact 也能到达其它 Page 的 scope。这是唯一"可被分离
   剪掉"的部分，但其规模极小。

## 对两个方向的判定

**实验 1（scope 循环迭代 / widening）——不成立。** 每个 scope head 的 distinct fact 数有界且
跨 scope 完全一致，没有观测到"fact 在某个 scope 内绕圈并膨胀出更多变体"。harmony-utils 60 个
scope 各只有 34 个 fact，CoolMallArkTS 单 scope 653 个、jingmo 单 scope 154 个，均不出现
per-scope 增长。没有可供 scope-aware widening 收敛的 fact 膨胀，方向 A（scope-aware widening）
**不投入实现**。

**实验 2（跨 scope fact 流动 / 分离式求解）——不成立。** 可被分离消除的只有 page-owned fact
跨入 foreign scope 的部分：foreign facts 占 processedEdges 的 0.015%–0.019%（有跨 scope 的
两个项目），单 scope 项目为 0。即便全部视为可消除成本，收益也远低于 0.1%，且这还没扣除
分离求解本身的区域边界开销。方向 B / C（分离式求解、SCC 分层）**不投入实现**。

## 与已有证据的关系

- 与归档 [page-local-propagation-profile](./archive/page-local-propagation-profile.md) 一致且互补：
  那份记录从"求解过程中进入 foreign block 的传播事件"测得 0.1614% / 0.1179%；本实验从
  "scope head 上的 foreign fact 内容"测得 0.015%–0.019%。两个口径都指向 page-local / 分离
  方向无效率收益，且本实验进一步解释了原因——**scope 之间因 fallback 全连通 + Ability 广播
  而使 fact 空间保持全局，根本不存在可利用的 per-scope fact 子集**。
- 解释了 [heavy-hierarchical-cfg](./archive/heavy-hierarchical-cfg.md) 的负向结果为什么成立：
  hierarchy 没有改变"同一全局 fact 集合流遍 DummyMain"的事实，所以只增加结构约束不降低
  fact 传播量。真正的收益仍只来自减少合成控制流节点（compact dispatcher），与本实验结论自洽。

## 结论

利用 hierarchical scope 结构降低 IFDS 成本的两条候选路径（scope-aware widening、分离式 /
SCC 分层求解）在本实验的 4 个真实应用上均无收益依据，**停止投入**。compact dispatcher 仍是
唯一归因明确的结构优化。scope 结构信息（`getScopeModelInfo()`）保留作为调试 / profiling 工具，
不作为优化前提。

## 已知限制

- 仅覆盖 DummyMain 主 root；supplemental roots（module initializer、framework sink）未纳入，
  但它们不经过 DummyMain scope 结构，与本问题无关。
- fact 归属判定基于 access-path base 的合成实例名；别名 / 逃逸的 fact（如把 page 实例赋给
  全局变量再读取）会被归为 `<other>`，可能低估跨 scope 流动。但 `<other>` 类 fact 本就无法
  按 scope 局部化，不影响结论方向。
- 单轮运行；结论依据的是确定性的 fact 计数与结构签名，不是耗时。
- 4 个项目为 utils / 商城 / 媒体类，未覆盖所有应用形态；但"scope head fact 集合全局一致"
  在 1–60 个 scope 的项目上都成立，模式稳健。
