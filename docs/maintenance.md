# 维护与兼容策略

## 结论

**可以停止兼容旧资源实现，并以独立 `ResourceRunner` 作为唯一资源入口；无需永久保留两套 Runner、旧 Fact 或旧 JSON 结构。** 项目包配置为 `private: true`，本仓库没有必须维持双引擎的技术要求；仓库外是否有消费者仍需在接口删除时核对，不能从本地引用推断不存在。

**当前不能直接删除整个 `src/analysis/resource/`。** 它仍是 CLI/API 的默认路径，报告、脚本、测试和闭包/内存支持清单仍引用它。先完成下列依赖替换，才能删除；这些是明确的退役条件，不是当前已经完成的功能。

## 可以退役的部分

| 对象 | 当前作用 | 删除条件 |
| --- | --- | --- |
| `TaintAnalysisRunner`、`TaintAnalysisSolver`、`TaintAnalysisProblem`、`TaintFact` | 默认旧资源求解链 | 工程入口统一调用独立资源引擎，移除旧调用和测试依赖 |
| `ResourceLeakDetector`、`SourceSinkLocationScanner` | 旧方法内候选及位置列表 | 决定取消这些产品输出；保留必要覆盖信息到独立引擎 `coverage` |
| `SourceSinkManager`、混合默认表及 deprecated opt-in | 旧规则与兼容匹配 | 当前有效规则/未支持清单迁入所属模块，剩余消费者改用独立规则 |
| `LifecycleLeakSuppressor`、`FileLeakSuppressor` | 旧求解后的结构性抑制 | 删除旧结果路径；不要移入新引擎替代身份/路径判定 |
| `ResourceEngine = 'legacy' \| 'new'` 和 CLI 选择参数 | 双引擎分支 | 只保留一个资源入口，同步修改命令、报告与脚本 |
| `newResourceAnalysis`、旧 `resourceAnalysis`、固定 `analysisKind` 等兼容字段 | 当前结果结构 | 选定单一资源结果字段，升级主 schema 并迁移本仓库消费者 |
| 仅断言旧类别、旧抑制器和旧报告的测试 | 支撑旧行为 | 用独立模块语义/契约测试替代；保留有价值的正反夹具 |

不要求新引擎复现旧引擎的所有候选。旧规则范围更宽但存在启发式匹配，新引擎范围较窄但合同更明确。每个缺少替代的 API 应记录为未支持，不能靠旧引擎静默兜底，也不能要求复制已知误报来维持“结果兼容”。

方法内扫描并非必须长期保留。若产品只需要统一资源候选，可以取消 `methodLocal`；这是可接受的功能取舍，须同步删掉报告/摘要及脚本计数，不能把删除称为已经取得同等覆盖。

## 必须先解除的具体引用

| 消费者 | 现有依赖 | 退役时的处理 |
| --- | --- | --- |
| [ProjectAnalyzer](../src/application/ProjectAnalyzer.ts) | 旧 Runner、方法内检测、位置扫描、旧默认值和结果块 | 单资源分支；显式模块状态；统一结果计数 |
| [ReportGenerator](../src/report/ReportGenerator.ts) | 同时展示新旧资源结果 | 改为单资源结果；取消重复摘要 |
| [SolverStatisticsReportGenerator](../src/report/SolverStatisticsReportGenerator.ts) | 只读取旧资源统计 | 改读唯一资源统计，明确哪些模块能输出 IFDS 指标 |
| [真实应用资源脚本](../scripts/test-resource-real-apps.ts) | `--engine`、新旧字段和旧 amplification | 单引擎，统一覆盖和诊断数组，不补兼容零值 |
| [闭包 Runner](../src/analysis/closure/ClosureRunner.ts)、[内存 Runner](../src/analysis/memory/MemoryRunner.ts) | 从旧默认表生成未支持清单 | 在注册模块定义自己的能力清单 |
| [RuleOwnership](../src/analysis/shared/RuleOwnership.ts) | `SourceDefinition` 类型与旧规则迁移 | 与导出脚本一同退役，或改为独立能力目录 |
| [公共导出](../src/index.ts) | 导出旧资源类型/类 | 仅导出当前模块 API，更新 API 示例及相关测试 |

独立 `resourceleak` 核心和空指针核心不需要旧资源求解器；当前阻碍来自入口/结果编排及支持清单。清单本身可以迁出，不构成长期保留旧目录的理由。

## 应保留的当前设施

`src/ifds/`、`src/lifecycle/`、`src/adapter/` 和 `shared/HeapFlow` / `HeapState` 是现有分析依赖，不是旧资源兼容代码。保留它们的语义职责，避免在资源退役时连带删除。

`NullnessAnalysisRunner`、`ResourceRunner`、`ClosureRunner`、`MemoryRunner` 可保持独立，因为输入、终点和结果不同。没有必要做一个同时兼容旧污点/资源结果的万能 Runner。公共 Runner 只需要支持明确的当前入口与规则合同。

五种生命周期模式目前仍可被 CLI、脚本和测试选用。它们的保留/删除是单独的建模范围决策，不能因为退役资源引擎而删掉基线模型或有界模型。

## 接口取舍与验收

可直接采用破坏式接口整理：唯一资源入口、单一结果字段、显式启用状态，并移除旧引擎开关。不需要额外提供 deprecated wrapper、旧字段镜像、旧规则回退或永久双跑。

接口调整必须形成完整、可用的同一版本：入口、公共导出、CLI、报告、统计脚本和测试同步修改。验收看精确规则、释放身份、跨方法传播、异步未知状态、失败状态及独立模块计数，不以新旧候选数量相等作为门槛。

本文件明确删除范围及条件；当前源码仍保留上述依赖，使用说明按实际默认值编写。
