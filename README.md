# ArkLifeguard

ArkLifeguard 是面向 HarmonyOS/OpenHarmony 应用的静态分析工具，分析对象为 ArkTS 源码工程，支持空值使用、资源释放义务和 listener 注册清理三类检查。工具无需运行应用，输出包含问题位置和相关证据的分析报告，帮助开发者排查缺陷，也为研究者提供可审查的分析结果。

分析需要应用源码及对应的 ETS SDK，目前不支持直接分析编译后的 `.hap` 安装包。

## 功能与边界

| 检查 | 检测内容 | 检查范围与限制 |
| --- | --- | --- |
| 空值使用（`nullness`） | 可能为 `null` 或 `undefined` 的值被用于访问属性、调用方法，或传给要求非空的参数 | 结果受可分析的调用关系和外部库行为影响，不能保证发现所有空值错误 |
| [资源泄漏与内存泄漏（`resource`）](docs/analysis/resource.md) | 已获得的资源或显式内存对象没有按要求释放 | 包含文件、网络、媒体、数据库和显式图像内存；仅检查规则覆盖的 API |
| [闭包泄漏（`listener`）](docs/analysis/closure.md) | 监听注册、订阅或定时器缺少匹配取消 | 匹配注册者、事件、回调或 token；不分析捕获对象与 GC 保留 |

分析报告中的问题是待确认的缺陷候选，可能存在误报,需要结合业务行为审查；没有报告问题不代表程序一定没有缺陷。各类检查的详细范围见[模块文档](docs/README.md)。

本项目讨论的 memory（内存泄漏）限定为涉及内存的显式清理义务，例如 PixelMap 的 release，归入 `resource` 检查；closure（闭包泄漏）限定为注册回调的清理义务，例如事件监听未 off、周期定时器未 clearInterval，归入 `listener` 检查。这些术语与 typescript_lifecycle 的规则分类口径一致，不表示两个额外分析入口，也不表示覆盖其全部 API。closure 告警不要求回调捕获页面或业务对象；无捕获回调也可能缺少注销。项目不检查 GC 根可达性、闭包捕获对象保留、普通对象或容器增长，当前不扩大至这些范围。

## 安装与运行

准备应用源码和 ETS SDK，按[使用指南](QUICKSTART.md)完成环境配置、安装与首次分析。

## 文档与开发

- [使用指南](QUICKSTART.md)：环境配置、运行参数、报告与 API 用法。
- [模块文档](docs/README.md)：各类分析的功能与限制。
- [架构说明](docs/architecture.md)、[维护指南](docs/maintenance.md)、[测试与调试](docs/testing.md)。
