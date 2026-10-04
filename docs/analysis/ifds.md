# IFDS 与跨过程控制流

## 职责

`src/ifds/` 是项目维护的通用 IFDS 设施。它传播程序点上的领域事实，管理跨过程调用/返回关系，不直接定义空指针或资源泄漏。

空指针与资源分别提供自己的 `DataflowProblem<D>`，复用 `DataflowSolver<D>`。闭包/内存引用堆需要完整状态更新，使用 `HeapFlow`，不使用 IFDS Fact。

## 流函数与事实合同

[DataflowProblem](../../src/ifds/DataflowProblem.ts) 提供：

| 流 | 作用 |
| --- | --- |
| normal | 普通语句到后继的事实变换 |
| call | 调用点到被调入口的参数/接收者映射 |
| exit-to-return | 被调出口到调用方返回点的事实映射 |
| call-to-return | 直接绕过调用的领域摘要或保守继续 |
| 异常流 | 普通异常、被调异常出口和调用方 handler 的传播 |

问题域还提供 zero fact、语义相等及哈希。Fact 身份必须有限且稳定；证据路径或调试信息不能无界加入去重键。哈希是查找索引，相等性仍由语义比较确认，不能把哈希一致直接当作同一事实。

## 求解与存储

[DataflowSolver](../../src/ifds/DataflowSolver.ts) 用 PathEdge 表示从方法入口事实到当前程序点事实的传播。立即工作队列优先处理调用等工作，延迟普通边使用另一工作列表；调度不改变领域事实语义。

[PathEdgeStore](../../src/ifds/PathEdgeStore.ts) 将边按程序点和事实语义哈希分桶，再进行相等性检查，避免全量线性扫描。[SummaryStore](../../src/ifds/SummaryStore.ts) 存储 incoming、正常/异常 end summary 和 call summary。

新发现被调出口摘要时，需要应用到所有已登记 caller；新发现 caller 时，也需重放已有摘要。否则调用发现顺序会影响结果。

## ICFG 与调用解析

[ArkInterproceduralCFG](../../src/ifds/icfg/ArkInterproceduralCFG.ts) 组合：

- [CfgIndex](../../src/ifds/icfg/CfgIndex.ts)：语句级后继、返回点、异常 handler 和 CFG 兼容修复。
- [CallGraphManager](../../src/ifds/icfg/CallGraphManager.ts)：调用图与调用点缓存。
- [CallResolver](../../src/ifds/CallResolver.ts)：表达式目标、项目方法及可调用的回调参数传播。

回调解析是 may-call 关系，不是 Promise/事件循环调度模型。某回调被识别为目标，不证明注册时立即执行、必然执行或与生命周期之间的先后关系。领域分析的异步摘要仍需保守处理。

## 统计与边界

统计通过 `collectStatistics` 开启，包含处理边数、传播尝试、重复边、队列规模、最终 PathEdge 数和求解时间。不同事实域、入口、生命周期模型或摘要配置的指标不能直接当成公平性能对比。

通用求解器没有统一的“最多分析多少真实路径”参数。空指针在事实层限制传播，资源限制调用事实深度；闭包/内存预算属于另一个解释器。部分事实被截断后运行仍可能成功，成功不等于无限深程序的完整证明。

未知调用、动态分派、ArkIR 异常边和 SDK 不完整会影响覆盖。修改去重或摘要机制时，应验证多 caller、异常和重复发现顺序，而不只看运行时间。定向测试见 `test/ifds/`。
