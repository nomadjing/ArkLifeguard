# Listener 注册清理义务

## 范围与入口

检测事件监听、订阅和定时器的清理义务：注册 API 是 Source，匹配的注销/取消 API 是 Sink。结果表示未发现符合合同的清理，不证明对象被保留或发生实际内存泄漏。无需回调捕获页面；局部注册者也按 API 清理合同检查。

```bash
npm run cli -- analyze "/path/to/app" --sdk "/path/to/ets" \
  --checks listener --format json --output out/listener.json
```

[ListenerRunner](../../src/analysis/resourceleak/ListenerRunner.ts) 与资源入口共用释放义务 Runner、ResourceFact、IFDS 和 ICFG；[ListenerProblem](../../src/analysis/resourceleak/ListenerProblem.ts) 扩展注册身份与取消匹配。注册调用由规则消费，不同步执行传入的回调。

## Source、Sink 与身份

默认 SDK 规则见 [ListenerRules](../../src/analysis/resourceleak/rules/ListenerRules.ts)，按模块、类和完整方法签名匹配，不按 on/off 名字兜底。

| 家族 | Source / Sink | 匹配条件 |
| --- | --- | --- |
| interval | setInterval / clearInterval | 相同 timer token，支持别名和字段传递 |
| emitter | on / off | 相同事件和回调；省略回调时按规则取消该事件全部注册 |
| EventHub、Window、WindowStage、DataObject | on / off | 额外要求相同注册者 |
| Display | on / off | 系统注册者、事件和回调 |
| timeout、emitter once | setTimeout、once | 默认 selfExpiring 合同，不建立必须显式取消的义务 |

selfExpiring 不表示回调必然已经执行，也不证明等待期间没有保留；这些属于本项目不检查的行为。

回调身份包括别名和 bind 调用位置；两次 bind 不视为同一回调。emitter 的 `{eventId}` 与 off 的数字参数做显式投影。身份查询仅跟踪参数、接收者、字段槽位和局部到达定义，不遍历捕获环境或构造堆图。

动态事件、多调用者的不同身份、字段替换等无法唯一解析时保留低置信度未知候选，不任意挑选一个身份。匹配取消需要已知事件/注册者，不能把两个未知值当相同。当前有限调用上下文和分配点不区分同一位置的所有运行时注册实例；重复注册计数、复杂别名和容器存储尚未完整支持。

## 求解与诊断合同

与资源检查一致，同一获取上下文存在可达的匹配取消，即解除义务；不要求所有分支或异常路径都成功取消。off 调用抛异常不单独构成缺少清理。回调中或 Promise.then 中的延后取消不视为已经同步执行；完整异步调度不在当前范围。

注册义务从辅助方法传播到入口出口，避免在注册 helper 返回时过早报告。共同 DummyMain 连接生命周期方法；当前检查不是按 owner 指定最早释放期限的模型。源代码与合成入口的退出位置作为 boundary 证据，不能直接称为真实对象寿命终点。

结果为 `listenerAnalysis.diagnostics`，摘要 `listenerLeaks`。诊断包含 ruleId、allocation（注册点）、boundary、reason、confidence、evidence。典型 reason 为 unregistered、unknown-registration，错误清理/覆盖证据沿用共享事实语义。没有 capturedObject、root、retentionPath 或 closureRetentionLeaks。

模块有独立 enabled/status/success/error、未解析规则、未支持 API 目录、创建/取消调用覆盖和可选 IFDS 统计。显式空规则、规则全部未解析、非法配置或求解异常返回失败。未覆盖平台 API 不生成冒名候选。

## API 与测试

使用 `new ListenerRunner(scene, rules?, collectStatistics?).runWithDummyMain(entry)`；工程 API 为 runListenerAnalysis / listenerRules。直接入口无需 lifetimes 或堆状态预算。

相关测试集中于 `test/resourceleak/ListenerAnalysis.test.ts`，覆盖身份、取消、无捕获回调、辅助方法、自动失效和失败状态。项目不再提供 GC 根可达性、闭包捕获对象保留或堆增长检测。
