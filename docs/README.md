# 文档索引

本目录说明当前源码的功能、实现和使用边界。默认值与示例以 CLI、`ProjectAnalyzer` 和各模块入口为准；候选分析不等同于运行时缺陷证明。

## 使用与维护

| 文档 | 内容 |
| --- | --- |
| [项目 README](../README.md) | 功能总览与最小运行命令 |
| [使用指南](../QUICKSTART.md) | SDK、检查组合、参数、API、报告和退出码 |
| [架构](architecture.md) | 入口编排、模块依赖、Runner 和共享设施 |
| [维护与兼容策略](maintenance.md) | 唯一资源入口、当前接口与共享设施 |
| [测试与调试](testing.md) | 定向验证、IR 检查与实验运行方式 |

## 分析模块

| 模块 | 功能与核心机制 | 当前边界 |
| --- | --- | --- |
| [生命周期](analysis/lifecycle.md) | 收集框架入口，构造 DummyMain 和回调后继 | 两种可选模型；动态 owner/route 使用保守 fallback |
| [IFDS](analysis/ifds.md) | 通用事实传播、调用返回摘要、语义去重 | 提供求解机制，不定义缺陷或完整异步调度 |
| [空指针](analysis/nullness.md) | 空值访问路径、分支约束、库摘要和补充入口 | 有界、摘要驱动，受 ArkIR 与调用解析影响 |
| [资源](analysis/resource.md) | 精确 SDK 句柄义务 IFDS | 10 个默认资源家族，非全平台覆盖 |
| [闭包与注册](analysis/closure.md) | 注册身份、取消匹配、捕获链与寿命边界 | 九个摘要家族；没有完整回调执行时序 |
| [内存保留](analysis/memory.md) | 生命周期后的强引用根可达性 | 不测堆增长；附属对象归属和重复实例存在近似 |

CLI 默认四类检查、`flat` 模型；资源直接使用规则 IFDS。API 默认仅开启空指针与资源。主报告 schema 为 3，各模块有显式启用/完成状态。

## 研究方案

| 文档 | 内容 |
| --- | --- |
| [页面状态机研究判断](analysis/lifecycle-page-state-research.md) | Hidden/Visible 对资源分析的潜在收益、边界与推进门槛；尚未实现 |
| [生命周期精化实验计划](lifecycle-refinement-experiment-plan.md) | 人工补全 owner/route 与状态约束的对照实验、标注流程、判定标准及后续 LLM 实验；尚未实施 |
| [规则驱动的 Agent 辅助方案](agent-assisted-rule-analysis.md) | 资源合同补全与验证后的复用设计 |
