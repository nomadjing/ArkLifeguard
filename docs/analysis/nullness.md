# 空指针分析

## 设计前提与范围

当前实现以同步空值传播核心为主，并额外支持有直接源码证据的 Promise completion value。实验评价限定为已成功构建的 ArkTS 应用（successfully-built ArkTS apps），成功构建需要对应应用及 SDK、工具链版本的实际构建证据；分析器成功完成不等于应用构建成功。输入 ArkTS（`.ets`）应已通过编译检查：显式可空类型的解引用需要先消除空值，或使用非空断言 `!`、可选链 `?.`。分析保留这个语言前提，重点检查非空断言、明确的可空返回证据和已建模的非空参数义务；不把所有类型上合法的普通 ArkTS 属性访问一律视为运行时缺陷。JavaScript/TypeScript 访问不套用这一 ArkTS 前提。当前源码无法准确匹配时保留 IR 证据，但若 IR 未完整表达可选链控制流，这一回退可能产生误报，不能直接据此认定运行时缺陷。

报告仍输出候选来源、访问路径、使用位置和置信度。本次收缩不在用户报告中增加“暂不支持”字段或提示；能力边界仅在本文和代码注释中维护。运行成功表示本轮求解完成，零候选不能证明整个应用没有缺陷。

```bash
npm run cli -- analyze "/path/to/app" --sdk "/path/to/ets" \
  --checks nullness --format json --output out/nullness.json
```

## 为什么有空安全检查，仍可能发生空解引用

ArkTS 的空安全检查依赖编译器掌握的静态类型。对于已知可空的值，编译器要求开发者先检查空值、使用可选链，或通过非空断言明确承担风险。通过编译并不意味着所有运行时值都已得到验证：断言可能不成立，外部数据可能不符合预期，API 声明也需要与实际行为一致。

几种常见写法的作用不同：

| 写法 | 实际作用 |
| --- | --- |
| `if (x !== null && x !== undefined)` | 检查运行时值，只在非空分支继续访问。 |
| `x?.field` | 运行时 guard：接收者为 null 或 undefined 时跳过受保护的访问，表达式返回 undefined；不证明接收者此后全局非空。 |
| `x!.field` | 断言 x 非空；不会将实际的空值变成对象，断言错误仍可能导致运行时异常。 |
| `x as SomeType` | 提供类型断言，不能替代对外部数据内容和结构的校验。 |

### 非空断言需要事实支撑

```typescript
const value: string | undefined = getValue();
value!.trim();
```

这里的 `!` 表达的是开发者的承诺。如果 getValue 实际返回 undefined，访问仍会失败。分析器需要检查这种承诺是否与赋值、调用返回值及路径条件一致，而不是将 `!` 本身当作非空证明。

### 可选链的问题与 CFG 修复

Aigis 的旧报告 `out/nullness/1029/report.json` 第 5 条将 `importers/index.ets:26` 返回的 undefined 报在 `EntryAbility.ets:843`：

```typescript
const importer = dispatchImporter(data.type);
const key = importer?.schema.export_password_required
    ? data.password : masterKey.keyAlias;
const result = await importer?.save(file.fd, key ?? '', content);
```

当 importer 为 undefined 时，连续可选链会跳过 schema 及 export_password_required 的访问，条件值为 undefined，选择三元表达式的备用分支；下一行的可选调用也不执行。该 undefined 来源不能导致所报位置的解引用异常，因此此条为误报。这里并不要求忽略所有包含 `?.` 的语句：保护范围之外的访问，以及实际存在的 importer 对象上的其他可空字段，仍需单独检查。

修复前的实现并非完全忽略可选链，但处理依赖源码恢复，存在以下不足：

- `NullnessSourceSemantics.getAccesses()` / `getOperandAccesses()` 根据语句、操作数的源码位置匹配 AST；访问节点以 `questionDotToken` 标记 optional。单个节点上的标记不能独立表达整条连续可选链的短路范围，例如 `importer?.schema.export_password_required` 中后一次属性访问没有自己的 `?.`。
- `NullnessProblem.isReportableSourceUse()` 在诊断阶段根据匹配结果排除 optional 访问；没有匹配项时保留 IR 证据。临时变量、同一源码表达式降低出的多个语句，以及位置范围不精确，都可能使安全访问重新进入报告。这属于报告过滤，不能替代执行路径上的 guard。
- `propagateAssignment()` 配合 `isOptionalChainStmt()`，对识别出的部分实例字段读取将接收者空值映射为结果 undefined。该规则仍依赖源码匹配，且本身不建立“空值分支跳过整条链”的控制流，不能独立保证连续属性访问、元素访问和可选调用语义一致。

以上是修复前可确认的设计问题。旧报告已确认违反可选链语义，但没有该次历史运行的 IR/CFG 和 fact 轨迹，不将其具体失效环节当作已复现事实。已检查的 ArkAnalyzer 1.0.94、1.0.95 和 2.0.0-beta1 都会将可选属性访问降低为不带判空分支的普通读取。

修复在 IR/CFG 层表达可选链 guard，使 IFDS 沿实际分支传播，而不是依赖源码位置映射做诊断后过滤。以 `r = x?.a.b` 为例，目标控制流为：

```text
计算 x（一次）
  ├─ x 为 null/undefined → r = undefined ─────────┐
  └─ x 非空 → 读取 x.a → 读取其 b → r = 结果 ────┤
                                                 ↓
                                               合流
```

空值分支不执行受保护链上的属性访问或调用；非空分支只排除被检查接收者的 null/undefined fact，不据此证明 a 等后续值非空。合流后保留结果可能为 undefined，也保留原接收者在空值分支上的事实。`x?.a.b`、`(x?.a).b`、`x?.a?.b` 的保护范围不同，必须在降低时区分；可选调用和元素访问还应保证短路时跳过受保护的实参或索引求值。

非空断言 `!` 则是 compiler assertion, no runtime guard。对 Nullness 分析，它只改变编译器的类型判断，不应 kill 或收窄既有 null/undefined fact。Aigis 的 `code.match(/.{1,2}/g)!.join(' ')` 等报告已有空串输入路径的源码证据，属于 TP；不能为了消除可选链误报而删除这些事实。保留断言后的运行时风险，正是分析器相对于编译器空安全检查的价值。

验证要求：

- Aigis 第 5 条因正确的 guard 语义消失，不使用应用名、行号或整条语句免报规则。
- 连续链、括号打断链、多级可选链、元素访问和可选调用分别验证保护范围；结果 undefined 在保护范围外被直接解引用时仍应报告。
- 同一接收者上受保护与未受保护的访问分别处理；可选访问不永久清除接收者的空值事实。
- `match(...)!` 后的 null fact 保留，已确认的 TP 不因可选链修正而被抑制。

[OptionalChainLowering](../../src/adapter/OptionalChainLowering.ts) 在适配层补充 AST 到 IR 的降低：通过 ArkAnalyzer 的条件表达式标记构建真实 CFG 分支；保留连续链范围，括号结束链，可选元素访问与调用的索引及实参留在非空分支内。接收者在求值点保存，可选 delete 的短路结果为 true。已有源码恢复规则仍保留作兼容，但新增安全用例关闭源码访问匹配后也应通过。

降低还记录“结果非 undefined 意味着局部接收者通过了 guard”的关系。Nullness 在具体字面值比较的对应分支使用该关系，并要求接收者局部变量未被重新赋值；不据此恢复可变字段或任意跨调用不变量。非空断言沿原有值身份传播，不清除 fact。String.match 使用已检查的完整内建签名保留可空返回契约，避免当前签名模型的覆盖缺口使原有 TP 消失。

已对 Aigis 原始导出回调和 splitDigits 做局部求解：关闭源码访问匹配后，dispatchImporter 返回 undefined 的事实仍到达调用者，导出回调无诊断，splitDigits 四处 match 断言诊断保留。这是局部验证，不是整批重跑或成功构建评价。兼容补丁依赖 ArkAnalyzer 的值转换入口及条件 CFG 标记；升级依赖时需要重新核对。

### JSON 的类型断言不等于数据验证

```typescript
const obj = JSON.parse(text) as Record<string, Object>;
```

当 text 为字符串 `"null"` 时，解析结果就是 null。类型断言不会自动验证 JSON 根值是否为对象，也不会保证对象的每个字段都存在。使用结果前，应由实际的输入校验或分支检查建立所需条件。

建模时还需要区分 API 的具体语义：ECMAScript JSON.parse 在未传 reviver，或显式传入 null、undefined 时，正常返回可能为 null，但不会为 undefined；可调用的 reviver 则可能产生 undefined。无效 JSON 会抛异常，不能把异常退出当作一个空值返回。OpenHarmony JSON API 使用独立的完整签名和契约，不直接套用全局 JSON 的规则。

同样，不能将 `JSON.parse(JSON.stringify(x))` 一概视为非空：如果 x 的 toJSON 方法返回 null，最终结果仍然是 null。只有证明输入对象的构造方式及序列化行为，才能进一步收紧返回值范围。

### API 与框架约定也有边界

编译器依赖 SDK 的类型声明。若实际返回值与声明存在差异，静态类型本身不能保证调用安全。框架管理的字段还可能依赖注入、初始化或回调顺序；字段声明为非空，并不能单独证明每次访问前都已完成初始化。

这类候选需要准确的 API 契约或执行顺序证据。不能仅凭“涉及回调”就认定存在缺陷，也不能仅凭“由框架管理”就认定安全；当前未支持的部分按本文的能力边界处理。

### 对检测器的要求

检测应从具体证据出发：显式空值赋值、明确的可空 API 返回、未经验证的外部数据，以及可能不成立的断言。不能把所有非空类型重新假设成可空，也不能只凭方法名或宽泛类型推测 SDK 行为。

发现一个可空来源后，还必须核对它能否到达报告位置。例如，调用方可能已验证 JSON，当前分支可能已排除空值，或者此前的必经操作会在空值情况下抛异常，使程序无法继续到报告位置。此时，“API 可能返回 null”仍然成立，但不足以证明该位置存在缺陷。函数独立接受非法输入时的风险，也应与应用实际调用路径上的可达风险分开判断；被 catch 捕获的异常不能直接描述为应用崩溃。

参考：[华为 ArkTS 静态类型与空安全说明](https://developer.huawei.com/consumer/en/doc/harmonyos-guides-V14/arkts-migration-background-V14)、[ECMAScript JSON.parse 规范](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse)。以上讨论针对本项目分析的 ArkTS 输入与已核对的 API，不将其他语言版本或不同 SDK 的行为自动视为相同。

## 字符串与正则相关 warning

本项目追踪 null/undefined 的来源、传播及运行时防护，不进行字符串内容、长度和正则匹配约束的值分析。对于 `RegExp.exec`、`String.match` 等可空返回，能够检查匹配结果是否未经判空即被解引用，但不能普遍证明调用实参一定匹配或一定不匹配。调用处的前缀检查、输入构造或格式校验是否足以保证匹配成功，需要进一步核查；不能把非空字符串检查等同于匹配成功。

这类报告具有价值：它指出方法内部缺少防护的位置，以及“匹配失败即发生空解引用”的触发条件，便于检查外部输入和调用契约。报告应使用 **warning（条件性空解引用风险）**，提示进一步验证调用路径，并建议在解引用前增加运行时判空，匹配失败时按业务要求返回备用值、跳过处理或显式报告解析失败。`!` 不能代替这种防护；防护必须先于属性访问、索引访问及日志参数求值。

建议提示：

> warning：正则匹配结果可能为 null，此处未经判空即被解引用。当前分析不追踪字符串内容，调用输入是否保证匹配成功仍需核查。建议在使用匹配结果前增加判空及匹配失败处理。

方法内存在条件性风险，不等于应用实际调用路径已确认触发 NPE。有具体输入路径证据时人工标为 TP；已证明所有相关调用路径排除触发条件时标为 FP；证据不足时保留 UNKNOWN。不能因缺少字符串分析将候选统一计作 TP，也不能因此丢弃有检查价值的 warning。此处明确报告表达与人工复核约定，尚未修改诊断输出格式或级别。

## 保留的同步机制

- 显式 null、undefined、未初始化值；普通赋值、字段和数组元素访问。
- 可解析的同步调用、参数和返回值、接收者字段写入、显式异常路径。项目返回值沿实际函数退出边传播，不再根据宽泛返回类型或重载声明猜测非空。
- 直接判空、短路、三元表达式、typeof 与 instanceof 约束，以及相关写入后的失效处理。
- 实际 getter 的有限后备字段摘要：核对源码 AST 为访问器，函数体无调用及字段写入，正常值返回同一实际字段。支持以该读取结果判空，并在后备字段变化后保留新的空值风险；有副作用、继承可能改变分派或返回不同字段时不采用此摘要。
- 有界的局部确定赋值证明：追踪简单布尔标记与分支赋值，识别“未赋值路径必然提前返回”。只将 new、对象/数组和非空字面值认作已建立的新值；复制或未知调用不能提供此证明。只消除来自匹配的无初始化声明的旧 undefined 证据，不消除后续显式 null/undefined 赋值。状态上限为 32；不处理已执行循环、异常结构、闭包或复杂赋值，证明失败时保留候选。for-of 的迭代表达式可在进入循环前检查。
- 直接同步调用的闭包捕获绑定保留。项目函数体能证明调用了函数参数时保留相应调用目标及转发关系；无法取得函数体时不猜测同步执行。

源码 AST、语句信息、CFG 索引及 getter 证明按分析实例缓存。存在精确操作数位置时，按该位置匹配单次源码访问，避免同一条件中的可选链与非空断言互相污染；匹配失败仍保留原有回退证据。基础传播复用共享 IFDS 求解器，不改变资源和监听器分析的调用解析模式。

## 签名模型与扩展

默认返回值模型只启用 [SdkSignatureSummary](../../src/analysis/nullness/library/SdkSignatureSummary.ts)。模型资产为 [sdk-nullness-summary.json](../../src/analysis/nullness/library/sdk-nullness-summary.json)，schemaVersion 为 2：

- methods 使用完整 ArkIR 方法签名，包括声明文件、声明类、方法及参数。
- fields 使用完整字段签名。
- 每条规则记录 returnNullness 和 evidence；不按 get、then、on 等名称，不按未知类名或宽泛接收者类型继承规则。
- 当前保留内建 String.match、RegExp.exec、Map.get/has/set、Array.find/isArray、JSON.parse/stringify、String.trim/split、Array.slice 的明确签名，以及内建 Error.stack 字段；另以完整签名单独支持加载的 OpenHarmony JSON.parse。Map.get 和 Array.find 保守包含“缺失”及“取到已存储的空值”，不因 has/set 认定返回值非空。Array.find 的模型仅描述返回值可能性，不执行其谓词回调。
- 未列入模型且无法通过受支持的同步函数体分析的调用，不生成空值事实；这不证明返回值非空，相关缺陷可能无法检出。
- JSON.parse 保留 null 可能性；全局 ECMAScript JSON.parse 在省略 reviver 或显式传入 null、undefined 时排除 undefined，其他实参保守保留 reviver 可能产生 undefined 的情况。JSON.stringify 不因声明返回 string 就排除实际返回 undefined 的情况。回调本身的执行效果不在模型内。
- 构建仍通过 scripts/copy-nullness-assets.mjs 复制该资产。

新增规则应先检查加载 SDK 中的完整签名，验证正常、可空、同名业务方法和重载不匹配等反例，再加入资产。SDK 版本导致签名变化时不自动按名称回退。未列入的框架及 SDK 接口不属于当前已验证模型。

## 框架边界与同步回调契约

不按应用名、页面类名或源码行号过滤。当前暂时排除的是组件装饰字段在 %instInit 中的默认 null/undefined 所产生的诊断：这些候选依赖参数注入、组件复用或事件顺序，过滤表示暂不处理，不代表已证明安全。组件方法内的局部空值、显式空值写入，以及普通同步方法问题仍检查；当前不宣称已穷尽识别所有跨事件时序依赖。

[ArkUiSynchronousCallbacks](../../src/analysis/callgraph/ArkUiSynchronousCallbacks.ts) 向通用调用解析器提供 ArkUI 同步函数参数位置契约。ArkIR 的 View.create 构建内容槽位同时核对完整降低签名、实际 @Component 类型和函数参数类型；没有具体应用类名匹配。[NullnessCallGraph](../../src/analysis/nullness/NullnessCallGraph.ts) 另外以精确内建 `Array.forEach` 签名保留标准同步数组回调。后续框架契约通过该边界扩展，通用 IFDS 调用解析器不内置应用或框架专用判断。

可解析的非 async 函数参数体还作为独立的局部检查入口（跳过主入口已到达的方法）。每个入口从 ZERO 开始，不从注册现场注入捕获状态，不将执行结果回写注册调用，不建立 Promise payload 或事件顺序。这样能检查函数体内的 JSON.parse、显式空值等普通问题；候选不证明该回调一定触发。模块初始化和这些局部入口仍各自独立求解。

## Promise completion value 的受限传播

当前只对以下有直接源码证据的 Promise 完成值建模：

- 项目 `async` 方法的所有直接返回语句中出现 `return null` 或 `return undefined` 时，对直接调用结果建立 fulfillment payload fact。调用结果本身仍是 Promise 句柄，不会因为这个 payload 被标记为空。
- 精确内建 `Promise.catch` 的 fulfillment callback 直接返回 `null`/`undefined` 时，为 `.catch` 产生的新 Promise 建立 fulfillment payload fact。只认可文件名以 `@internal/Promise.d.ts` 结尾或 `projectName=built-in` 的 `Promise` 实例签名，不按 `catch` 名称匹配任意方法。
- `await` 遇到上述 synthetic payload fact 时解包到左侧变量；如果被 await 的操作数本身已有 `null`/`undefined` fact，也保留该事实，因为 `await null` 和 `await undefined` 的结果仍是对应空值。
- 精确内建 `Promise.then` 注册的 callback 可以从 Promise payload 得到参数 fact。callback 仍作为独立 activation root 求解，只注入 payload 参数，不注入注册现场的捕获状态，不把 callback 当成立即执行，也不把 callback 对字段等状态的写入回写调用者。
- 项目内每个 async 方法体作为独立 activation root 求解，起始事实为 ZERO，不通过普通同步调用边进入。async 方法中的局部赋值和 `await` 之后的 continuation 可按该方法自身 CFG 分析。动态路由或框架可能导致方法没有从 DummyMain 暴露的到达路径，因此这种 root 是方法内缺陷候选分析，不证明方法实际可达。

这套机制把 Promise 对象与 fulfillment value 分开表示：`const p = load(); p` 的非空性和 `const value = await p; value` 的空值性不是同一个事实。它也不根据 `Promise<T>` 类型参数猜测运行时 payload；例如声明为 `Promise<T>` 的 SDK 方法仍可能缺少精确的 fulfillment 契约。

当前机制直接覆盖 OxHornCampus `P052` 对应的结构：

```typescript
getWindow().catch(() => null).then((data) => {
  data!.getWindowProperties();
});
```

`.catch(() => null)` 产生 completion payload `null`，`.then` 的参数在独立回调 root 中得到该 fact，因此可检出回调体内部的非空断言风险。这个结论针对 completion-value 传播；它不证明 `.then` 与页面生命周期、其他 Promise 或其他事件的执行先后。

## 暂不支持的功能

| 部分                                 | 当前边界及后续要求                                                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Promise、await、异步函数             | 已支持上述直接字面量 completion value、nullable await operand、精确内建 `Promise.then/.catch` 的受限 payload 传播，以及项目 async 方法体的独立 candidate root。独立 root 不证明动态页面/框架调用路径可达。尚不支持 returned local/field、嵌套 Promise/async adoption、隐式 `return undefined`、`.then` 返回链、rejection reason、`.catch` 的 rejection 参数、`.finally`、`Promise.all/race` 和自定义 thenable。SDK Promise payload 必须另有精确契约。 |
| 注册回调、事件监听、计时器、SDK 回调 | 不将未知注册 API 的函数参数作为同步被调函数，也不建立跨事件或跨线程状态传播；保留上述局部函数体检查。后续应在 ICFG 明确注册与触发关系。生命周期已有入口不证明真实异步顺序。                                                                                               |
| ArkUI 容器、builder、组件注入        | 删除按 ForEach/LazyForEach 名称匹配的参数规则和自动补充框架 sink 入口；默认装饰字段相关候选按上述范围暂时过滤，不将 @Require 当作值非空的证明。analyzeFrameworkSinkMethods 暂保留为弃用的兼容配置，不再选取这些额外入口。未来以经过验证的框架签名和参数注入时序模型扩展。 |
| 容器内容不变量                       | 删除“先 set/has 即非空”、类源码正则推断 Map 已填满，以及通用容器方法名匹配。未来需区分键存在、值非空和别名修改。                                                                                                                                                          |
| 复杂 getter／普通重复调用            | 不根据 get/is 等名称认定稳定；未覆盖的 getter 沿普通函数体分析，可能保留额外候选。普通方法的纯度及稳定返回证明留待后续。                                                                                                                                                  |
| 项目返回摘要                         | 删除跨分支拼接定义、宽泛返回类型和非空重载所产生的返回摘要，保留同步函数体传播。当前不进行完整的调用实参常量特化，可能保留不可行分支。                                                                                                                                    |
| 模块状态及初始化顺序                 | 仍以独立补充 root 分析含具体空值来源的模块初始化器，不重建跨 root 的全局状态与实际模块加载顺序。独立 root 合并不能证明全程序初始化安全。                                                                                                                                  |
| 类／组件初始化协议                   | 删除“所有具体子类构造器均写过字段”式免报规则。保留实际被调用构造器的赋值传播；框架注入和全局类不变量需要独立模型。                                                                                                                                                        |
| Promise 调度与跨 await 状态           | 不证明 async 调用和 continuation 的实际执行时刻，不注入调用者参数或捕获状态到独立 async/callback root，也不把回调写入同步回写调用者。跨 `await` 的字段、静态状态、闭包捕获和并发写入保持未建模；相关候选需要平台事件顺序或额外同步证据。 |
| Promise 完成值的非字面来源             | 不把 nullable local、字段、普通方法返回值或泛型参数自动当作 fulfillment payload。只有直接字面量返回、精确内建 `.catch` 字面量返回和已验证的 payload fact 可以继续传播；缺证据时保留为未覆盖，不声称非空。 |

## 求解限制与验证

工程默认访问路径长度 5、传播深度 40；直接构造 NullnessProblem 的默认深度为 100。递归及大工程仍使用有界访问路径抽象。达到传播深度会截断事实，这些边界不构成全程序 soundness 保证；目前不额外写入用户报告。

本轮定向测试包含签名匹配、同步空值返回、getter 判空及写入失效、布尔标记确定赋值、未知异步注册不展开、同步调用契约和局部回调体入口、容器可空返回和 ArkTS 源码策略。旧异步、容器及框架测试按收缩后的边界调整，不再把不执行的部分计作“已证明安全”。

实验准确率、误报率等评价仅针对有成功构建证据的 ArkTS 应用；应记录应用版本、SDK/工具链、构建命令与结果，并固定分析配置。构建失败或未验证构建的应用不纳入该评价集合，可另列探索结果；不得把分析状态 success 当作构建证据。

已有真实应用报告属于旧实现快照，且其分析成功状态本身不能证明成功构建，不能作为收缩后实现的覆盖率或准确率结论。需要比较时应保留输入、配置及原始结果，另行运行。

相关实现：[NullnessProblem](../../src/analysis/nullness/NullnessProblem.ts)、[NullnessSourceSemantics](../../src/analysis/nullness/NullnessSourceSemantics.ts)、[GetterReadSummary](../../src/analysis/nullness/GetterReadSummary.ts)、[DefiniteAssignment](../../src/analysis/nullness/DefiniteAssignment.ts)、[NullnessAnalysisRunner](../../src/analysis/nullness/NullnessAnalysisRunner.ts)。
