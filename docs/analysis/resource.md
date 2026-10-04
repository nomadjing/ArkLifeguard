# 资源释放义务分析

## 功能与当前入口

检测有显式释放义务的句柄，关注“同一资源是否释放/转交”，不依据对象大小判断内存泄漏。

当前有两条可执行路径：默认旧 Source/Sink 引擎和独立规则 IFDS。新增规则与核心功能以独立引擎为落点；旧路径的退役条件见[维护策略](../maintenance.md)。

```bash
npm run cli -- analyze "/path/to/app" --sdk "/path/to/ets" \
  --checks resource --resource-engine new \
  --format json --output out/resource.json
```

选择独立引擎时，旧资源块标为关闭；结果只读取 `newResourceAnalysis`。省略引擎参数会执行旧路径。

## 独立引擎的默认规则

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

这是 10 个资源家族，不是所有 HarmonyOS 资源 API。Worker/ThreadWorker terminate、AVRecorder、其他 socket/camera 等未列出的 API 没有默认独立规则；不能因旧表含这些名字就声称独立引擎支持。

API 通过 `resourceRules` 或直接 `ResourceRunner` 注入 [ResourceRule](../../src/analysis/resourceleak/rules/ResourceRule.ts)，字段包括规则 ID、完整 API 签名、句柄位置、异步获取方式、投影和是否允许 nullify。规则数组替代默认集；空集或所有默认规则未解析时明确失败，不回退到旧引擎。接口存在 `static` 位置标签，不等于已经支持任意静态槽位/容器所有权。

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

内部资源调用帧深度固定为 4，超界降级为未知。工程的 `maxPropagationDepth`、Ability 数和导航数约束没有传入此 Runner，不约束新引擎。

## 诊断与覆盖

[ResourceRunner](../../src/analysis/resourceleak/ResourceRunner.ts) 从求解后的 return/throw 出口收集候选，按规则和分配点合并多出口。优先选择创建方法本身的出口作为边界证据；这是义务出口判定，不能将所有诊断边界描述成真实对象销毁时刻。

候选理由为 `unreleased`、`partially-released`、`overwritten`、`wrong-release`、`unknown-ownership`，附分配点、边界和关键位置证据。方法返回/接收者字段转交按当前模型处理；没有完整多容器/多实例所有权证明。

`coverage` 分别统计全部/入口可达的创建与释放调用。`unresolvedRuleIds` 表示 SDK 绑定失败。创建调用未到达时的零候选，不是该调用被证明安全。统计开启时在 `solverStatistics` 中输出 IFDS 指标。

## 当前旧资源路径

`analysis/resource` 包含规则管理、旧 Fact/Problem/Solver/Runner、方法内扫描、位置扫描及结果抑制。默认规则只加载资源类别，注册和分配即内存泄漏标签已移出默认集合。

旧匹配仍有模式/同名 fallback；方法内检测是两遍扫描，结构性 timer/file 抑制也不能提供完整身份与路径证明。`resourceAnalysis.resourceLeaks` 与 `methodLocal.leaks` 分别保存，不能相加当成已确认缺陷。`taintLeaks` 不构成完整隐私污点能力。

`SourceSinkManager(true)` 是明确 opt-in 的旧混合表访问，不属于标准独立引擎。旧规则更多不代表更准；新旧结果不要求相同，不混合输出或统计。

定向测试位于 `test/resourceleak/` 和当前旧 `test/resource/`。功能边界还包括不完整异步调度、复杂静态/容器所有权及精度真值不足；真实工程成功执行只证明该次运行完成。
