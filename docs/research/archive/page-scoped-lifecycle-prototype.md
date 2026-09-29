# Page-Scoped Lifecycle Prototype

## 归档原因

Page scope 已被吸收到 canonical `hierarchical` 模型，不再作为独立方法维护或比较。本记录保留旧实验成本，防止把 Page-only 数据与统一模型混用。

## 已付出的证据成本

- controlled fixture 中，16 个候选 callback 对保留 11、删除 5，并保留显式 Home → Details route。
- 初版真实应用报告因声明式 Page owner 缺失，将 `harmony-utils` owner 记为 0 并得到 15 条诊断；该统计和诊断不可再用。
- 修正 owner 后，Page-aware 结构在四项目中减少 lifecycle path edges，但增加 CFG，未出现时间收益。

## 可复用部分

- `main_pages` / `router_map` 解析；
- Page → ViewTree custom-component closure；
- route-aware callback transition 与保守 fallback；
- Page scope 的 compact dispatcher 消融。

这些机制现均由 [Unified hierarchical lifecycle model](../method/hierarchical-lifecycle.md) 维护。
