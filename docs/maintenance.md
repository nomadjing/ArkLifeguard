# 维护与接口策略

## 分析范围

资源检查统一包含系统资源与显式内存释放义务；listener 检查注册清理义务。实现集中于 analysis/resourceleak，二者共用 resourceleak/ReleaseObligationRunner 和 IFDS。普通托管对象的 GC 保留、闭包捕获链与实际堆增长不在范围内。

新增获取/释放规则接入 rules/HarmonyResourceRules；新增监听 API 接入 rules/ListenerRules，并明确注册者、事件、回调/token、批量取消与自动失效合同。禁止按项目 API 名字兜底，逃逸或普通置空不默认等于释放。

## 当前接口

| 接口 | 约定 |
| --- | --- |
| CLI | --checks nullness,resource,listener；默认 all |
| 工程 API | runResourceAnalysis/resourceRules、runListenerAnalysis/listenerRules |
| 主报告 | schema 5；resourceAnalysis.diagnostics、listenerAnalysis.diagnostics |
| 摘要 | resourceLeaks、listenerLeaks，各自等于诊断数组长度 |
| 状态 | enabled、status: disabled/success/failed、success、error |
| IFDS 旁路 | schema 2，资源和 listener 各自统计 |
| 真实项目资源脚本 | 保持 resource 单入口和自身 schema 2，含图像内存义务 |

旧 memory/closure 检查、runMemoryAnalysis/runClosureAnalysis、memoryRules/closureRules、HeapFlowOptions、堆预算参数及保留链输出均移除，不提供兼容别名。仓库外使用方需按新公开类型和 schema 迁移。

## 失败与近似

规则完全未解析、显式空规则、非法配置和求解异常均返回失败；空诊断不代表安全。部分未解析或未支持 API 必须保留覆盖限制。成功仅说明当前有限规则与上下文下求解完成。

资源与 listener 调用事实深度为 4，通过 resourceBounds/listenerBounds 表达。maxPropagationDepth 仅约束空指针。当前无通用事件次数/Ability 跳转边界参数；不得将调用深度写成完整生命周期有界证明。

清理合同检查匹配行为，不检查所有路径异常安全。listener 的复杂别名、同一分配点重复注册计数与异步取消时序仍存在限制，不得解释为闭包对象保留证据。

## 修改与验证

接口变动需同步工程入口、公开导出、CLI、主/旁路报告、相关测试和文档。默认先类型检查，再运行直接相关单元测试；未经要求不运行完整构建、全套测试或真实应用基准。测试通过与真实应用精度/性能结论分开报告。
