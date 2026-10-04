# 托管内存保留分析

## 判定与使用

对象在**预期 owner 生命周期结束后**仍从长期根经强引用可达时，生成 `memoryRetentionCandidates`。这是静态保留候选，不是运行时 heap size、GC 延迟或内存增长测量。

```bash
npm run cli -- analyze "/path/to/app" --sdk "/path/to/ets" \
  --checks memory --format json --output out/memory.json
```

[MemoryRunner](../../src/analysis/memory/MemoryRunner.ts) 独立运行堆解释器。即使闭包检查关闭，也直接解析注册摘要以识别系统/接收者注册边；不依赖闭包结果数组。

## 根、边与寿命合同

| 要素 | 当前建模 |
| --- | --- |
| 长期根 | 执行中写入的静态/全局槽位、已配置的系统注册根 |
| 强边 | 对象字段、已建模容器存储、回调捕获、活绑定单元 |
| 弱边 | WeakRef 等弱目标不参与强可达搜索 |
| 生命周期 | 显式合同指定的 owner 方法正常出口 |
| 附属对象 | owner 上下文中分配的对象；仅归属近似，候选降为低置信度 |

工程提供 Ability `onDestroy`、Component `aboutToDisappear`；直接 Runner 提供 `lifetimes`。配置终点尚未到达、方法没有 owner 合同或对象只有临时局部引用时，不建立该候选。

系统根来自配置摘要，不是对所有平台保留者的完整枚举。当前没有完整全局初始化/外部根发现或运行时根集合。

## 核心实现

[HeapState](../../src/analysis/shared/HeapState.ts) 存对象、槽位、已初始化绑定、根、owner 终点及不确定性。按分配点和有限调用上下文抽象对象；强更新替换引用，重复实例等不确定情况使用保守近似。

[HeapFlow](../../src/analysis/shared/HeapFlow.ts) 沿语句 CFG 保留不同路径状态，跟踪明确直接调用、参数/this、返回、赋值和内置构造。注册调用由摘要消费，不同步进入回调。

Map/Set/Array 的 set/add/push 形成存储边；clear/delete 或整个容器替换可切断对应边。并未覆盖所有容器操作或构造参数初始化语义。

`pathTo` 从根搜索强路径，读取捕获单元的当前值，排除弱目标边。在生命周期出口，Runner 对 owner 本身及其归属对象检查路径，记录分配、root、链和终点。清理方法新建的空容器不推断为已死亡 owner 的附属对象。

未知外部调用不会凭空造逃逸根；缺少摘要可能造成覆盖不足，并通过限制字段呈现。合成生命周期实例的分配位置明确标为 synthetic。

## 与其他检查的关系

显式 release/close/terminate 义务由资源检查负责；已识别的平台 native handle 不按分配即内存泄漏重复报告。

纯注册保留链放入 `registrationRetentions` 作为关联证据，不计入内存主候选。若同一 owner 另有独立静态缓存强路径，可以生成内存候选；这是另一条保留关系。这里只保留当前选取的强路径，不枚举所有运行时泄漏链。

`ArrayBuffer` 只有局部分配不报告；若从静态根强可达且存在 owner 终点，返回带归属限制的低置信度候选。对象自循环没有长期根也不报告。

## 输出与未支持范围

每条候选包含 object ID/type、allocation、root、retention path、lifecycle end、reason 和 confidence。结果有独立 enabled/success、统计、未解析及未支持注册根清单、limitations。

默认 20000 状态、4 层调用，超界失败并将部分结果降级。WeakMap/WeakSet 的 ephemeron、完整指针分析/动态分派、完整闭包环境、Page stack、跨线程/跨进程根和所有异步时序尚未建模。WeakRef 的反例通过不能证明完整弱集合语义。

`no-observed-lifecycle-end`、预算/调用超界、未知调用、重复分配及分支可行性限制都影响结果解释。零候选只表示当前入口、根集合和抽象下未发现候选。定向正反例位于 `test/memory/` 及保留夹具。
