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

## 选择检查与引擎

```bash
npm run cli -- analyze "/path/to/HarmonyOSApp" \
  --sdk "/path/to/openharmony/ets" \
  --checks nullness,resource,closure,memory \
  --resource-engine new \
  --lifecycle-model flat \
  --format json --output out/report.json
```

`--checks` 支持 `all`、四个单项和逗号分隔组合。CLI 默认 `all`；未知名称是参数错误。工程路径包含空格或中文时保留引号。

资源引擎的选择独立于检查开关：

| 选择 | 实际执行 | 结果 |
| --- | --- | --- |
| `--checks resource --resource-engine legacy` | Source/Sink IFDS、方法内扫描、位置扫描 | `resourceAnalysis` |
| `--checks resource --resource-engine new` | 完整 SDK 签名与资源句柄事实 IFDS | `newResourceAnalysis`；旧资源模块标为关闭 |
| `--checks closure,memory` | 两个独立堆解释器 | `closureAnalysis`、`memoryAnalysis`；不执行资源引擎 |

**资源引擎的当前默认值仍是 `legacy`。** 新规则应接入独立引擎；两者覆盖范围并不等价，见[资源模块](docs/analysis/resource.md)。

## 参数及作用范围

| 参数 | 默认值 | 实际作用 |
| --- | ---: | --- |
| `--lifecycle-model` | `flat` | 可选 `flat`、`opt-flat`、`bounded-opt-flat`、`hierarchical`、`bounded-unroll` |
| `--max-callback-iterations` | 1 | 仅两种 bounded 模型限制回调展开；其他模型不使用 |
| `--max-abilities-per-flow` | 0 | 旧资源流经过的 Ability 数上限；0 关闭，不限制独立资源引擎 |
| `--max-navigation-hops` | 0 | 旧资源流的导航跳数上限；0 关闭，不限制独立资源引擎 |
| `--max-access-path-length` | 5 | 空指针访问路径长度 |
| `--max-propagation-depth` | 40 | 空指针及旧资源事实传播深度；不传给独立资源引擎 |
| `--max-retention-states` | 20000 | 每个闭包/内存 Runner 的状态上限 |
| `--max-retention-call-depth` | 4 | 闭包/内存的调用深度上限 |
| `--resource-engine` | `legacy` | `legacy` 或 `new` |
| `--format` | `text` | `json`、`text`、`markdown`、`html` |

独立资源引擎内部调用事实深度固定为 4，超界转为未知所有权，CLI 的传播深度参数不改变它。完整 API 的 `settings.boundEnforcement` 保留旧字段，不能据此推断这些约束已应用到独立引擎。

`--no-infer-types`、`--no-ui-callbacks`、`--no-navigation` 分别关闭类型推断、UI 回调提取、附加导航收集，可能降低覆盖。`--no-navigation` 不保证删除所有生命周期内部的路由/owner 推断。`--report-unresolved-returns` 开启未解析返回值的低置信度空指针候选。`--verbose` 显示建模日志。

`--no-compact-lifecycle-dispatcher` 与 `--no-prune-unreachable-abilities` 用于关闭对应建模优化；是否使用 compact dispatcher 取决于模型，详见[生命周期模块](docs/analysis/lifecycle.md)。

## 报告与退出码

```bash
npm run cli -- analyze "/path/to/HarmonyOSApp" \
  --sdk-root "/path/to/sdk-root" --checks all --resource-engine new \
  --format json --output out/report.json \
  --lifecycle-report out/lifecycle.json \
  --ifds-stats out/ifds.json
```

`--output` 自动创建上级目录；省略时输出到标准输出。生命周期报告单独包含模型配置、Ability、Component、导航和 DummyMain，不进入主报告。

当前 `--ifds-stats` 旁路文件只序列化旧 `resourceAnalysis` 统计；选择独立引擎时，该旁路资源统计为空。独立引擎的统计位于主 JSON 的 `newResourceAnalysis.solverStatistics`。闭包/内存统计位于各自 `statistics`，不是 IFDS 统计。不要用空旁路文件判断独立引擎没有工作。

| 退出码 | 含义 |
| --- | --- |
| 0 | 选中的分析执行完成并生成报告；发现候选不导致非零退出 |
| 1 | 参数、工程/SDK、构建 Scene 或其他顶层执行错误 |
| 2 | 已生成报告，但一个或多个分析模块失败 |

主 JSON 为 `schemaVersion: 2`，保留 `analysisKind: "lifecycle-nullness"` 字面值。它不是实际启用检查清单。完整 API 的 `settings` 记录开关；CLI 结果应根据各模块 `enabled` / `success` 解释。独立资源结果没有 `enabled` 字段：未选择时不存在，选择后查看 `status` / `success`。

旧 `summary.resourceLeaks` 和 `summary.methodLocalResourceLeaks` 只统计旧引擎；独立引擎数量取 `newResourceAnalysis.diagnostics.length`。`summary` 的注册、闭包、内存数量各自分列，不合并注册关联证据。

`high` 表示当前模型下证据较强，不代表人工确认缺陷。`low`、`unknown-ownership`、`limitations`、未支持或未解析规则均应连同源码审查。`success` 只表示运行完成，不表示全语言或全平台覆盖。

## TypeScript API

```typescript
import { ProjectAnalyzer } from './src';

const result = await new ProjectAnalyzer({
    sdkPaths: ['/path/to/openharmony/ets'],
    runNullness: true,
    runResourceAnalysis: true,
    resourceEngine: 'new',
    runClosureAnalysis: true,
    runMemoryAnalysis: true,
    lifecycleModel: 'flat',
    maxRetentionStates: 20000,
    maxRetentionCallDepth: 4,
}).analyze('/path/to/HarmonyOSApp');
```

在仓库根目录使用该导入；构建后可从 `./dist` 导入。API 默认 `runNullness=true`、`runResourceAnalysis=true`、`resourceEngine='legacy'`、`runClosureAnalysis=false`、`runMemoryAnalysis=false`。

API 可注入 `resourceRules` 和 `closureRules`，替代 SDK 默认规则。显式空资源/闭包规则会使对应检查失败；内存可使用空注册摘要，仍检查静态/全局根。`closureRules` 同时供内存解析注册根，与是否开启闭包模块无关。CLI 当前不提供规则文件参数。

直接运行某个 Runner 时，调用方负责构建 Scene、推断类型、准备入口，并为闭包/内存提供生命周期合同。详细签名见[架构](docs/architecture.md)。

## 构建与问题定位

```bash
npm run build
node dist/cli/main.js analyze "/path/to/HarmonyOSApp" \
  --sdk "/path/to/openharmony/ets" --checks closure,memory
```

构建会复制空指针 SDK 摘要 JSON，不能只运行裸 `tsc` 后假定发布产物完整。

没有候选时，依次检查：模块是否启用、运行是否完成、规则是否解析、生命周期边界是否到达、创建调用是否实际可达。独立资源的 `coverage` 提供全部/可达创建与释放调用；保留分析的 `no-observed-lifecycle-end` 表示未观测到寿命终点。

SDK 找不到时显式传 `--sdk`；大项目遇到内存不足可为 Node 设置堆上限。调试 IR 和最小测试命令见[测试与调试](docs/testing.md)。
