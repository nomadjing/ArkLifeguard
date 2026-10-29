# 资源泄漏与内存泄漏分析

## 功能与当前入口

本模块同时分析资源泄漏和内存泄漏，二者统一为显式释放义务：成功获得对象或句柄后，应在相应生命周期内执行匹配释放，或将义务转交给明确的责任对象。

| 分类 | 本项目含义 | 已覆盖的典型对象 |
| --- | --- | --- |
| 资源泄漏 | 系统或 SDK 资源缺少显式清理 | 文件、HTTP request、播放器、数据库结果集 |
| 内存泄漏（memory） | 涉及内存的对象缺少显式清理 | ImageSource、PixelMap、ImagePacker |

两类问题共享 ResourceRunner、规则集合和一次 IFDS 求解，CLI 统一使用 resource，报告统一输出 resourceAnalysis；没有独立 memory 入口。分类用于说明对象及清理责任，不把同一获取点重复算作两项缺陷。监听和定时器的清理见[闭包泄漏分析](closure.md)。

memory 沿用 typescript_lifecycle 的规则分类口径，但 API 覆盖以本项目规则为准，例如 Worker 终止尚无默认规则。普通 ArrayBuffer、对象或容器的分配与增长、GC 可达性及闭包捕获对象保留不在范围内。当前调整仅完善显式清理分析，不扩大到这些问题。

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
| `PixelMapNotReleased` | image 或 ImageSource 的 PixelMap 工厂 | release |
| `ImagePackerNotReleased` | ImagePacker | release |
| `AVPlayerNotReleased` | AVPlayer | release |
| `AudioRendererNotReleased` | AudioRenderer | release |
| `AudioCapturerNotReleased` | AudioCapturer | release |
| `ResultSetNotClosed` | RdbStore 的 query/querySql 等结果集 | ResultSet.close |

这是 10 个资源家族，不是所有 HarmonyOS 资源 API。Worker/ThreadWorker terminate、AVRecorder、其他 socket/camera 等未列出的 API 没有默认规则。已知缺口由 [ResourceCapabilities](../../src/analysis/resourceleak/rules/ResourceCapabilities.ts) 定义，并通过 `unsupportedApiFamilies` 输出；它不是实际调用清单或完整平台枚举。

API 通过 `resourceRules` 或直接 `ResourceRunner` 注入 [ResourceRule](../../src/analysis/resourceleak/rules/ResourceRule.ts)，字段包括规则 ID、完整 API 签名、句柄位置、异步获取方式、投影和是否允许 nullify。规则数组替代默认集；空集或所有默认规则未解析时明确失败，不进行同名匹配或其他分析回退。接口存在 `static` 位置标签，不等于已经支持任意静态槽位/容器所有权。

## 事实及传播

[ResourceFact](../../src/analysis/resourceleak/ResourceFact.ts) 身份由规则、分配点、获取返回上下文、有限别名、状态、有限调用帧和关键事件构成，不含无界完整路径。`acquisitionContext` 初始为空；被调中新建的资源经返回值或接收者字段转交调用方时，追加该返回调用位置，按由内到外的顺序保留最近 4 层。中间工厂调用的区别不会被单个外层返回位置立即覆盖。已有资源进入清理函数并返回时保留原上下文；别名、参数和回调传播也保持一致。

| 状态 | 含义 |
| --- | --- |
| `allocated` | 已获得资源，义务尚未解除 |
| `pending` | Promise 尚未映射到兑现句柄 |
| `released` | 匹配到释放 |
| `escaped` | 事实域保留的转交状态；不表示完整逃逸分析 |
| `unknown` | 获取、所有权或执行关系不确定 |

[ResourceProblem](../../src/analysis/resourceleak/ResourceProblem.ts) 实现 normal/call/return/bypass 流，映射局部别名、参数、工厂返回和接收者字段。局部键包含方法作用域，避免不同方法临时变量混淆。

创建/释放调用按规则合同直接处理；已知直接被调摘要负责对应资源路径，避免 unchanged bypass 把已经释放的事实重新带回。Promise 获取先记 pending，`await` 和内建 Promise 的 `.then` 成功回调可映射到兑现句柄；闭包捕获按词法环境映射同一资源。未建模回调/外部转交保守返回未知所有权。

当前实现检查同一资源是否存在可达的匹配释放，并用该证据过滤其他出口的普通未释放候选；它接受条件释放，可能遗漏正常分支绕过释放的情况。资源身份由分配点和有界获取返回上下文近似，不等于同一运行实例的证明。错误对象释放、不可达释放和缺少释放不会履行本资源的义务。异常流不因失败的申请调用创建资源，也不把尚未返回的值当作成功赋值。

目标合同是在责任 owner 的生命周期边界检查释放义务。不因匹配 release 操作自身可能抛异常而报告，不等于忽略条件分支绕过释放。条件清理、释放前异常和异步边界的判定尚待实现调整，具体建议见[清理义务改进方案](../architecture.md#清理义务改进方案待实现)。本文对当前实现的说明不代表这些目标已经实现。

最后句柄被覆盖是独立的义务丢失证据：保留空句柄的未释放事实，在覆盖位置报告 `overwritten`，不再用同一静态获取上下文的其他释放事实将其免报。跨调用返回时，共享字段按被调输出恢复，不能重新加入已被覆盖的旧字段；调用者仍持有的局部别名继续保留。尚有别名、覆盖前已经释放的事实不属于最后句柄丢失。单纯的条件释放仍接受；但“某分支返回原资源、另一分支替换最后句柄”不再由原资源分支的释放消除覆盖分支的报告。

内部资源调用帧深度固定为 4，超界降级为未知。调用帧用于恢复参数与别名，获取返回上下文用于身份匹配，两种边界独立。工程的 `maxPropagationDepth` 只约束空指针；资源不接受 Ability 数或导航跳数传播参数。

## 诊断与覆盖

[ResourceRunner](../../src/analysis/resourceleak/ResourceRunner.ts) 从求解事实汇总同一规则、同一分配点、同一获取返回上下文的释放证据，该上下文也参与求解事实身份。普通未释放候选仍在 return/throw 出口按此证据过滤；空句柄的覆盖义务独立收集，边界定位到覆盖语句，并按来源与覆盖位置去重。在调用帧尚未恢复时暂不将局部空句柄视为全部别名丢失，以免忽略调用者持有的别名。最终按规则和分配点合并诊断，优先保留覆盖证据。报告去重不先用于合并不同上下文的释放义务。普通出口候选优先选择创建方法本身的出口；`return await resourcePromise` 和 cast 包装也按返回转交处理，避免在异步工厂内部重复报告。这些边界不都等同于真实对象销毁时刻。

候选理由为 `unreleased`、`overwritten`、`wrong-release`、`unknown-ownership`，附分配点、边界和关键位置证据。`partially-released` 保留为结果类型兼容值；同一获取上下文的匹配释放只过滤普通出口候选，不过滤最后句柄丢失的覆盖证据。覆盖前所有权已降级为未知时，覆盖诊断仍为低置信度，不提升为已证实泄漏。方法返回/接收者字段转交按当前模型处理；没有完整多容器/多实例所有权证明。上下文最多保留 4 层返回调用，超出的内层区别会被合并；同一静态上下文在循环或递归中执行多次也不自动得到独立实例身份。

`coverage` 分别统计全部/入口可达的创建与释放调用。`unresolvedRuleIds` 表示 SDK 绑定失败。创建调用未到达时的零候选，不是该调用被证明安全。统计开启时，完整 API 在 `solverStatistics` 中提供 IFDS 指标，CLI 通过 `--ifds-stats` 单独输出；主用户报告省略指标。

## 资源身份的精度边界

完整 API 签名用于识别合同，不能作为运行时资源身份。同一工厂在不同调用方、不同 owner 或不同生命周期执行，可以产生不同资源；一个资源的释放不得消除另一个资源的义务。当前使用最多 4 层获取返回上下文区分部分调用，返回、别名和字段传播保持该上下文，报告汇总前保留这些区别。

有界上下文仍会合并深层包装、循环、递归和生命周期重入的实例。当前 owner 与生命周期边界尚未显式进入义务身份；复杂容器、字段别名和外部转交也不能形成完整的所有权证明。最后句柄覆盖证据可发现部分旧资源义务丢失，但不能解决全部实例混淆。

改进时应保持获取、转交、匹配释放和报告去重的身份一致，结合 owner 边界逐步验证，不通过无限调用链或无限实例编号扩大事实空间。

## 边界与验证

方法内扫描、Source/Sink 位置列表与污点标签不属于资源结果。新增规则必须使用完整 SDK 签名和句柄位置，不以方法同名替代平台合同。默认清单的未支持 API 家族不因自定义规则注入而自动更新，需审查实际规则。

定向测试位于 `test/resourceleak/`，工程入口夹具包含真实 SDK API 调用与项目同名 API 反例。功能边界包括不完整异步调度、复杂静态/容器所有权及精度真值不足；真实工程成功执行只证明该次运行完成。
