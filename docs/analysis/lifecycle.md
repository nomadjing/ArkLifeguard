# 生命周期建模

## 唯一生成器与入口

生命周期模块统一生成 compact flat `@extendedDummyMain`。资源、空指针、闭包和内存分析从这个合成方法进入，无需启动应用。

统一入口为 [createLifecycleModelCreator](../../src/lifecycle/LifecycleModelEntry.ts)：

```typescript
const creator = createLifecycleModelCreator(scene, {
  enableViewTreeParsing: true,
});
creator.create();
const dummyMain = creator.getDummyMain();
```

第二个参数仅接受建模配置。项目分析器与 CLI 不再提供模型选择、Page scope、fallback 调度或 Ability 可达裁剪选项。

```bash
npm run cli -- analyze "/path/to/app" --sdk "/path/to/ets" \
  --checks closure,memory --lifecycle-report out/lifecycle.json
```

## 收集与控制流

[AbilityCollector](../../src/lifecycle/AbilityCollector.ts) 收集运行时 Ability、组件和生命周期声明；[ViewTreeCallbackExtractor](../../src/lifecycle/ViewTreeCallbackExtractor.ts) 提取 UI 回调。[NavigationAnalyzer](../../src/lifecycle/NavigationAnalyzer.ts) 与收集器保留导航、页面及组件归属元数据，供报告使用；这些信息不约束 flat 事件后继。

生成器保留全部收集对象，先执行静态初始化、创建实例，再执行开始阶段生命周期方法。随后进入一个全局 compact dispatcher，每次选择一个事件，执行后返回调度头，也可以进入收尾阶段并返回。

```text
初始化 → 全局调度头 ┬→ 事件 A → 调度头
                   ├→ 事件 B → 调度头
                   └→ 收尾 → 返回
```

compact dispatcher 直接连接事件调用块，避免额外的逐事件条件分派链。每个事件调用拥有唯一的直接返回后继。它允许事件重复与组合，不模拟完整的页面状态机、真实路由栈或跨 Ability 执行协议。

测试源过滤属于收集规则；Page/Ability 归属不会被用来删除运行时事件。回调的收集与后续异步语义仍需区分，合成调度结构本身不证明平台执行顺序完整或分析精度充分。

## 分析责任与报告

DummyMain 决定方法入口及其调度后继，领域模块决定事实传播、资源义务和诊断规则。空指针入口使用 `NULLNESS_LIFECYCLE_ORDER`，包含前台重入；闭包／内存只把已收集 owner 的 `onDestroy`／`aboutToDisappear` 正常出口作为当前寿命终点。

`lifecycleStatistics` 仅提供收集到的 Ability、Component 和 UI 回调数量。独立生命周期报告为 `schemaVersion: 2`，删除了分层裁剪与 scope 转移统计；主诊断报告仍为 `schemaVersion: 3`。

查看生成的 IR 和伪代码：

```bash
npm run inspect:dummymain -- "/path/to/app" \
  --sdk "/path/to/ets" --format both
```

实现：[共享构造逻辑](../../src/lifecycle/LifecycleModelCreator.ts)、[flat CFG 生成器](../../src/lifecycle/FlatLifecycleModelCreator.ts)、[类型与配置](../../src/lifecycle/LifecycleTypes.ts)。相关测试位于 `test/lifecycle/`。历史实验结果保留作研究记录，不表示当前实现仍提供分层模型。
