# DummyMain：HomeFlow 对比与整合

对照日期：2026-10-18。结论：**整合前回调集合不相等；CFG 不同构；两边各有可取之处，不能整体替换。** 当前项目保留 owner、导航、继承方法和直接构造 compact dispatcher 的实现，补齐 HomeFlow 的生命周期名称覆盖，并整合参数位置保留、继承环保护和 IR 登记方面的做法。

## 对照对象与口径

- 当前项目起始提交：`26a7b930e7669f5bbfcc0d6a03afc9acfe2cbc12`，ArkAnalyzer **1.0.90**。开始时已有的回调转移统计优化及其测试予以保留。
- HomeFlow 提交：`6785c7addc04589ae2762560b8528e071572ff7a`。`package.json` 声明 `^1.0.91`，**实际加载版本为 1.0.94**；比较的是本地安装代码，不能将它写成 1.0.91 的行为。
- HomeFlow 的 [buildEntries / prepareDummyMain](../../../homeflow/src/run.ts) 调用依赖的 [DummyMainCreater](../../../homeflow/node_modules/arkanalyzer/lib/core/common/DummyMainCreater.js)，方法表来自 [entryMethodUtils](../../../homeflow/node_modules/arkanalyzer/lib/utils/entryMethodUtils.js)。不是 HomeFlow 自己另写了一套生成器。
- 默认 `partitioned=false`、`compactLifecycleDispatch=false`；本文实测采用完整 class scope、未压缩的 HomeFlow。可选压缩实现另见 [CompactLifecycleDispatcher](../../../homeflow/src/lifecycle/CompactLifecycleDispatcher.ts)。

实测只比较 **dummyMain 直接调用目标**，排除 constructor、`%statInit`、`%instInit`，保留匿名回调；每个用例以类名和方法名去重，用例没有重载。同时报告 UI 注册数量和 CFG 块/边数量。两边分别用自身依赖构建 Scene，使用同一 fixture、测试 SDK、`inferTypes(2)`，不跨版本混用 IR 对象。

这不等于完整可达回调集合。HomeFlow 的 [RapidTypeAnalysis](../../../homeflow/src/utils/RapidTypeAnalysis.ts) 另外处理函数类型参数、回调绑定及虚拟 callback callsite；当前项目也有独立的 [CallResolver](../../src/ifds/CallResolver.ts)。不能用下面的直接调用数量断言最终分析的召回率、告警精度或性能。

## 信息量是否相等

扩展 [lifecycle-coverage](../../test/fixtures/lifecycle/lifecycle-coverage/LifecycleCoverage.ets) 同时声明双方支持的方法，修改生成器前先运行对照：

| 生命周期用例 | 不同直接目标数 |
| --- | ---: |
| HomeFlow | 53 |
| 当前 flat 整合前 | 34 |
| 交集 | 30 |
| 仅 HomeFlow | 23 |
| 仅当前项目整合前 | 4 |
| 当前项目整合后，两种模式一致 | 58 |

HomeFlow 原来多出的 23 个入口包括：

- Ability：`onWillForeground/onDidForeground/onWillBackground/onDidBackground`、`onSaveStateAsync`、`onCollaborate`、`onConfigurationUpdate`。
- UIExtension：`onSessionCreate`、其方法表中的拼写 `onSessionDestory`。
- FormExtension：`onCastToNormalForm/onChangeFormVisibility/onFormEvent/onRemoveForm/onAcquireFormState`。
- Component：`onNewParam/onDetached/pageTransition/onFormRecycle/onFormRecover/onLayout/onPlaceChildren/onMeasure/onMeasureSize`。

原有 4 个独有入口 `onBackupEx/onRestoreEx/onProcess` 和 Component `onKeyEvent` 保留；另外接受 `onSessionDestroy`，并将 `onSessionDestory` 明确标作 HomeFlow 表兼容项。这里报告的是名称接受范围，不把兼容名称表当作平台生命周期规范。

整合后的其他小型用例：

| 用例 | HomeFlow 直接目标 | 当前 flat | 当前 hierarchical | 当前 UI 注册 |
| --- | ---: | ---: | ---: | ---: |
| simple | 8 | 10 | 10 | 2 |
| complex-ui | 10 | 23 | 23 | 13 |
| callback-shapes | 1 | 5 | 5 | 4 |
| ability-scope-nesting | 13 | 15 | 14 | 3 |

前三个用例当前项目的新增直接目标来自 ViewTree UI 回调。最后一个用例中，HomeFlow 包含 `TestAbility.onForeground`；当前所有模式过滤测试源，hierarchical 还裁剪 `UnusedAbility`，所以它们的直接集合刻意不同。不能不区分输入范围和可达性就要求数量相等。

当前收集器还保留应用继承链中未被覆盖的方法，并在调用时使用具体组件/Ability 实例；HomeFlow 的该生成器遍历每个类自身的 `getMethods()`，没有为每个派生实例补齐这部分入口。owner、Page、导航目标和 UI 状态依赖也是当前项目额外保留的信息。

## CFG 结构是否一致

HomeFlow 和当前 flat 的大体阶段相似，但当前 flat 已直接使用 compact 分派：

```text
初始化 → 全局循环头 → 事件调用块 → 循环头
              └→ 销毁 → return
```

它们并不同构：HomeFlow 将 recycle/reuse、show/hide、前后台、form recycle/recover 分组为同一调用块；当前 flat 只保留原有 recycle/reuse 配对，其他事件可独立选择。HomeFlow 的分组按方法收集顺序追加，且混合多个类，组名列表本身没有保证组内实际调用次序。

**没有照搬 show/hide 等强制配对。** 把 `show → hide` 放在同一块，会限制 `show → UI callback → hide` 这样的中间交错；源码注释中的“成对”不能证明该抽象适合所有领域分析。这是控制流取舍分析，不是平台真实调度的实测结论。

当前 flat 与 HomeFlow 可选 compact 的分发形状相近：一个全局 dispatcher，每个事件块返回 dispatcher。hierarchical 则有 Ability head、Page head/event head、导航后继、fallback 和调用后 continuation，结构明显不同。不能为了同构删除这些已有信息。

整合后生命周期覆盖用例的 CFG 规模如下；事件分组和入口集合不同，数字仅描述结构：

| 模型 | 块 | 边 | 不同直接目标 |
| --- | ---: | ---: | ---: |
| HomeFlow，未压缩 | 73 | 108 | 53 |
| 当前 flat | 49 | 94 | 58 |
| 当前 hierarchical | 52 | 98 | 58 |

## 哪些生成实现更好，如何整合

| 方面 | 判断与处理 |
| --- | --- |
| 生命周期名称覆盖 | HomeFlow 覆盖了当前缺失的名称；全部补入对应家族，保留当前独有项。 |
| 共享分类 | 借鉴其集中分类的方式；收集器、两种生成器和 nullness 入口共享阶段定义，避免只扩展枚举却漏掉发射代码。 |
| 开始/结束阶段 | 加入 session 创建/销毁；共用结束生成逻辑，顺序为窗口开始销毁 → 组件 disappear/detached → 窗口销毁 → session 销毁 → Ability 销毁。自定义 `lifecycleOrder` 仍决定哪些 Ability 阶段启用。 |
| 继承环 | 采用 visited 集合保护 Ability 识别，并扩展到当前已有的继承方法收集。 |
| 参数位置 | 采用“未知类型也保留参数 Local”的处理；生命周期/UI 共用参数生成，避免前面的未知参数被跳过后造成实参错位。 |
| IR 登记 | 添加明确的 `this = @this` 起点、generated 标记；最终统一登记所有 Local、语句与 CFG/块映射，以及 Local 的 used statements。 |
| UI 回调 | 保留当前控件、状态依赖和 owner 信息；枚举补齐已支持但曾误映射成 onClick 的事件；保留同属性的全部已解析目标，并解析注册语句中的 FunctionType/AliasType 参数。全局/静态函数使用 static invoke。 |
| 子组件 receiver | 展开的自定义组件子树由子组件单独收集，防止父页面重复收集后以错误实例调用；新增回归检查。 |
| compact dispatcher | 当前 flat/hierarchical 固定直接生成 compact 结构。HomeFlow 的后处理会按块形状识别并重连整个 CFG，依赖已有布局；没有必要先生成冗余块再复制压缩器。 |
| constructor / extraInstanceAssign | 保留当前 constructor invoke 形式；不复制构造器返回值覆盖实例、`local = local` 等与 HomeFlow 下游求解器约定相关的语句。 |
| partition/classScope | 不移植。分区会改变分析边界，可能隔断 Ability 或回调组合，不属于已证明保持语义的生成优化。 |

默认仍为 flat，没有升级 ArkAnalyzer。flat 已合入纯 compact 分派，不引入 Ability 裁剪或初始化重排；hierarchical 保留原有 owner 约束。

## 验证与复现

```bash
npm run typecheck:test
npm run typecheck:scripts
./node_modules/.bin/vite-node scripts/compare-dummymain.ts ../homeflow /tmp/dummymain-comparison.json
```

[比较脚本](../../scripts/compare-dummymain.ts) 仅运行五个小型 fixture 的生成过程；无需启动 HomeFlow CLI、IFDS 分析或真实应用实验。它需要指定 HomeFlow 工作区中已安装的依赖。

入口补全已通过相关生命周期及跨调用字段传播回归。本次 compact 合并另执行 8 个直接相关模型、CLI、报告和空指针测试文件，共 69 项通过；两项类型检查及 `git diff --check` 通过。比较脚本重新运行五个用例，以上当前模型数字已更新。

没有运行全套测试、全量构建、端到端测试或真实应用基准。此次结果不能推出完整应用上的性能变化；ViewTree 构建失败仍可能缺失该组件的 UI 入口，动态函数字段、完整路由栈和所有平台生命周期语义也没有因此得到完整覆盖。
