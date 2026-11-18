# 使用指南

## 环境准备

安装 Node.js（18、20 或 22 及以上版本）和 npm，准备待分析的 ArkTS 源码工程和对应的 ETS SDK。在 ArkLifeguard 仓库根目录安装依赖并查看命令帮助。

```bash
npm ci
npm run cli -- analyze --help
```

## 基本使用方法

### 命令格式

```text
npm run cli -- analyze [选项] <project-path>
```

### 参数说明

工程和 SDK

- `<project-path>`：待分析的 HarmonyOS 或 OpenHarmony 源码工程目录，必填。
- `--sdk <path>`：ETS SDK 目录，可重复指定，例如分别传入 OpenHarmony 和 HMS 的 ETS 目录。
- `--sdk-root <path>`：SDK 根目录，从其中查找 `openharmony/ets` 和 `hms/ets`。

SDK 按 `--sdk`、`--sdk-root`、仓库默认 SDK 的顺序选择。提供 `--sdk` 时只使用明确指定的目录。

检查和建模

- `--checks <checks>`：选择 `nullness`（空指针）、`resource`（资源释放）或 `listener`（监听注销）。多项用逗号分隔，例如 `resource,listener`。默认 `all`，运行全部检查。
- `--no-infer-types`：关闭 ArkAnalyzer 类型推断。
- `--no-navigation`：关闭附加导航关系收集。
- `--no-ui-callbacks`：关闭通过 ViewTree 提取 UI 回调。
- `--max-access-path-length <n>`：空指针分析追踪的访问路径最大长度，默认为 `5`。
- `--max-propagation-depth <n>`：空指针分析的最大事实传播深度，默认为 `40`。

报告和调试

- `-f, --format <format>`：报告格式，支持 `text`、`json`、`html` 和 `markdown`，默认为 `text`。
- `-o, --output <path>`：将主报告写入文件，自动创建上级目录。省略时输出到标准输出。
- `--title <title>`：设置文本、HTML 或 Markdown 报告的标题。
- `--lifecycle-report <path>`：将 Ability、组件、导航和 DummyMain 等生命周期建模信息写入单独的 JSON 文件。
- `--ifds-stats <path>`：收集资源和监听分析的 IFDS 统计，并写入单独的 JSON 文件。
- `--ifds-progress <prefix>`：按给定前缀写入求解过程的快照，资源和监听分析分别使用 `<prefix>.resource.json` 和 `<prefix>.listener.json`。
- `-v, --verbose`：显示生命周期建模日志，运行出错时同时打印可用的错误堆栈。
- `-h, --help`：显示当前命令的帮助。

在顶层使用 `npm run cli -- --version` 或 `npm run cli -- version` 查看版本。

### 使用示例

将下面的 `$APP_DIR` 和 `$ETS_SDK_DIR` 替换为应用工程目录和 ETS SDK 目录。

1. 运行全部检查，在终端查看文本报告。

    ```bash
    npm run cli -- analyze "$APP_DIR" --sdk "$ETS_SDK_DIR"
    ```

2. 只运行资源泄漏检查，把结果保存为 JSON。

    ```bash
    npm run cli -- analyze "$APP_DIR" --sdk "$ETS_SDK_DIR" \
      --checks resource --format json --output report.json
    ```

## JSON 报告

主报告包含工程信息、执行状态、诊断计数和各检查的结果。

```json
{
    "schemaVersion": 5,
    "analysisKind": "arklifeguard",
    "status": "success",
    "project": {
        "name": "<项目名>",
        "path": "<工程目录>"
    },
    "summary": {
        "nullDereferences": 0,
        "resourceLeaks": 1,
        "listenerLeaks": 0
    },
    "nullness": { "enabled": false, "success": true, "diagnostics": [] },
    "resourceAnalysis": {
        "enabled": true,
        "status": "success",
        "success": true,
        "diagnostics": [
            {
                "ruleId": "ImageSourceNotReleased",
                "reason": "unreleased",
                "confidence": "high",
                "allocation": { "filePath": "<源码文件>", "line": 10, "col": 5 },
                "boundary": { "filePath": "<源码文件>", "line": 18, "col": 5 }
            }
        ]
    },
    "listenerAnalysis": { "enabled": false, "status": "disabled", "diagnostics": [] },
    "warnings": [],
    "errors": []
}
```

### 核查诊断

1. 先看对应模块的 `enabled` 和完成状态。模块执行失败时，从 `errors` 查原因。
2. 在 `resourceAnalysis.diagnostics` 中按 `ruleId` 找到要核查的告警。以 `ImageSourceNotReleased` 为例，从 `allocation` 定位创建 `ImageSource` 的语句，再看 `boundary` 标出的检查位置。完整诊断的 `evidence` 也可用于定位。
3. 沿源码确认同一个对象是否调用了 `release()`，或是否已经交给其他代码负责释放。也要检查提前返回和异常路径。例如创建 `ImageSource` 成功后，若生成 `PixelMap` 失败，已创建的 `ImageSource` 仍需释放。结合源码判断后，再用同一条命令复查。

### 退出码

- `0`：分析执行完成。报告中可以有诊断。
- `1`：参数、输入、工程解析或报告写入等环节出错。
- `2`：已生成报告，一个或多个分析模块执行失败。

## TypeScript API

```typescript
import { ProjectAnalyzer } from './src';

const result = await new ProjectAnalyzer({
    sdkPaths: ['<ETS SDK 目录>'],
    runNullness: true,
    runResourceAnalysis: true,
    runListenerAnalysis: true,
}).analyze('<应用源码目录>');
```

API 默认启用空指针和资源分析，监听分析通过 `runListenerAnalysis` 开启。可用 `resourceRules` 和 `listenerRules` 替换默认规则。完整接口见[架构说明](docs/architecture.md)，构建和调试方法见[测试与调试](docs/testing.md)。
