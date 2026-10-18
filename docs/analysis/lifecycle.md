# 生命周期建模

## 功能与入口

生命周期模块将框架调用入口编码成合成方法 `@extendedDummyMain`。资源、空指针、闭包、内存从这个方法进入分析，无需真的启动应用。

[AbilityCollector](../../src/lifecycle/AbilityCollector.ts) 读取模块/页面配置、类继承和组件声明；[ViewTreeCallbackExtractor](../../src/lifecycle/ViewTreeCallbackExtractor.ts) 提取 UI 回调；[NavigationAnalyzer](../../src/lifecycle/NavigationAnalyzer.ts) 识别静态页面/Ability 导航。类、方法及 owner/route 信息交给模型创建器生成 CFG。

统一入口为 [createLifecycleModelCreator](../../src/lifecycle/LifecycleModelEntry.ts)。选择模型：

```bash
npm run cli -- analyze "/path/to/app" --sdk "/path/to/ets" \
  --checks closure,memory --lifecycle-model hierarchical \
  --lifecycle-report out/lifecycle.json
```

## 两种当前模型

| 模式 | 实现 | 控制流与适用范围 |
| --- | --- | --- |
| `flat`（默认） | `FlatLifecycleModelCreator` | 一个全局 compact dispatcher；保留全部收集对象，允许事件反复组合；不使用 K |
| `hierarchical` | `HierarchicalLifecycleModelCreator` | Ability 边界、Page scope、owner 回调、导航后继和未知归属 fallback；有循环，不使用 K |

当前生命周期模型均为循环 CFG；状态有界性由后续分析的事实抽象和预算处理。

## Hierarchical 的核心实现

[HierarchicalLifecycleModelCreator](../../src/lifecycle/HierarchicalLifecycleModelCreator.ts) 依次建立：

1. entry Ability 与可静态解析的 `startAbility` 可达关系。
2. 从页面配置、`loadContent`、ViewTree 和静态路由获取 Page/Component owner。
3. 为 owner 唯一、可解析的页面建立 scope 和回调后继。
4. 普通回调保留本 Page 后继；导航回调同时保留本地继续与已解析目标后继。
5. owner、目标未知或歧义时进入 fallback，保守连通，避免因解析失败剪掉路径。

它编码可发生的框架调用组合，不模拟完整真实路由栈。只有确定的 owner/route 信息才用于收紧后继。

## CFG 优化

compact dispatcher 从 scope head 直接连接候选 invocation，减少仅表达“执行/跳过”的条件块。它改变 CFG 表达，不将回调注册变成同步调用，也不凭自身证明更高精度或更快运行。

Ability 裁剪从 entry Ability 的静态导航闭包出发；缺少入口或存在未解析目标/owner 时保守保留。测试 Ability 过滤属于收集阶段规则。模型支持范围和开关实际是否生效应根据生成的 CFG 与统计判断。

compact dispatcher 是固定结构，不再提供关闭开关。flat 保持先创建全部实例、再调用开始阶段的顺序，不进行 Ability 可达裁剪；`--no-prune-unreachable-abilities` 只关闭 hierarchical 的对应裁剪。

本次仅压缩 flat 的条件分派链，保留事件块内的调用次序、参数、receiver 和结束阶段。按合成分派的非确定性 CFG 理解，投影掉分派语句后的有限事件序列保持；不将它表述为无限执行、任意分析域或真实应用性能的完整等价证明。

三个小型用例迁移前后的块/边分别为 `13/18 → 8/12`、`95/141 → 49/94`、`21/30 → 12/20`；对象集合、初始化、事件调用和结束阶段逐项一致，simple 用例长度不超过 3 的调用序列集合一致。

## 生命周期与分析责任

模型负责“可能调用哪个方法、以什么后继继续”。领域模块负责“传播什么事实、何时满足义务或报告”。

空指针的 `NULLNESS_LIFECYCLE_ORDER` 用于工程入口，并包含前台重入。闭包/内存只把已收集 owner 的 `onDestroy` / `aboutToDisappear` 正常出口作为当前寿命终点。它们不把任意方法 return 或页面隐藏自动解释成对象死亡。

## 边界与定位

未实现完整 Page stack、`router.back`、跨 Ability continuation 和所有动态路由语义。配置缺失、动态目标及 ViewTree 不完整会引入 fallback；不能根据 CFG 更小推断没有遗漏路径。

查看 `lifecycleStatistics` 的 owner、fallback、候选/保留后继，以及独立生命周期报告。调试时使用：

```bash
npm run inspect:dummymain -- "/path/to/app" \
  --sdk "/path/to/ets" --model hierarchical --format both
```

实现文件：[模型基类](../../src/lifecycle/LifecycleModelCreator.ts)、[Flat 模型](../../src/lifecycle/FlatLifecycleModelCreator.ts)、[模型类型](../../src/lifecycle/LifecycleTypes.ts)。相关测试位于 `test/lifecycle/`；测试覆盖不能替代完整平台事件语义。

与 HomeFlow 的入口覆盖、CFG 结构和生成实现对照，以及本次整合依据，见 [HomeFlow 对比与整合](lifecycle-homeflow-comparison.md)。

尚未实现的 Hidden/Visible 状态机是否值得推进，见 [页面状态机研究判断](lifecycle-page-state-research.md)。
