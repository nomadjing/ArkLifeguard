# 使用指南

## 环境与 SDK

安装依赖后可直接从源码运行 CLI：

```bash
npm ci
npm run cli -- analyze --help
```

需要 Node.js 18、20 或 22 及以上版本和可读的 ArkTS 源码工程。项目通常包含 `build-profile.json5`、模块 `module.json5`、`.ets` / `.ts` 文件。完整模块配置有助于识别入口 Ability 和页面。

SDK 选择按以下顺序：

1. 显式 `--sdk <ETS目录>`，可重复指定；提供后不再从 SDK root 发现。
2. `--sdk-root <目录>` 下的 `openharmony/ets` 和 `hms/ets`。
3. 仓库的 `sdk/default/openharmony/ets`、`sdk/default/hms/ets`。

至少需要一个有效 SDK 目录，且类型推断须能解析使用的 API。目录存在不表示每条规则都已解析，应检查 `unresolvedRuleIds`。

## 选择检查

```bash
npm run cli -- analyze "/path/to/HarmonyOSApp" \
  --sdk "/path/to/openharmony/ets" \
  --checks nullness,resource,listener \
  --format json --output out/report.json
```

`--checks` 支持 `all`、三个单项和逗号分隔组合。CLI 默认 `all`；未知名称是参数错误。工程路径包含空格或中文时保留引号。

| 检查 | 实际执行 | 结果 |
| --- | --- | --- |
| `--checks resource` | 完整 SDK 签名与资源句柄事实 IFDS | `resourceAnalysis` |
| `--checks listener` | 注册清理义务 IFDS | `listenerAnalysis.diagnostics`；资源模块关闭 |

资源只有一个规则引擎，无需选择实现。覆盖与限制见[资源模块](docs/analysis/resource.md)。

## 参数及作用范围

| 参数 | 默认值 | 实际作用 |
| --- | ---: | --- |
| `--max-access-path-length` | 5 | 空指针访问路径长度 |
| `--max-propagation-depth` | 40 | 空指针事实传播深度；不约束资源检查 |
| `--format` | `text` | `json`、`text`、`markdown`、`html` |

资源内部调用事实深度固定为 4，超界转为未知所有权，CLI 的传播深度参数不改变它。完整 API 的 `settings.resourceBounds.maxCallDepth` 单独记录该约束。

`--no-infer-types`、`--no-ui-callbacks`、`--no-navigation` 分别关闭类型推断、UI 回调提取、附加导航收集，可能降低覆盖。`--no-navigation` 不保证删除所有生命周期内部的路由/owner 推断。`--report-unresolved-returns` 开启未解析返回值的低置信度空指针候选。`--verbose` 显示建模日志。

DummyMain 统一使用 compact flat dispatcher，保留全部收集对象，无需选择模型或配置 Ability 裁剪。详见[生命周期模块](docs/analysis/lifecycle.md)。

## 报告与退出码

```bash
npm run cli -- analyze "/path/to/HarmonyOSApp" \
  --sdk-root "/path/to/sdk-root" --checks all \
  --format json --output out/report.json \
  --lifecycle-report out/lifecycle.json \
  --ifds-stats out/ifds.json
```

`--output` 自动创建上级目录；省略时输出到标准输出。生命周期报告单独包含模型配置、Ability、Component、导航和 DummyMain，不进入主报告。

`--ifds-stats` 开启资源/listener IFDS 统计并写入 schema 2 旁路 JSON。完整 API 的 solverStatistics 在主用户报告中省略；未启用模块或未产生统计时 statistics 为 null。

| 退出码 | 含义 |
| --- | --- |
| 0 | 选中的分析执行完成并生成报告；发现候选不导致非零退出 |
| 1 | 参数、工程/SDK、构建 Scene 或其他顶层执行错误 |
| 2 | 已生成报告，但一个或多个分析模块失败 |

主 JSON 为 `schemaVersion: 5`、`analysisKind: "arklifeguard"`。完整 API 的 `settings` 记录检查开关；主报告包含各模块 `enabled` / `success`。资源和 listener 包含 `status: disabled/success/failed`，未启用时仍有显式关闭结果。

`summary.resourceLeaks` 对应 `resourceAnalysis.diagnostics.length`。listener 数量为 summary.listenerLeaks，对应 listenerAnalysis.diagnostics.length。失败时空数组表示未得到诊断，不表示工程安全。

资源与 listener 的 unsupportedApiFamilies 是默认模型已知缺口目录，不是实际调用清单或完整平台覆盖枚举。

`high` 表示当前模型下证据较强，不代表人工确认缺陷。`low`、`unknown-ownership`、`unknown-registration`、未支持或未解析规则均应连同源码审查。`success` 只表示运行完成，不表示全语言或全平台覆盖。

## TypeScript API

```typescript
import { ProjectAnalyzer } from './src';

const result = await new ProjectAnalyzer({
    sdkPaths: ['/path/to/openharmony/ets'],
    runNullness: true,
    runResourceAnalysis: true,
    runListenerAnalysis: true,
}).analyze('/path/to/HarmonyOSApp');
```

在仓库根目录使用该导入；构建后可从 `./dist` 导入。API 默认 `runNullness=true`、`runResourceAnalysis=true`、`runListenerAnalysis=false`。

API 可注入 resourceRules 和 listenerRules 替代 SDK 默认规则。显式空规则使对应模块失败；CLI 当前不提供规则文件参数。旧 memory/closure 开关、保留链结果和堆预算参数已移除。

直接运行某个 Runner 时，调用方负责构建 Scene、推断类型、准备入口，不需要提供旧的 lifetimes 合同。详细签名见[架构](docs/architecture.md)。

## 构建与问题定位

```bash
npm run build
node dist/cli/main.js analyze "/path/to/HarmonyOSApp" \
  --sdk "/path/to/openharmony/ets" --checks resource,listener
```

构建会复制空指针 SDK 摘要 JSON，不能只运行裸 `tsc` 后假定发布产物完整。

没有候选时，依次检查模块启用、运行完成、规则解析和获取调用可达性。资源/listener 的 coverage 提供全部与可达的获取、清理调用统计。

SDK 找不到时显式传 `--sdk`；大项目遇到内存不足可为 Node 设置堆上限。调试 IR 和最小测试命令见[测试与调试](docs/testing.md)。
