# Unified Hierarchical Lifecycle Model

## 状态

当前唯一的生命周期结构主线。已有结构精度正向证据；性能收益尚未成立。

## 方法动机

Flat dispatcher 允许任意 callback 直接接到任意 callback。旧 Ability-only hierarchy 不能区分同一 Ability 内互斥 Page；独立 Page-scope 又不应作为另一条平行方法维护。

统一模型沿 ownership 链组织 CFG：

```text
Ability lifecycle boundary
  -> Ability-owned Page scope
       -> Page/ViewTree-owned component callback
       -> same Page callback
       -> statically resolved target Page
```

## 核心机制

- `module.json5`、`loadContent` 和静态 Ability navigation 建立 Ability owner。
- `main_pages`、`router_map`、ViewTree custom-component closure 建立 Page owner。
- 只有唯一可达 Ability owner 和唯一 Page owner 的组件进入精确 Page scope。
- 普通 callback 回到本 Page；静态 router/NavPathStack 目标进入目标 Page。
- owner 或目标未知、歧义时进入 fallback；解析失败绝不作为剪枝理由。
- `onPageShow` 可以在同一 Page scope 内重复触发，不重新开放跨 Page callback。
- compact dispatcher 是独立 CFG 表达优化，不是该模型的语义前提。

## 实现

- 入口：`createLifecycleModelCreator(scene, 'hierarchical')`
- 模型实现：[HierarchicalLifecycleModelCreator.ts](../../src/lifecycle/HierarchicalLifecycleModelCreator.ts)
- owner 与 route graph：[AbilityCollector.ts](../../src/lifecycle/AbilityCollector.ts)

旧 Ability-only 实现和独立 `page-scope` mode 已删除，历史 Page-only 记录见 archive。

## 当前证据

### 结构语义

controlled Page fixture 含 1 个 Ability、2 个 Page、1 个嵌套 custom component 和一条显式 route：4 个 callback 都被保留；通过穷举实际 CFG reachability，16 个候选 callback 对中保留 11、删除 5；普通 Home → Details 直接跳转不可达，而显式 router 跳转仍可达。带 route 的 callback 同时保留本 Page 与已解析目标后继，避免把路由必然成功当成事实。

结构审计的原始计数为：`opt-flat` 11 blocks / 18 edges / 1 dispatcher，`hierarchical` 15 / 26 / 5。将 dispatcher 视为 Page 状态并归一化为 callback transition graph 后，得到上述 4 个 callback / 11 条合法有序边。当前 Page-specific dispatcher 是对后继集合的共享编码；单一全局 dispatcher 会丢失来路 Page，而直连所有合法 callback pair 又不是 compact 编码。因此不再新建 `constraint-fused compact` 平行模式。

统一后，12 条 lifecycle path oracle 仍全部通过，包括 Ability scope、合法前台重入和重复 `onPageShow`。

### Page-local propagation 结论

四个真实项目上的只读 opportunity profiling 表明，满足“唯一 Page owner 的
`syntheticPageInstance.field`”候选进入 foreign Page invocation block 的工作量，
只占 lifecycle processed edges 的 0.1614%、propagation attempts 的 0.1179%。
因此不实现 Page-local proof 或 bypass；profiling 代码已删除，完整结果见
[归档记录](../archive/page-local-propagation-profile.md)。

## 已知限制

- 未知 Page owner 和动态 route 走 fallback，可能稀释剪枝收益。
- 未建模完整 Page stack、`router.back` 或跨 Ability continuation 状态。
- 真实应用缺少非空 diagnostics oracle；诊断集合相同和结构精度证据都不能替代 precision ground truth。
