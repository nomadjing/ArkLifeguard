# HarmonyOS Lifecycle Model Showcase

这是一个用于展示和检查 ArkLifeguard 生命周期建模能力的最小 Stage 模型工程。一个工程内同时包含：

- `EntryAbility` 与 `FeatureAbility` 两个 UIAbility；
- Ability 的 `onCreate`、`onWindowStageCreate`、`onNewWant`、`onForeground`、`onBackground`、`onDestroy`；
- 使用 Want `parameters` 的双向 Ability 启动与消息传递；
- 使用 `router.pushUrl()` / `router.back()` 的页面路由；
- 使用 `Navigation` / `NavPathStack` / `NavDestination` 的组件导航；
- Page 与嵌套自定义 Component 的核心生命周期和 UI callback。

## 结构

```text
EntryAbility
└── HomePage
    ├── LifecycleCard
    ├── router.pushUrl -> RouterDetailPage
    ├── router.pushUrl -> NavigationPage
    │                    ├── NavPathStack -> ProfileDestination
    │                    └── NavPathStack -> SettingsDestination
    └── startAbility(Want) -> FeatureAbility
                               └── FeaturePage
                                   └── startAbility(Want) -> EntryAbility
```

`EntryAbility` 和 `FeatureAbility` 都从 `onCreate` / `onNewWant` 读取 Want 参数并写入 `AppStorage`，对应页面通过 `@StorageProp` 展示消息。这里使用显式 `startAbility`，既能展示 Ability 间通信，也能被当前 `NavigationAnalyzer` 识别。

## 查看 ArkLifeguard 模型

在 ArkLifeguard 根目录运行：

```bash
npm run inspect:dummymain -- \
  "$(pwd)/examples/lifecycle-model-showcase" \
  --model hierarchical \
  --format both
```

也可以将 `--model hierarchical` 换成 `flat` 或 `opt-flat`，比较不同 DummyMain 的 scope 与 CFG。

## 设计边界

- 只保留能够说明建模关系的核心回调，不追求覆盖全部 HarmonyOS API。
- `router` 用于展示旧式页面路由；新应用优先使用 `Navigation`。
- Want 参数演示的是同一应用内 Ability 启动时的数据传递，不是跨进程 RPC。
- 本项目用于静态分析与模型展示；仓库环境不包含 DevEco Studio，因此没有在真机或模拟器上构建运行。

## 官方文档依据

- [UIAbility API 与生命周期](https://developer.huawei.com/consumer/cn/doc/doccenter-references/api/js-apis-app-ability-uiability)
- [Want：应用组件间信息传递载体](https://developer.huawei.com/consumer/cn/doc/doccenter-references/api/js-apis-inner-ability-want)
- [Navigation 页面路由](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/arkts-navigation-jump)
- [自定义组件生命周期](https://developer.huawei.com/consumer/cn/doc/doccenter-references/api/ts-custom-component-lifecycle)
