# Page-local propagation opportunity profile (archived)

## Question

在 canonical `hierarchical + compact dispatcher` 模型中，foreign Page
synthetic invocation scaffolding 是否是 lifecycle IFDS 的重要成本来源？

本实验只做 profiling。candidate fact 定义为：

```text
accessPath = syntheticPageInstance.field
且该 component 具有唯一 Page owner
```

profiling 不跳过任何边，也不改变 CFG、flow function 或 path-edge 去重。

## Configuration

- 日期：2026-09-20
- 当前工作树 HEAD：`283db38d45235cec378c5c2294904f802be21398`
- 工作树状态：包含本实验尚未提交的 instrumentation
- lifecycle model：`hierarchical`
- compact dispatcher：开启
- empty-scope removal：开启
- unreachable-Ability pruning：开启
- IFDS statistics：开启
- max access-path length：5
- max propagation depth：40
- 每项目 timeout：600000 ms
- 运行次数：每项目一次
- 原始 JSON 在核对汇总值后删除；profiling instrumentation 也已从主线移除。

四个项目全部成功；`completed=true`，无失败或超时。本次运行共产生 6 条
diagnostics：CoolMallArkTS 0、harmony-utils 2、JellyFin_HarmonyOS 4、
jingmo-for-HarmonyOS 0。该 diagnostics 数量只是本次 profiling run 的结果；
本实验未对真实项目另跑 profiling-off 配对组。

## Results

| Project | Candidate facts | Foreign entries | Foreign processed edges | Lifecycle processed edges | R_edge | Foreign propagation attempts | Lifecycle propagation attempts | R_prop |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| CoolMallArkTS | 76 | 0 | 0 | 313,432 | 0.0000% | 0 | 453,033 | 0.0000% |
| harmony-utils | 17 | 2,274 | 2,278 | 939,756 | 0.2424% | 2,278 | 1,273,333 | 0.1789% |
| JellyFin_HarmonyOS | 1 | 0 | 0 | 32,699 | 0.0000% | 0 | 36,614 | 0.0000% |
| jingmo-for-HarmonyOS | 4 | 139 | 139 | 211,823 | 0.0656% | 139 | 286,754 | 0.0485% |
| **Pooled** | **98** | **2,413** | **2,417** | **1,497,710** | **0.1614%** | **2,417** | **2,049,734** | **0.1179%** |

Pooled ratios use summed numerators and denominators:

\[
R_{edge} = \frac{2417}{1497710} = 0.0016138 = 0.1614\%
\]

\[
R_{prop} = \frac{2417}{2049734} = 0.0011792 = 0.1179\%
\]

## Decision

按本实验预先给出的 decision rule，停止继续实现当前定义下的 Page-local
fact localization。依据是：

- pooled foreign Page 占比仅为 processed edges 的 0.1614%、propagation
  attempts 的 0.1179%；
- 单项目最高值也只有 0.2424% 和 0.1789%；
- 98 个 candidate facts 中，CoolMallArkTS 的 76 个和 JellyFin_HarmonyOS
  的 1 个都没有进入 foreign Page synthetic invocation block；
- 即使把已观测 foreign propagation 全部视为可消除成本，它仍不是当前
  lifecycle IFDS 的重要成本来源。实际安全 bypass 的收益只会低于或等于
  这个 profiling 上界。

该结论只覆盖当前保守 candidate：唯一 Page owner 的精确一段实例字段。
它不证明更宽的 alias/escape-aware Page-local fact 集合也没有收益，但当前
结果不足以支持为其实现完整 proof 与 bypass。
