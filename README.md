# ArkLifeguard

ArkLifeguard 分析 HarmonyOS/OpenHarmony ArkTS 源码工程，基于 ArkAnalyzer IR、生命周期入口和数据流/堆引用模型，输出可定位、可审查的缺陷候选。输入为源码及 ETS SDK，不支持直接分析 `.hap` / `.app` 安装包。

## 功能与边界

| 检查 | 检测内容 | 判定边界 |
| --- | --- | --- |
| `nullness` | `null`、`undefined` 及可能为空的值在解引用或非空参数位置使用 | 依赖访问路径、调用解析和库摘要；不是完整语言空安全证明 |
| `resource` | 已获得资源句柄的释放义务 | 完整 SDK 签名与规则 IFDS；默认覆盖 10 个资源家族 |
| `closure` | 未取消注册，以及注册者经回调保留生命周期已结束的对象 | 核对注册者、事件/定时器、回调身份；只有捕获链成立才报闭包保留 |
| `memory` | 生命周期结束后仍从长期根强可达的对象 | 输出保留候选；局部分配、无根循环、弱引用本身不构成泄漏 |

生命周期建模收集 Ability、页面、Component 和 UI 回调，生成共同分析入口。各检查独立启用、独立返回结果；静态候选仍需业务审查，零候选不能证明没有缺陷。

**当前默认：** CLI 运行四类检查，生命周期模型为 `flat`。资源检查直接使用规则 IFDS。API 默认运行空指针和资源检查，闭包/内存须显式开启。完整边界见[模块文档](docs/README.md)。

## 安装与运行

需要 Node.js 18、20 或 22 及以上版本、npm、待分析源码和本机 ETS SDK。SDK 不随工具安装。

```bash
npm ci
npm run cli -- analyze "/path/to/HarmonyOSApp" \
  --sdk "/path/to/openharmony/ets" \
  --checks all \
  --format json \
  --output out/report.json
```

资源分析无需选择引擎。源码运行无需构建。使用构建产物时先执行 `npm run build`，再运行 `node dist/cli/main.js analyze ...`。

常用组合：

```bash
# 查看参数，不执行分析
npm run cli -- analyze --help

# 只分析注册和对象保留
npm run cli -- analyze "/path/to/HarmonyOSApp" \
  --sdk "/path/to/openharmony/ets" --checks closure,memory \
  --format markdown --output out/retention.md

# 只分析资源释放义务
npm run cli -- analyze "/path/to/HarmonyOSApp" \
  --sdk "/path/to/openharmony/ets" --checks resource \
  --format json --output out/resource.json
```

SDK 发现、所有默认值、API 示例和退出码见[使用指南](QUICKSTART.md)。

## 结果解读

主报告支持 JSON、文本、Markdown、HTML，JSON 为 `schemaVersion: 3`、`analysisKind: "arklifeguard"`。

| 字段 | 含义 |
| --- | --- |
| `nullness.diagnostics` | 空指针候选 |
| `resourceAnalysis.diagnostics` | 资源释放义务候选；`summary.resourceLeaks` 对应其数量 |
| `closureAnalysis.registrationLeaks` / `closureRetentionLeaks` | 未取消注册 / 有捕获与生命周期证据的闭包保留 |
| `memoryAnalysis.memoryRetentionCandidates` | 有强引用链的内存保留候选 |
| `memoryAnalysis.registrationRetentions` | 注册保留关联证据，不重复计入内存主候选 |

先检查 `enabled`、`success`、`status` 和 `errors`，再检查候选及覆盖限制。预算耗尽是分析未完成，不是零缺陷。完整 API 结果包含配置与耗时；CLI 的主报告是精简视图。

## 文档与开发

- [文档索引](docs/README.md)：模块功能、核心实现与边界。
- [架构与 Runner 职责](docs/architecture.md)：共享入口、IFDS 与堆解释器。
- [维护与接口策略](docs/maintenance.md)：唯一资源入口、schema 和模块职责。
- [测试与调试](docs/testing.md)：定向测试、IR 检查、基准脚本。

代码入口为 `src/application/ProjectAnalyzer.ts`。分析模块位于 `src/analysis/`；`src/lifecycle/` 提供生命周期模型，`src/ifds/` 提供通用求解设施，`src/report/` 和 `src/cli/` 负责输出与交互。

开发时先运行修改范围内的类型检查和单元测试，遵守[最小验证策略](docs/testing.md)。`npm test` 是默认大范围套件，不是每次修改的必需命令。
