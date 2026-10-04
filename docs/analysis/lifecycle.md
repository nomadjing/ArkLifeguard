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

## 五种当前模型

| 模式 | 实现 | 控制流与适用范围 |
| --- | --- | --- |
| `flat`（默认） | `FlatLifecycleModelCreator` | 全局回调选择循环，允许回调反复组合；不使用 K |
| `opt-flat` | `OptimizedFlatLifecycleModelCreator` | 全局回调集合，使用可配置的 compact dispatcher 和可达 Ability 裁剪；不引入 Page 后继约束 |
| `bounded-opt-flat` | `BoundedOptimizedFlatLifecycleModelCreator` | 有限 K 层，每层执行零或一个回调，限制路径上的回调调用数 |
| `hierarchical` | `HierarchicalLifecycleModelCreator` | Ability 边界、Page scope、owner 回调、导航后继和未知归属 fallback；有循环，不使用 K |
| `bounded-unroll` | `LifecycleModelCreator` | 有限轮生命周期/回调扫描，生成展开 CFG；K 是扫描轮数 |

两种 bounded 模型都读取 `--max-callback-iterations`，但 K 的含义不同，不能用相同 K 宣称相同路径覆盖。循环模型的状态有界性由后续分析的事实抽象和预算处理。

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

CLI 通过 `--no-compact-lifecycle-dispatcher` 和 `--no-prune-unreachable-abilities` 关闭对应优化。普通 `flat` 与有限扫描模型的 CFG 结构不能当作 compact 模型使用。

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
