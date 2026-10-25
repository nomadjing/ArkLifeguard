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

对于 ArkAnalyzer 降低后的条件、可选链和临时变量，[NullnessSourceSemantics](../../src/analysis/nullness/NullnessSourceSemantics.ts) 使用 ArkAnalyzer 导出的 ArkTS AST 提取访问、断言、短路/条件求值顺序和有限的 guard 信息。源码按文件解析一次，在一次 Runner 分析的各入口间共享；语句信息按需缓存。不再使用源码字符串包含或正则匹配来批量抑制解引用。无法匹配到具体源码访问时保留 IR 证据；源码位置仍可能对应同一表达式的多个降低访问，因此这不是完整的路径约束或别名分析。

不再根据 getter 风格名称假定重复调用稳定，也不根据 `is…ReadyState` 名称与若干字段写入推断类不变量。合法的项目协议可能因此产生额外潜在告警；当前不自动推断这些协议，也未新增契约配置系统。保留已有的 ArkUI `@Require` 等明确框架模型。guard 恢复遇到相关写入、字段上的潜在修改调用或函数边界时保持保守。

语句接收者、非空参数路径和源码信息统一缓存；CFG 分支查询复用语句所属块索引。诊断按源码位置分桶，再按访问路径别名关系去重。项目返回摘要、SDK 返回摘要和类型检查共用空值种类分类函数，保留 `null` 与 `undefined` 的区别。

[NullnessSolver](../../src/analysis/nullness/NullnessSolver.ts) 复用通用 [DataflowSolver](../../src/ifds/DataflowSolver.ts) 和 [ArkInterproceduralCFG](../../src/ifds/icfg/ArkInterproceduralCFG.ts)，仅补充空值事实在递归/较大工程中的抽象和传播深度限制。到达事实由通用 solver 收集；递归方法集合由共用调用解析模块计算，并在一次 Runner 运行内供各独立入口复用。关闭递归抽象时跳过该计算；结果不跨运行缓存。达到事实深度限制不会自动使模块失败，结果只能按该深度解释。

对于同一 Scene 上的 $R$ 个入口，SCC 预处理由 $R$ 次全工程扫描减少为一次；各入口仍独立建立 CFG 索引并执行 IFDS 传播，因此不能把 SCC 扫描次数的下降直接解释为整体分析加速比例。递归识别沿用直接调用签名及导入/顶层函数回退解析，未扩展为包含所有 CHA、回调边的递归检测。

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
