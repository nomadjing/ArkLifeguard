# 生命周期建模对比：Flat 与 Hierarchical

本文用 `examples/lifecycle-model-showcase` 这一个工程，实际打印两种生命周期模型生成的 DummyMain，
说明它们**怎么建模、差别在哪、各自的特点**。文中的 CFG、计数与统计全部由当前代码实跑得到，不是示意值。

- 模型选择入口：`src/lifecycle/LifecycleModelEntry.ts` 的 `createLifecycleModelCreator()`
- Flat 实现：`src/lifecycle/FlatLifecycleModelCreator.ts`
- Hierarchical 实现：`src/lifecycle/HierarchicalLifecycleModelCreator.ts`
- 设计动机：`research/method/hierarchical-lifecycle.md`

## 1. 为什么要先造 DummyMain

HarmonyOS 应用没有传统意义上的 `main()`。ArkLifeguard 要跑过程间 IFDS，就必须造一个合成入口方法，
把"系统可能以任意顺序调用的生命周期方法和 UI 回调"显式表达成 CFG。这个合成方法叫 `@extendedDummyMain`
（挂在合成 `@extendedDummyClass` / `@extendedDummyFile` 上，并注册进 Scene）。

**生命周期模型就是这份 CFG 的构造策略。** 它决定：哪些回调要建模、回调之间允许以什么顺序衔接、
哪些衔接可以被安全地删掉。这直接决定 IFDS 要走多少条路径，也就同时决定精度和开销。

## 2. 示例工程

```text
EntryAbility (entry)
└── HomePage
    ├── LifecycleCard                      (嵌套自定义组件)
    ├── router.pushUrl -> RouterDetailPage
    ├── router.pushUrl -> NavigationPage
    │                    ├── NavPathStack -> ProfileDestination
    │                    └── NavPathStack -> SettingsDestination
    └── startAbility(Want) -> FeatureAbility
                               └── FeaturePage
                                   └── startAbility(Want) -> EntryAbility
```

收集结果（两种模型完全一致，建模输入的收集与模型无关）：

| 项 | 数量 |
|---|---:|
| Ability | 2（EntryAbility 为 entry） |
| Component | 7 |
| 拥有明确页面归属的 Page | 6 |
| 生命周期方法 | 41 |
| UI 回调 | 9 |
| 导航记录 | 11 |

## 3. 复现命令

```bash
# 看模型本身：CFG + 重建伪代码
npm run inspect:dummymain -- "$(pwd)/examples/lifecycle-model-showcase" --model flat         --format both
npm run inspect:dummymain -- "$(pwd)/examples/lifecycle-model-showcase" --model hierarchical --format both

# 看建模统计（blocks/edges/pageTransitions 等）
npm run cli -- analyze "$(pwd)/examples/lifecycle-model-showcase" \
  --lifecycle-model hierarchical --checks nullness \
  --format json --output out/report.json \
  --lifecycle-report out/lifecycle.json
```

`inspect:dummymain` 输出分三段：

| 段 | 内容 |
|---|---|
| 头部 | `MODEL`、`CFG_BACK_EDGES`（所有 `Bx->By` 且 `y <= x` 的边，是"这里面有没有环"的直接答案） |
| `================ IR ================` | 逐基本块的语句与后继，是判断建模结构最可靠的依据 |
| `================ MODEL PSEUDOCODE ================` | 由 `SourceMethodPrinter` 重建的伪 ArkTS。**它按块顺序平铺输出，不表达 scope 嵌套**，所以看结构要以 IR 为准 |

## 4. Flat 模型（M0，默认）

### 4.1 建模方式

`FlatLifecycleModelCreator` 用最朴素的 FlowDroid 式写法：

1. 先做静态初始化、`new` 出所有 Ability/Page/组件实例；
2. 顺序调用一开始必然发生的阶段（`onCreate`、`onWindowStageCreate`、`aboutToAppear`）；
3. 进入**一个全局 `while(true)` 循环头**，循环体是由 `if (lifecycleBranch === k)` 组成的**串行分支链**，
   每个分支恰好对应一个生命周期方法或一个 UI 回调；
4. 循环之后顺序调用收尾阶段（`aboutToDisappear`、`onDestroy`）。

### 4.2 CFG 形态

63 blocks / 93 edges，2 条回边 `B60->B1, B61->B1`。

```text
B0  -> [B1]
B1  -> [B2, B62]          # 循环头：进入分支链，或直接跳出到返回块
B2  -> [B3, B4]           # if (lifecycleBranch === 0)
B3  -> [B4]               #   entryAbility.onForeground()
B4  -> [B5, B6]           # if (lifecycleBranch === 1)
B5  -> [B6]               #   entryAbility.onNewWant(...)
...                       #   同样形状重复 30 次（每个回调一个菱形）
B60 -> [B61, B1]          # 最后一个分支：不进入则回循环头
B61 -> [B1]               #   settingsDestination.build()
B62 -> []                 # 返回
```

### 4.3 伪代码形状

```ts
// 必然发生的前缀
entryAbility.onCreate(new Want(), new AbilityConstant.LaunchParam());
entryAbility.onWindowStageCreate(new window.WindowStage());
featureAbility.onCreate(new Want(), new AbilityConstant.LaunchParam());
homePage.aboutToAppear();
// ... 所有 Ability 与页面的 aboutToAppear

const lifecycleBranch = nondeterministicInt(); // analysis-only choice
while (true != false) {
  if (lifecycleBranch === 0) { entryAbility.onForeground(); }
  if (lifecycleBranch === 1) { entryAbility.onNewWant(...); }
  if (lifecycleBranch === 2) { entryAbility.onBackground(); }
  if (lifecycleBranch === 3) { featureAbility.onForeground(); }   // ← 另一个 Ability 的事件，同一层
  if (lifecycleBranch === 4) { featureAbility.onNewWant(...); }
  if (lifecycleBranch === 5) { featureAbility.onBackground(); }
  if (lifecycleBranch === 6) { featurePage.build(); }
  if (lifecycleBranch === 10) { homePage.build(); }
  if (lifecycleBranch === 13) { homePage.buildCallback0(); }      // ← UI 回调，同一层
  // ... 共 30 个分支
  if (lifecycleBranch === 29) { settingsDestination.build(); }
}

// 必然发生的收尾
featurePage.aboutToDisappear();
// ... 所有页面的 aboutToDisappear
entryAbility.onDestroy();
featureAbility.onDestroy();
```

### 4.4 特点

- **没有归属概念**：EntryAbility 的事件和 FeatureAbility 的事件是同级分支；`homePage` 的 UI 回调与
  `featurePage.build()` 也在同一层。任意回调后可以接任意回调。
- **过度近似**：`homePage.build()` 之后可以直接接 `featurePage.build()`，而现实中不进入 FeatureAbility
  就不可能跑到 FeaturePage。这类不可达路径会进入 IFDS，既增加开销也可能引入误报。
- **结构性歧义**：`homePage.buildCallback0()` 在分支链里出现了两次（`=== 13` 和 `=== 14`），
  因为有两个 Button 的 `onClick` 解析到同一个方法；在 flat 里它们退化成两条独立分支。
- **边界参数无效**：循环是无限的，`--max-callback-iterations` 对 flat 不起作用（报告里
  `maxCallbackIterations` 为 `null`）。
- **统计上零剪枝**：`candidateCallbackTransitions = 81`、`retainedCallbackTransitions = 81`、
  `prunedCrossPageTransitions = 0`、`conservativeFallbackTransitions = 0` —— 候选转移一条都没删。

## 5. Hierarchical 模型（M1，正式模型）

### 5.1 建模方式

沿 **ownership 链**组织 CFG，而不是把所有回调拉平：

```text
Ability lifecycle boundary
  -> Ability-owned Page scope
       -> Page/ViewTree-owned component callback
       -> same Page callback
       -> statically resolved target Page
```

实现要点（`HierarchicalLifecycleModelCreator.buildDummyMainCfg()`）：

1. **入口块**：静态初始化 + 实例化 + `onCreate`/`onWindowStageCreate` + 所有 `aboutToAppear`。
2. **Ability 级循环头** `abilityHead`：挂 Ability 级事件（各 Ability 的 `onBackground`、`onNewWant`），
   并提供退出到返回块的分支。
3. **Page scope**：对每个 Ability，先由 `onForeground` 建一个 scope 入口，再为它拥有的每个
   **无歧义** Page 建一个 scope。scope 内部有独立的分发器（`head` 与 `eventHead`），
   本页回调回到本页分发器；静态解析出的 router / `NavPathStack` 目标进入目标 Page 的 scope。
4. **fallback 分发器**：owner 未知或有歧义的组件放在这里。每个 scope 的 `eventHead` 都能进入 fallback，
   fallback 的返回块又能回到**任意**一个 scope。
5. **返回块**：`aboutToDisappear` + `onDestroy` + `return`。

"无歧义"的判定在 `collectUnambiguousPageGroups()`：一个 Page 必须**恰好只有一个可达的 Ability owner**
才建精确 scope（`page.abilityNames` 过滤后长度为 1）。

### 5.2 CFG 形态

43 blocks / 81 edges，35 条回边。区块数比 flat 少 1/3，但结构上有明确的分层：

```text
B0  -> [B1]                                # 静态初始化 + 实例化 + onCreate/onWindowStageCreate/aboutToAppear
B1  -> [B2, B23, B24, B25, B26, B27, B28, B42]   # Ability 级循环头
B2  -> [B3, B9, B14, B19, B21]             # entryAbility.onForeground() → 展开它的 5 个 Page scope

# ---- HomePage scope ----
B3  -> [B4, B6, B7, B8]                    # Page scope 分发器
B4  -> [B5]                                #   homePage.onPageShow()
B5  -> [B3, B28, B33, B34, B35, B36, B37]  #   留在本页 / 进 fallback / 触发本页 UI 回调
B6  -> [B3]                                #   homePage.build()
B7  -> [B3]                                #   homePage.onPageHide()
B8  -> [B3]                                #   lifecycleCard.build()   ← 嵌套组件，归属 HomePage

# ---- 另外 4 个 scope：NavigationPage(B9) / RouterDetailPage(B14) / ProfileDestination(B19) / SettingsDestination(B21) ----
B9  -> [B10, B12, B13]  ...  B11 -> [B9, B28, B38, B39]

# ---- Ability 级事件 ----
B23 -> [B1]                                # entryAbility.onBackground()
B24 -> [B1]                                # entryAbility.onNewWant(...)
B25 -> [B1]                                # featureAbility.onForeground()
B26 -> [B1]                                # featureAbility.onBackground()
B27 -> [B1]                                # featureAbility.onNewWant(...)

# ---- fallback 分发器：FeaturePage ----
B28 -> [B30, B31, B32, B41]                # featurePage.build() / onPageShow() / onPageHide() / %AM0$build()
B29 -> [B3, B9, B14, B19, B21, B28]        # fallback 返回：可回到任一 Page scope
B30 -> [B28]  B31 -> [B28]  B32 -> [B28]     # featurePage 的 build / onPageShow / onPageHide
B41 -> [B29]                                # featurePage.%AM0$build()，触发 UI 回调后回到 fallback 返回块

B42 -> []                                  # aboutToDisappear + onDestroy + return
```

### 5.3 特点

- **Page 内闭环**：`homePage.build()`、`onPageHide()`、嵌套的 `lifecycleCard.build()` 以及
  HomePage 自己的 UI 回调，都回到 HomePage 的分发器 `B3`，不直接跳到别的 Page。
  这消除了 flat 里"HomePage 之后直接跑 FeaturePage"这类路径。
- **归属可解释**：`lifecycleCard.build()` 在 `B8` 而不是全局层，因为 ViewTree 能证明它嵌套在 HomePage 里。
- **保守 fallback**：本工程的 `FeaturePage` 归属**不唯一** —— 探针结果显示
  `id=pages/FeaturePage root=FeaturePage abilityNames=[EntryAbility, FeatureAbility]`，
  有两个可达 Ability owner（它同时被 `main_pages.json` 声明，并通过 HomePage 的 `startAbility` 进入）。
  按"唯一 owner"规则它不建精确 scope，而是整块进入 fallback 分发器 `B28`，
  并且 fallback 与所有精确 scope 双向连通。**解析不确定时保留路径，绝不因为解析失败而剪枝。**
- **统计上确有剪枝**：

  | 指标 | flat | hierarchical |
  |---|---:|---:|
  | `candidateCallbackTransitions` | 81 | 81 |
  | `retainedCallbackTransitions` | 81 | **47** |
  | `prunedCrossPageTransitions` | 0 | **34** |
  | `conservativeFallbackTransitions` | 0 | 17 |
  | `boundCallbacks` | 9 | 8 |
  | `fallbackCallbacks` | 0 | 1 |

  即：在相同的 81 个候选回调衔接中删掉了 34 个跨 Page 非法衔接，保留 47 个，
  另外 17 个是 fallback 引入的保守转移（对应 FeaturePage 这一个未绑定回调）。
- **保留前台重入**：`B23->B1`、`B25->B1` 让 `onBackground`/`onForeground` 循环回 Ability 头，
  所以"后台回到前台"仍可重新进入 Page scope；`onPageShow` 也可以在同一 Page scope 内重复触发。
  平台语义没有被剪掉。
- **边界参数同样无效**：`maxCallbackIterations` 对 hierarchical 也是 `null`。

## 6. 两种模型对照

| 维度 | Flat (M0) | Hierarchical (M1) |
|---|---|---|
| CFG 结构 | 单一全局循环 + 30 个串行 `if` 分支 | Ability 循环头 + 每 Page 一个 scope + fallback |
| blocks / edges | 63 / 93 | 43 / 81 |
| statements | 120 | 99 |
| 回边 | 2 | 35 |
| 回调衔接约束 | 无，任意回调接任意回调 | 受 ownership 限制，跨 Page 非法衔接被删 |
| 跨 Page 剪枝 | 0 | 34（81 → 47） |
| 归属不明时 | 无所谓，本来就是平的 | 进 fallback，且与所有 scope 双向连通 |
| 误报方向 | 不可达路径可能带来 FP | 剪枝不足可能带来 FN；不会因解析失败剪枝 |
| `--max-callback-iterations` | 不适用 | 不适用 |
| 适用场景 | 基线对照、结构未知时的兜底 | 默认精度实验、RQ1.5 消融基线之外的正式模型 |

需要强调的是：**hierarchical 的收益是"结构精度"，不是"更快"**。本工程里它的 blocks/edges 更少，
但 `research/method/hierarchical-lifecycle.md` 明确记录性能收益尚未成立（scope 之间的 35 条回边
增加了求解器需要维护的调度点）。选型时不要默认 hierarchical 一定更快。

## 7. 另外两个模型

另外两个 mode 在本工程上的输出也一并列出，便于对照（细节本文不展开）：

| mode | CFG 形态 | blocks / edges | 回边 |
|---|---|---:|---|
| `opt-flat` | 一个 hub 分发器 `B1` 直接扇出 31 个回调块，每块回到 `B1`（compact dispatcher） | 33 / 62 | 30 |
| `bounded-unroll` | 无回边的 DAG；每轮是一段顺序执行的生命周期扫描 | 6 / 7（`--callback-iterations 1`）<br>10 / 13（`--callback-iterations 2`） | 0 |

- `opt-flat`：RQ1.5 的**公平基线**。事件集与 flat 相同、同样不做 ownership 剪枝，只是把"串行分支链"
  换成"hub-and-spoke"，用于隔离"CFG 表达方式"和"剪枝"两个变量。
- `bounded-unroll`：唯一消费 `--max-callback-iterations` 的模型。`n` 轮就是同一段扫描重复 `n` 次，
  无回边因此天然有限；块数随 `n` 线性增长（6 → 10），路径数则组合增长。

## 8. 怎么用这些信息

1. 改生命周期建模前，先跑 `inspect:dummymain --format ir` 看 `CFG_BACK_EDGES` 和基本块结构；
   `--format source` 只用来快速扫一眼调用了哪些方法。
2. 想知道某次改动剪掉了多少衔接，用 `--lifecycle-report` 看 `lifecycleStatistics.pageTransitions`，
   不要靠数 blocks。
3. 本工程是**最小展示工程**，blocks/edges 的数字只对应当前代码与该工程；
   换工程、换代码版本都会变，把数字当作对照示例而不是常量。
