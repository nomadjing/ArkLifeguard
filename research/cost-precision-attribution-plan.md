# 下一步实验设计：IFDS 成本 ↔ 精度相关性归因

## 目标

把一次 IFDS 求解的成本按**"是否影响诊断集合"**二分，找出**高成本 + 与精度无关**的可剪类别，
为下一轮优化提供带判定规则的候选清单。只测量、不实现；任何 kill 规则都必须先通过本实验的
判定规则，再做"删除后诊断不变"的回归。

## 为什么不能直接用"是否产生诊断"当相关性

4 个真实应用的诊断数是 0–4，bench 也只有 37 TP。如果用"是否在某条诊断路径上"判定相关性，
在干净应用上会得到"几乎全部工作都无关"——这是错的：那些工作是**证明无缺陷**的必要成本，
不是浪费。

正确的相关性代理是**必要条件**：一个 fact 只有在能影响某次诊断判定（产生或抑制）时才相关。
对空指针而言，诊断在某条 base 被解引用（deref）且其 fact 为 maybe-null 时产生；同时
`narrowFactOnBranch` / 支配性 guard 会让 fact 抑制一次潜在诊断。因此：

> 一个 fact 相关 ⟺ 它在求解中**被消费于一次 deref 判定或一次 guard 收窄**。
> 从未被这两处消费的 fact，不可能改变诊断集合，是 provably precision-irrelevant。

注意 suppressor 一侧：把"相关"定义成"到达 deref 或 guard"，可同时覆盖"产生诊断"和
"抑制诊断"两类贡献，避免把抑制型 fact 误判为浪费。

## 粒度选择：按 fact 类（signature）而非单个 fact

单个 fact 有 lineage（x 的 null 经赋值变成 y 的 null），逐 fact 追踪相关性成本高。而 kill
规则本来就是按**类**生效的（按 origin、按 base 类别、按 access-path 形状）。因此相关性也按
fact 类统计，类的 signature 取：

```text
signature = (originKind, baseKind, accessPathShape)
  originKind     : NullnessOriginKind（NullLiteral/UndefinedLiteral/Uninitialized/
                   NullableReturn/LibraryModel/UnresolvedReturn/Unknown）
  baseKind       : syntheticPageInstance | lifecycleScaffold(Want/WindowStage/LaunchParam/参数)
                   | globalOrStatic | ordinaryLocal | other
  accessPathShape: 长度桶（0/1/2/3+）× 是否含数组/通配/promise 段
```

每个 fact 归属一个 signature；每个 signature 累计"成本"与"是否相关"。这正好就是 kill 规则
能直接消费的粒度，也绕开了 lineage 追踪。

## 要统计的指标

### A. 成本归属（work 在哪）

| 指标 | 定义 | 产出 |
|---|---|---|
| A1 method Pareto | 每方法的 pathEdgeCount / distinctFacts | top-10 方法的成本占比、累计曲线 |
| A2 signature Pareto | 每 signature 的 pathEdgeCount / distinctFacts | top signature 的成本占比 |
| A3 region 拆分 | DummyMain vs 业务方法的 fact-stmt 对、processedEdges | 合成骨架 vs 业务的比例 |
| A4 propagationDepth 直方图 | fact 的 propagationDepth 分布 | 深度尾部是否集中 |

### B. 相关性判定（work 是否要紧）

| 指标 | 定义 | 产出 |
|---|---|---|
| B1 relevant-signature 集合 | 求解中被 deref 判定或 guard 收窄消费过的 fact 的 signature 集合 | 相关 signature 白名单 |
| B2 dead-end 成本占比 | 不在 B1 中的 signature 的 pathEdge / propagationAttempt / fact-stmt 占比 | "浪费"的总量 |
| B3 signature × 相关性 × 成本 交叉表 | (originKind × baseKind × shape) × {相关,dead-end} × 成本 | 浪费集中在哪类 |

### C. 可剪签名（kill 规则能不能便宜地命中）

对每个"高成本 + dead-end"的 signature，记录一个 kill 规则可用的廉价判定特征：

| 指标 | 用途 |
|---|---|
| C1 base 是否在全工程被解引用过 | base 从不被 deref 的 fact 不可能产生 deref 诊断 |
| C2 broadcast 度（fact 到达的 stmt 数） | 识别全局广播 fact（承接上一实验的 `<other>` fact） |
| C3 origin 是否来自 library summary | 识别"每个调用点投机生成"的库 fact |
| C4 是否落在被 widen 的递归 SCC | 识别"将被 widening 丢弃"的长路径提前传播 |

## 要验证的行为假设（每条配指标 + 判定规则）

**H1：库/SDK 投机 fact 是 dead-end 主力。**
`NullableReturn`/`LibraryModel` 在每个调用点投机生成，多数到不了项目内 deref。
指标：B3 按 origin ∈ {NullableReturn, LibraryModel} 过滤的 dead-end 成本占比。
判定：若 > 30% dead-end 成本 → 值得做"库 fact 仅当 base 下游有 deref 才传播"或惰性 summary。

**H2：生命周期骨架 fact 是广播浪费。**
上一实验的 `<other>` fact（Want/WindowStage/参数）流遍整个 DummyMain，却很少作为 null-deref
的 base。指标：C2 broadcast 度 + B1 sink-reachability + A3 中 DummyMain 内成本占比。
判定：若骨架 fact 占 DummyMain fact-stmt 对 > 20% 且 sink-reachable < 5% → 值得做"骨架 fact
不越过其创建的 callback"。

**H3：将被 widening 丢弃的提前传播是浪费。**
递归 SCC / 大工程会把 access path widen 到长度 2，widen 前传播的更长路径被丢弃。
指标：C4，统计 widen 区域内长度 > widenedLength 的 fact 数及其成本。
判定：若显著 → 把 widening 提前到 SCC 入口。

**H4：少量方法主导成本（Pareto）。**
指标：A1。判定：若 top-10 方法 > 50% pathEdge → 值得做按方法的定向 widening / 手工 summary。

**H5：guard 死分支内的深传播是浪费。**
fact 被传播进随后被 guard 立即杀死的分支。指标设计较难（需记录 kill 点与传播深度），
本轮只做观察、不做判定，留待后续。

## 测量方法

分两层，与本次 scope-propagation profiling 同一套"只读、不改求解语义"的范式：

- **Tier 1（纯 post-hoc，零 src 改动）**：复用 `getReachedFacts()` + `getPathEdgeSet()`，
  离线计算 A1–A4、C1、C2、C4。先做，成本低，用来快速排除 H4、定位 Pareto。
- **Tier 2（一个小 hook，唯一 src 改动）**：在 `NullnessProblem` 的 deref 判定与 guard 收窄
  两处，把被消费的 fact 的 signature 记入一个 opt-in recorder（参照 `SolverStatistics` 的
  `collectStatistics` 开关，默认关）。B1–B3、C3 由"全部传播 signature − 被消费 signature"
  与 pathEdgeSet 成本做差得到。**在分支上实现**。

预期产出一张表：`signature × 成本占比 × 是否相关 × 可剪规则`，按"高成本 + 无关 + 廉价可剪"
排序，只有进入这张表头部的类别才进入实现。

## 正确性护栏

- 实验期间记录基线诊断集合：ArkDefectBench（带标注 oracle，当前 TP=37/TN=12/FP=0/FN=3）
  与 4 个真实应用的诊断集。任何后续 kill 规则必须在该基线上 diff 为 0 才允许合入。
- 相关性 recorder 本身不得改变求解：只在 deref/guard 消费点追加只读记录，不动 flow
  function、调度与去重。合入前以 4 项目诊断逐项一致 + processedEdges 一致验证。
- 资源（taint）分析同构，设计可平移：sink 换成 Source/Sink 规则的 sink，先以空指针验证方法论。

## 与已有证据的衔接

- 承接 `scope-propagation-profile.md`：scope 结构层面已无收益，本实验转向 fact 内容层面找浪费。
- 承接 `IFDS优化实验记录.md`：pathEdge 判重已哈希化，剩下的成本主要在"哪些 fact 根本不必传播"。
- 方法论沿用 `page-local-propagation-profile.md` 的"先 profiling、按 decision rule 决定去留"。

## 已知边界

- 相关性是必要条件代理：dead-end fact 一定不影响诊断，但 B1 收录的 fact 不一定都真正影响
  最终诊断（可能到达 deref 但不触发、或被后续 guard 抑制）。因此本实验给出的是浪费的**下界**，
  真实可剪量 ≥ 测得量。
- 单轮运行；结论依据确定性 fact 计数，不依据耗时。
