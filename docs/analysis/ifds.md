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

[PathEdgeStore](../../src/ifds/PathEdgeStore.ts) 将边按起止程序点及两个事实的组合哈希分桶，减少嵌套 Map；桶内仍比较两个事实的语义相等性。[SummaryStore](../../src/ifds/SummaryStore.ts) 存储 incoming、正常/异常 end summary 和 call summary。

空指针的补充根结果按语句合并，使用 Fact 哈希分桶及 `equals` 去重，保留首次出现的事实及证据，避免对整条事实数组反复线性扫描。

新发现被调出口摘要时，需要应用到所有已登记 caller；新发现 caller 时，也需重放已有摘要。否则调用发现顺序会影响结果。

## ICFG 与调用解析

[ArkInterproceduralCFG](../../src/ifds/icfg/ArkInterproceduralCFG.ts) 组合：

- [CfgIndex](../../src/ifds/icfg/CfgIndex.ts)：语句级后继、返回点、异常 handler 和 CFG 兼容修复。
- [CallGraphManager](../../src/ifds/icfg/CallGraphManager.ts)：调用图与调用点缓存。
- [CallResolver](../../src/ifds/CallResolver.ts)：表达式目标、项目方法及可调用的回调参数传播。

空指针在单次分析运行中复用固定 Scene 的 CFG 索引，各根的求解器、路径边和摘要保持独立，调用解析缓存在切换入口时重建。所有根须在首次索引前存在，复用期间不修改 Scene 或 CFG；下一次分析运行使用新的索引。默认 ICFG 初始化仍会重建 CFG 索引。

回调解析是 may-call 关系，不是 Promise/事件循环调度模型。某回调被识别为目标，不证明注册时立即执行、必然执行或与生命周期之间的先后关系。领域分析的异步摘要仍需保守处理。

## 统计与边界

统计通过 `collectStatistics` 开启，包含处理边数、传播尝试、重复边、队列规模、最终 PathEdge 数和求解时间。不同事实域、入口、生命周期模型或摘要配置的指标不能直接当成公平性能对比。

通用求解器没有统一的“最多分析多少真实路径”参数。空指针在事实层限制传播，资源限制调用事实深度；闭包/内存预算属于另一个解释器。部分事实被截断后运行仍可能成功，成功不等于无限深程序的完整证明。

未知调用、动态分派、ArkIR 异常边和 SDK 不完整会影响覆盖。修改去重或摘要机制时，应验证多 caller、异常和重复发现顺序，而不只看运行时间。定向测试见 `test/ifds/`。

## 待验证优化方向

以下方向来自 TunBox 与 Telegram 的空指针分析监控和源码检查，尚未验证实现后的收益及精度影响。路径边数、不同语义 Fact 数和语句—Fact 对数是不同指标；多条路径边可能携带同一 Fact。

| 方向 | 当前成本与候选实现 | 验证重点 |
| --- | --- | --- |
| 异常契约解析 | `ExceptionPolicy.declaresThrows` 为每个方法拼接此前的文件全文。缓存行偏移、文件是否包含异常标签及语句级判断，减少大文件上的重复文本处理。 | SDK 重载、多段 JSDoc、`await` 和异常 handler 的结果一致性。 |
| 源码 effect 索引 | `NullnessSourceSemantics.excludedAt` 扫描全文件 effects，并在扫描中重复查找所属函数。按函数作用域及位置组织 effects，将作用域和访问位置计算移出扫描循环。 | guard 在写入、可能修改字段的调用、闭包和循环处仍正确失效。 |
| 静态字段相关性 | TunBox 监控中约 90.5% 的生命周期路径边携带静态字段 Fact；call flow 当前直接将所有静态字段 Fact 传入被调方法。研究传递性读写集合，筛除确定无关的字段。 | 保留调用旁路传递、跨方法写入、未知调用及后续生命周期读取；核对诊断和可达事实。 |
| 稀疏传播与编解码摘要 | Telegram 的热点位于递归 PageBlock/RichText 编解码方法及实例字段路径。研究以解引用和非空参数为汇点的需求筛选、临时变量活跃性，以及递归编解码摘要，减少访问路径的重复展开。 | 与当前边界和输入固定的基线比较，验证跨过程、递归、异步和别名传播覆盖；单独评估精度变化。 |

这些候选方向应分别实验，记录耗时、峰值内存、路径边及 Fact 数量，并区分成功、超时、OOM 和主动停止。扩大资源后完成分析，不等于已验证候选优化有效。
