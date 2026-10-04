# 空指针分析

## 功能与使用

检测 `null`、`undefined` 和可能为空的值，在字段/数组/调用接收者等解引用位置或已建模的非空参数位置被使用。输出来源、访问路径、使用位置和置信度，结果为 `nullness.diagnostics`。

```bash
npm run cli -- analyze "/path/to/app" --sdk "/path/to/ets" \
  --checks nullness --format json --output out/nullness.json
```

工程默认访问路径长度 5、传播深度 40。直接构造底层 `NullnessProblem` 的默认传播深度为 100，与工程入口不同；调用方应明确配置。

## 事实域

[NullnessFact](../../src/analysis/nullness/NullnessFact.ts) 包含空值种类、访问路径、来源及传播信息。种类为 `null`、`undefined`、`maybe-null`、`maybe-undefined`、`maybe-nullish`，不以一个“空”状态混淆所有证据。

访问路径描述局部值及字段链，数组元素与 Promise payload 使用专门路径段。超长路径保留锚定前缀并抽象后缀，避免将不相关兄弟字段合并。来源区分字面空值、未初始化、可空返回、库模型与未解析返回。

## 流函数与求解

[NullnessProblem](../../src/analysis/nullness/NullnessProblem.ts) 处理赋值、字段/接收者更新、参数与返回传播、分支空值约束、解引用和非空参数诊断。

对于 ArkAnalyzer 降低后的条件、可选链和临时变量，还结合原始源码片段恢复部分 guard 语义；这是显式兼容逻辑，不是完整的路径约束求解器。

[NullnessSolver](../../src/analysis/nullness/NullnessSolver.ts) 使用专用 [NullnessInterproceduralCFG](../../src/analysis/nullness/NullnessInterproceduralCFG.ts)，对递归/较大工程进行事实抽象，过滤超过传播深度的事实，并导出到达事实。达到事实深度限制不会自动使模块失败，结果只能按该深度解释。

## 库摘要

[NullnessLibraryRegistry](../../src/analysis/nullness/library/NullnessLibraryRegistry.ts) 默认按以下顺序选择第一个匹配的调用摘要：

| 摘要 | 作用 |
| --- | --- |
| `ProjectMethodReturnSummary` | 项目方法返回及来源/置信度摘要 |
| `ArkUiArgumentSummary` | 已建模 ArkUI 非空参数位置 |
| `ContainerLibrarySummary` | Array/Map 等容器和标准方法返回语义 |
| `AsyncBoundarySummary` | Promise payload 等异步边界值语义 |
| `SdkReturnTypeSummary` | SDK 返回类型与声明摘要 |

非空参数索引单独汇总匹配摘要，不能将其逻辑与“首个返回摘要”混为一谈。SDK 摘要资产为 [sdk-nullness-summary.json](../../src/analysis/nullness/library/sdk-nullness-summary.json)，构建必须复制该文件。

`Promise.resolve` 和 `await` 的值语义不等于完整 Promise 调度；不会因此证明回调必然执行。

## Runner 与入口范围

[NullnessAnalysisRunner](../../src/analysis/nullness/NullnessAnalysisRunner.ts) 支持：

- `runFromDummyMain()`：自行创建生命周期模型。
- `runWithDummyMain(entry)`：使用工程编排已创建的入口。

默认在生命周期 root 之外，选取含具体空值来源的模块初始化器、含已注册非空参数 sink 的框架方法作为补充入口。每个 root 单独求解后合并诊断，避免同时保留所有 root 的上下文状态。

补充入口提高静态覆盖，但不证明该方法一定在真实运行中执行。库摘要、补充入口和框架位置应与原始源码一起审查。

## 输出及已知边界

`--report-unresolved-returns` 默认关闭；开启后输出相关低置信度候选。SDK 类型、guard 恢复、调用目标和递归抽象都可能影响结果。

本模块不是完整指针分析、类型系统验证或隐私污点分析；不覆盖所有反射/动态调用与异步时序。候选为空、测试通过或到达事实较少都不能证明没有空值缺陷。

定向测试位于 `test/nullness/`，包含访问路径、字段更新、guard、容器、Promise、SDK 和模块入口。已有基准使用标注文件，运行方式见[测试文档](../testing.md)。
