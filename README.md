# ArkLifeguard

ArkLifeguard 是面向 HarmonyOS 和 OpenHarmony 应用的数据流分析工具。它读取 ArkTS 应用源码和 ETS SDK报告应用代码的潜在缺陷并给出依据。

## 检查内容

| 检查                                                          | 典型问题                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [空指针分析](docs/analysis/nullness.md)（`nullness`）         | 读取可能为 `null` 或 `undefined` 的值的属性，或将该值传给要求非空的参数 |
| [资源泄漏与内存泄漏](docs/analysis/resource.md)（`resource`） | 打开的文件未关闭，或创建的 `PixelMap` 未调用 `release()`                |
| [闭包泄漏](docs/analysis/closure.md)（`listener`）            | 事件监听注册后未注销，或 `setInterval()` 创建的定时器未清除             |

资源检查覆盖规则中定义的 API，包括文件、网络、媒体、数据库和图像资源。其中内存泄漏指 `PixelMap` 等对象缺少显式释放，闭包泄漏指回调注册缺少匹配的注销。闭包检查根据注册者、事件、回调或句柄匹配清理操作，无捕获的回调也在检查范围内。

项目不支持检查GC 可达性、闭包捕获对象的保留和普通对象或容器增长。

## 分析方式

ArkLifeguard 使用 ArkAnalyzer 解析工程并推断类型，根据 Ability 和组件的生命周期、UI 回调及导航关系构造分析入口。三类检查在此基础上分别追踪空值传播、资源释放和注册清理。检查结果受调用解析、框架建模和规则覆盖影响，报告中的候选问题需要结合源码和业务行为确认。

## 使用指南

准备 ArkTS 应用源码和 ETS SDK 后，按[快速开始](QUICKSTART.md)安装依赖并运行首次分析。

## 开发文档

- [文档索引](docs/README.md)汇总各分析模块及其覆盖范围。
- [架构说明](docs/architecture.md)介绍工程入口、生命周期建模和分析模块之间的关系。
- [维护指南](docs/maintenance.md)和[测试与调试](docs/testing.md)记录接口约定和验证方法。
