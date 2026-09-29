# Opt-flat K-bound screening

## Question

在 `opt-flat` 的 callback loop 上施加有限展开 K=1/2/3，能否在不丢失
diagnostics 的情况下显著降低 IFDS workload 与运行时间？

K 表示一条 DummyMain 路径最多执行的 callback invocation 数。K=∞ 使用原有
cyclic `opt-flat`；K=1/2/3 使用 `bounded-opt-flat`，每层非确定地执行零或一个
callback 后进入下一层。四组配置共享 callback 集合、Ability pruning、compact
dispatcher、分析 roots 与 IFDS 参数。

## Implementation and validation

- `BoundedOptimizedFlatLifecycleModelCreator` 复用 `opt-flat` 的收集、初始化、销毁
  和优化逻辑，只把全局 callback dispatcher 展开成 K 层 DAG。
- K=1/2/3 的聚焦回归确认 CFG 无环、每类 callback 在每层恰好出现一次，且
  callback kind 集合与 K=∞ 相同。
- 源码、脚本和测试 TypeScript 配置均通过类型检查；生命周期模型聚焦测试
  13/13 通过。

## Configuration

- 日期：2026-09-22
- 基础 HEAD：`ede70c1`；运行时工作树包含本实验实现以及用户已有的未提交修改
- Node.js：`v22.19.0`；ArkAnalyzer：`1.0.90`；SDK：`sdk/default`
- 项目：`CoolMallArkTS`、`harmony-utils`、`JellyFin_HarmonyOS`、
  `jingmo-for-HarmonyOS`
- 每个配置、每个项目运行一次；单项目 timeout 600000 ms
- lifecycle roots 与 supplemental roots 均启用；IFDS statistics 启用
- max access-path length 5；max propagation depth 40
- 原始报告：`out/k-bound/k-{infinity,1,2,3}.json`

四组报告均为 `completed=true`，每组 4/4 成功、0 失败、0 超时。

## Aggregate results

下表为四项目求和；括号内是相对 K=∞ 的变化。时间是单轮观测值，确定性
workload 计数是主要判断依据。

| 配置 | Total runtime | IFDS solve | Lifecycle IFDS | `processedEdges` | `propagationAttempts` | Blocks | CFG edges |
|---|---:|---:|---:|---:|---:|---:|---:|
| K=∞ | 67.019 s | 28.982 s | 20.098 s | 1,511,996 | 2,060,133 | 1,621 | 3,226 |
| K=1 | 65.832 s (-1.77%) | 27.709 s (-4.39%) | 19.034 s (-5.29%) | 1,487,020 (-1.65%) | 2,010,050 (-2.43%) | 1,621 (0.00%) | 3,226 (0.00%) |
| K=2 | 72.187 s (+7.71%) | 33.722 s (+16.35%) | 24.617 s (+22.48%) | 1,721,188 (+13.84%) | 2,538,301 (+23.21%) | 3,234 (+99.51%) | 6,448 (+99.88%) |
| K=3 | 79.273 s (+18.28%) | 40.892 s (+41.09%) | 31.539 s (+56.93%) | 1,955,356 (+29.32%) | 3,066,552 (+48.85%) | 4,847 (+199.01%) | 9,670 (+199.75%) |

K=1 与 K=∞ 的 blocks / edges 数量相同，是因为两者都只保留一份 callback
invocation blocks；差别是 K=1 把 invocation 的回边改为通往 teardown 的边，因而 CFG
从 cyclic 变为 DAG。K=2/3 则分别复制两层和三层 callback CFG。

### Per-project workload

| 项目 | 配置 | Lifecycle IFDS | `processedEdges` | `propagationAttempts` | Blocks / edges |
|---|---|---:|---:|---:|---:|
| CoolMallArkTS | K=∞ / 1 / 2 / 3 | 4.153 / 3.261 / 5.538 / 7.736 s | 339,068 / 317,953 / 452,023 / 586,093 | 478,221 / 435,941 / 704,481 / 973,021 | 207/410 · 207/410 · 412/819 · 617/1,228 |
| harmony-utils | K=∞ / 1 / 2 / 3 | 12.105 / 11.891 / 14.159 / 17.157 s | 934,419 / 934,419 / 967,424 / 1,000,429 | 1,265,911 / 1,265,911 / 1,389,998 / 1,514,085 | 942/1,880 · 942/1,880 · 1,882/3,759 · 2,822/5,638 |
| JellyFin_HarmonyOS | K=∞ / 1 / 2 / 3 | 0.898 / 0.872 / 0.963 / 0.918 s | 32,556 / 32,556 / 33,154 / 33,752 | 36,458 / 36,458 / 37,673 / 38,888 | 43/82 · 43/82 · 84/163 · 125/244 |
| jingmo-for-HarmonyOS | K=∞ / 1 / 2 / 3 | 2.942 / 3.010 / 3.957 / 5.728 s | 205,953 / 202,092 / 268,587 / 335,082 | 279,543 / 271,740 / 406,149 / 540,558 | 429/854 · 429/854 · 856/1,707 · 1,283/2,560 |

`harmony-utils` 与 `JellyFin_HarmonyOS` 在 K=1 下的两个 workload 计数与
K=∞ 完全相同；K=1 的小幅 pooled 降幅来自另外两个项目，并非四项目一致收益。

## Diagnostics gate

每组均产生 6 条 diagnostics：`CoolMallArkTS` 0、`harmony-utils` 2、
`JellyFin_HarmonyOS` 4、`jingmo-for-HarmonyOS` 0。按完整序列化 diagnostic
记录（nullness、access path、description、confidence、source 与 dereference
位置）逐项目比较：

| 配置 | `lost(K) = diagnostics(∞) - diagnostics(K)` | Added diagnostics |
|---|---:|---:|
| K=1 | 0 | 0 |
| K=2 | 0 | 0 |
| K=3 | 0 | 0 |

这只说明当前四项目的 diagnostics exact set 稳定，不证明 K-bound 在未覆盖应用上
不会漏报。

## Decision

**停止把 CFG 有限展开 K-bound 作为当前性能优化方向。**

- K=1 只降低 1.65% `processedEdges` 和 2.43% `propagationAttempts`，且两个项目
  完全不降；单轮 lifecycle IFDS 的 -5.29% 不足以形成稳定性能结论。
- K=2/3 因复制 callback CFG，确定性 workload 分别高于无界基线 13.84%/29.32%
  （processed edges）和 23.21%/48.85%（propagation attempts），运行时间也同向变差。
- 四项目没有 diagnostics 差异，因此本轮没有观测到精度代价；但收益不足意味着
  没有理由为更大样本继续承担潜在漏报风险。

本实验否定的是“通过完整 CFG 层复制实现的 K-bound 能成为当前通用性能优化”。
它不否定 K 作为敏感性参数或面向特定分析预算的显式 precision/cost trade-off。
