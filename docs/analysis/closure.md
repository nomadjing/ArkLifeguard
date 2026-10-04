# 注册与闭包保留分析

## 功能与使用

注册检查回答“生命周期结束时是否仍存在未取消注册”；闭包保留检查进一步要求“长期根经该注册和回调，强引用生命周期已结束的对象”。

```bash
npm run cli -- analyze "/path/to/app" --sdk "/path/to/ets" \
  --checks closure --format json --output out/closure.json
```

[ClosureRunner](../../src/analysis/closure/ClosureRunner.ts) 使用共同生命周期入口，但拥有独立结果和堆状态。未取消注册没有足够捕获证据时，只进入 `registrationLeaks`；有证据时进入 `closureRetentionLeaks`，同一注册不重复计入两类。

## 默认摘要与规则合同

[RegistrationRules](../../src/analysis/closure/RegistrationRules.ts) 绑定 SDK 完整签名，默认九个摘要家族：

| 家族 | 注册 / 取消 | registrar |
| --- | --- | --- |
| interval | setInterval / clearInterval | 系统 |
| timeout | setTimeout / clearTimeout | 系统；可能自行触发 |
| emitter | on / off | 系统 |
| emitter once | once / off | 系统；可能自行触发 |
| EventHub | on / off | 接收者 |
| Window | on / off | 接收者 |
| WindowStage | on / off | 接收者 |
| Display | on / off | 系统 |
| DataObject | on / off | 接收者 |

规则定义 callback/event 参数索引、释放参数索引、是否允许省略回调取消全部监听、是否自行到期。receiver 类型不自动被当成长期根，只有它从已建模根可达才构成保留证明。

SDK 缺失的家族进入 `unresolvedRuleIds`。Sensor、定位、Worker onmessage、AbilityContext、InputMethod、DisplaySync、CommonEvent 尚无专用摘要，当前通过 `unsupportedLegacyRuleIds` 显示，不产生冒名候选。

自定义 `closureRules` 替代默认摘要，空集或无效配置使闭包模块失败。默认摘要完全未解析时仍可完成运行，但结果的未解析清单必须连同零候选解释；不存在通用任意 on/off 检测。

## 注册身份与取消

[RegistrationState](../../src/analysis/closure/RegistrationState.ts) 在堆状态上附加注册点、规则、registrar、event、callback、timer token、owner 和 active 状态。[RegistrationModel](../../src/analysis/closure/RegistrationModel.ts) 按 API 家族和具体身份匹配取消：

- event 注册核对 registrar、event、callback；只在规则允许时省略 callback 取消该事件全部注册。
- timer 取消核对保存/别名传播后的 token，错误 ID 不取消原 timer。
- 相同函数体不代表同一函数身份；不同 bind 调用产生不同回调。
- 可能重复注册的同一抽象身份不假定一次取消就全部解除。

emitter 的 `InnerEvent.eventId` 投影参与事件匹配。遇到未知或多值身份保守处理，不因两个不确定集合看起来相等就全部取消。

## 捕获图与终点

共享 [HeapFlow](../../src/analysis/shared/HeapFlow.ts) 传播局部、参数、接收者、返回、字段和容器引用。箭头函数的词法 this 用 AST 判断；普通函数的动态 this 不自动形成捕获。

捕获局部引用活绑定单元，后续赋 null 会切断当前链。已清空的函数绑定不会依据类型重新创建一个虚构回调；命名方法引用保持声明身份，bind 保持分配身份。

在配置的生命周期正常出口，Runner 只处理对应 owner 的注册，并搜索包含**该注册槽位和回调**的强路径。独立静态根不能在缺少 callback 身份时替代该证明。附属对象的 owner 归属只是分配上下文近似，其候选为低置信度。

直接使用 Runner 必须给出 `HeapFlowOptions.lifetimes`；工程编排提供已收集 Ability 的 `onDestroy` 与 Component 的 `aboutToDisappear`。没有观测到终点时，不把任意方法返回作为注册泄漏边界。

## 输出与限制

[ClosureResult](../../src/analysis/closure/ClosureResult.ts) 包含注册身份、注册位置、边界、原因和置信度；闭包保留增加 root、captured object、retention path、lifecycle end。

部分路径取消报告 `partially-unregistered`；未知、自到期、未建模异步/分支相关结果降级。timeout/once 可能已触发，但没有调度证据时不声称一定残留。

默认 20000 状态、4 层调用。预算耗尽返回失败并降低部分结果置信度。已知条件分支未求解可行性；异常边使用语句前状态，不能假定清理已经完成。

注册不会同步执行回调，Promise 中安排的 off 不等于已经执行。模型不是完整 JS 闭包环境或事件循环模拟。局部 registrar 自循环即使有未取消注册，也不构成长根保留证明。相关测试见 `test/closure/`。
