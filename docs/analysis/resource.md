# 资源释放义务分析

## 功能与当前入口

检测有显式释放义务的句柄，关注“同一资源是否释放/转交”，不依据对象大小判断内存泄漏。

唯一入口为规则 IFDS；工程入口、CLI 和独立 Runner 使用相同合同。接口与共享设施见[维护策略](../maintenance.md)。

```bash
npm run cli -- analyze "/path/to/app" --sdk "/path/to/ets" \
  --checks resource \
  --format json --output out/resource.json
```

结果读取 `resourceAnalysis.diagnostics`；`enabled` 与 `status` 明确区分关闭、成功和失败。CLI 无引擎选择参数。

## 默认规则

[HarmonyResourceRules](../../src/analysis/resourceleak/rules/HarmonyResourceRules.ts) 从本地 SDK 的模块、声明类、方法/重载和调用点绑定完整签名。项目自定义同名 `release` / `close` 不会被当成平台释放 API。

| 规则 ID | 获得资源 | 释放义务 |
| --- | --- | --- |
| `HttpRequestNotDestroyed` | HTTP request | `HttpRequest.destroy` |
| `FileNotClosed` | `@ohos.file.fs` 的 open/openSync | close/closeSync，支持显式 `File.fd` 投影 |
| `FileIONotClosed` | `@ohos.fileio` 的 open/openSync | close/closeSync |
| `ImageSourceNotReleased` | ImageSource | release |
| `PixelMapNotReleased` | 工厂或 ImageSource 的 PixelMap | release |
| `ImagePackerNotReleased` | ImagePacker | release |
| `AVPlayerNotReleased` | AVPlayer | release |
| `AudioRendererNotReleased` | AudioRenderer | release |
| `AudioCapturerNotReleased` | AudioCapturer | release |
| `ResultSetNotClosed` | RdbStore 的 query/querySql 等结果集 | ResultSet.close |

这是 10 个资源家族，不是所有 HarmonyOS 资源 API。Worker/ThreadWorker terminate、AVRecorder、其他 socket/camera 等未列出的 API 没有默认规则。已知缺口由 [ResourceCapabilities](../../src/analysis/resourceleak/rules/ResourceCapabilities.ts) 定义，并通过 `unsupportedApiFamilies` 输出；它不是实际调用清单或完整平台枚举。

API 通过 `resourceRules` 或直接 `ResourceRunner` 注入 [ResourceRule](../../src/analysis/resourceleak/rules/ResourceRule.ts)，字段包括规则 ID、完整 API 签名、句柄位置、异步获取方式、投影和是否允许 nullify。规则数组替代默认集；空集或所有默认规则未解析时明确失败，不进行同名匹配或其他分析回退。接口存在 `static` 位置标签，不等于已经支持任意静态槽位/容器所有权。

## 事实及传播

[ResourceFact](../../src/analysis/resourceleak/ResourceFact.ts) 身份由规则、分配点、有限别名、状态、有限调用帧和关键事件构成，不含无界完整路径。

| 状态 | 含义 |
| --- | --- |
| `allocated` | 已获得资源，义务尚未解除 |
| `pending` | Promise 尚未映射到兑现句柄 |
| `released` | 匹配到释放 |
| `escaped` | 事实域保留的转交状态；不表示完整逃逸分析 |
| `unknown` | 获取、所有权或执行关系不确定 |

[ResourceProblem](../../src/analysis/resourceleak/ResourceProblem.ts) 实现 normal/call/return/bypass 流，映射局部别名、参数、工厂返回和接收者字段。局部键包含方法作用域，避免不同方法临时变量混淆。

创建/释放调用按规则合同直接处理；已知直接被调摘要负责对应资源路径，避免 unchanged bypass 把已经释放的事实重新带回。Promise 获取先记 pending，`await` 可映射到兑现句柄；未建模回调/外部转交保守返回未知所有权。

内部资源调用帧深度固定为 4，超界降级为未知。工程的 `maxPropagationDepth` 只约束空指针；资源不接受 Ability 数或导航跳数传播参数。

## 诊断与覆盖

[ResourceRunner](../../src/analysis/resourceleak/ResourceRunner.ts) 从求解后的 return/throw 出口收集候选，按规则和分配点合并多出口。优先选择创建方法本身的出口作为边界证据；这是义务出口判定，不能将所有诊断边界描述成真实对象销毁时刻。

候选理由为 `unreleased`、`partially-released`、`overwritten`、`wrong-release`、`unknown-ownership`，附分配点、边界和关键位置证据。方法返回/接收者字段转交按当前模型处理；没有完整多容器/多实例所有权证明。

`coverage` 分别统计全部/入口可达的创建与释放调用。`unresolvedRuleIds` 表示 SDK 绑定失败。创建调用未到达时的零候选，不是该调用被证明安全。统计开启时，完整 API 在 `solverStatistics` 中提供 IFDS 指标，CLI 通过 `--ifds-stats` 单独输出；主用户报告省略指标。

## 边界与验证

方法内扫描、Source/Sink 位置列表与污点标签不属于资源结果。新增规则必须使用完整 SDK 签名和句柄位置，不以方法同名替代平台合同。默认清单的未支持 API 家族不因自定义规则注入而自动更新，需审查实际规则。

定向测试位于 `test/resourceleak/`，工程入口夹具包含真实 SDK API 调用与项目同名 API 反例。功能边界包括不完整异步调度、复杂静态/容器所有权及精度真值不足；真实工程成功执行只证明该次运行完成。
