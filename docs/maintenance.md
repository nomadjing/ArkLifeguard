# 维护与接口策略

## 当前资源入口

资源分析只有 [ResourceRunner](../src/analysis/resourceleak/ResourceRunner.ts) 一条实现，由 [ProjectAnalyzer](../src/application/ProjectAnalyzer.ts) 调用。CLI、公共导出、报告和真实项目脚本均使用该入口。没有旧 Source/Sink 求解器、方法内辅助扫描、结构性抑制器或混合规则表，也没有兼容 wrapper、双跑和回退。

新增资源语义接入 `resourceleak` 的规则与事实流；注册语义接入 `closure`，对象保留语义接入 `memory` / `shared`。三个模块独立返回结果，不能通过类别标签复用同一种泄漏判定。

## 公共接口

| 接口 | 当前约定 |
| --- | --- |
| 工程 CLI | `--checks resource` 直接使用资源规则；不接受 `--resource-engine` |
| 工程 API | `runResourceAnalysis` 控制启用，`resourceRules` 替代默认规则；无 `resourceEngine` |
| 主结果与报告 | schema 3，`analysisKind: "arklifeguard"`；唯一字段 `resourceAnalysis` |
| 资源诊断 | `resourceAnalysis.diagnostics`；摘要 `resourceLeaks` 等于该数组长度 |
| 模块状态 | 资源使用 `enabled`、`status: disabled/success/failed`、`success` 和 `error` |
| IFDS 旁路报告 | schema 2，读取唯一资源结果的 `solverStatistics` |
| 真实项目资源脚本 | 单入口，报告 schema 2；无 `--engine` 或旧传播上限 |
| 能力目录 | [资源](../src/analysis/resourceleak/rules/ResourceCapabilities.ts)、[注册](../src/analysis/closure/RegistrationCapabilities.ts)各自声明默认未支持的 API 家族 |

不提供 `newResourceAnalysis`、`methodLocal`、`taintLeaks`、Source/Sink 位置数组或 amplification 镜像。CLI 拒绝已移除的选项；TypeScript API 不再导出相关类型。仓库外消费者应按当前 schema 和公开类型接入。

`maxPropagationDepth` 只约束空指针。资源调用事实深度固定为 4，通过 `settings.resourceBounds` 表达；不接受 Ability 数/导航跳数传播约束。生命周期的 K 继续独立控制两种 bounded 模型，不能当作资源或内存预算。

## 能力与失败策略

没有默认摘要的 API 必须显示覆盖不足，不以同名匹配、未取消就泄漏、分配即泄漏等规则兜底。默认能力目录是已知缺口清单，不是完整平台枚举，也不是本次工程实际调用统计；自定义规则是否覆盖这些家族需单独审查。

SDK 默认资源规则完全未解析、显式空规则、非法规则或求解失败均返回失败；不伪装成零诊断成功。闭包/内存的未解析规则和生命周期/根集合限制按模块合同解释。

## 共享设施与 Runner

保留 `src/ifds/`、`src/lifecycle/`、`src/adapter/` 和 `shared/HeapFlow` / `HeapState`。它们承担当前求解与建模职责。五种生命周期模式仍可使用，与资源实现没有兼容绑定。

四个 Runner 可分别接收 Scene 与现有入口；空指针也支持自行创建生命周期入口。闭包/内存直接使用时必须提供生命周期合同。保持这些明确职责，不建立万能 Runner 或旧结果转换层。

接口调整应同时修改入口、公开类型、CLI、报告、脚本、定向测试和文档。验收依据规则匹配、释放身份、跨方法传播、异步未知状态、模块失败/关闭状态及独立计数；候选数量相同不是语义正确性的证据。
