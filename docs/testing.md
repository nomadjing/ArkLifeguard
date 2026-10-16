# 测试与调试

## 最小验证

先检查直接修改范围，再运行相关单元测试；不默认运行完整套件、构建、E2E 或耗时基准。预计超过两分钟先确认范围。工作区提供 `AGENTS.md` 时，同时遵守其中的测试策略。

| 命令 | 范围 |
| --- | --- |
| `npm run typecheck` | 生产源码 |
| `npm run typecheck:test` | 生产与测试源码 |
| `npm run typecheck:scripts` | 生产与脚本源码 |
| `npm run test:closure` / `test:memory` | 注册/捕获、内存保留 |
| `npm run test:ifds` / `test:lifecycle` | 求解机制、框架建模；生命周期命令排除受控基准 |
| `npm run test:nullness` | 空指针单测，排除独立大范围 Bench 测试文件 |
| `npm run test:resource` | 资源事实流、十个 SDK 规则家族及正反例 |
| `npm run test:cli` | 应用编排、CLI 和报告契约 |
| `npm test` / `npm run test:watch` | 默认大范围套件 / watch，均排除空指针与生命周期受控基准 |

只验证资源模块的一部分时，直接指定文件：

```bash
./node_modules/.bin/vitest run test/resourceleak/ResourceLeakFlow.test.ts
./node_modules/.bin/vitest run test/resourceleak/HarmonyResourceRules.test.ts
```

测试资产与当前模块对应；已通过的历史次数不作为本版本稳定性或真实应用精度保证。类型检查、正反例、入口契约和真实应用真值解决不同问题。

## 测试精简与保留边界

2026-10-16 快速静态审阅后的处理：

| 范围 | 判断与处理 |
| --- | --- |
| IFDS | 保留事实存储、调用解析、异常路径、队列与摘要回归；这些机制不能靠缺陷基准定位 |
| 生命周期 | 删除重复的 `LifecycleModelCreator.test.ts`；回调集合与多 Ability 已由 factory/collector 测试覆盖，将语句 CFG 归属检查合并到 `FlatLifecycleModelCreator.test.ts` |
| 生命周期 Showcase | 保留：含 Navigation destination 与跨 Ability 通信覆盖，不只是演示输出 |
| 空指针 | 删除无断言、只写文件的 `ArkTSNullSafetyIR.test.ts` 和对应 npm 命令；查看 IR 使用 `inspect:project-ir` |
| 空指针事实与流 | 删除旧 scaffold 的 placeholder 流函数烟测及构造器存在性断言；保留事实语义等价、guard、闭包、await、路径抽象等行为断言 |
| resource / closure / memory | 保留资源身份、正反例、生命周期边界、异常清理和预算失败等契约 |
| application / CLI / report | 保留模块失败隔离、默认检查、参数校验、诊断与统计输出契约 |

这是按断言价值做的静态筛选，不表示其余测试已全部执行或不存在冗余。删除依据应是无行为断言、已有等价覆盖或契约已退出；文件老、小、使用 mock 都不是单独的删除理由。

## IR 与生命周期检查

```bash
npm run inspect:project-ir -- "/path/to/app" \
  --sdk "/path/to/ets" --verbose-ir --output out/project-ir.txt

npm run inspect:dummymain -- "/path/to/app" \
  --sdk "/path/to/ets" --model hierarchical --format both
```

前者检查调用签名、位置和语句 lowering；后者检查框架入口、scope 和生成 CFG。结构更小、回调更少或零诊断都不是精度证明。

## 标注基准

空指针基准读取 `ArkDefectBench/Null Pointer Dereference/null_pointer_expected.json`：

```bash
npm run test:nullness:bench -- --case DirectNull --model flat
```

生命周期受控测试为 `npm run test:lifecycle:benchmark`。基准比较应固定输入、SDK、入口模型、摘要、预算、超时和真值；模型结构真值不能代替运行时缺陷真值。

空指针测试与 bench 分工：

| 层次 | 负责的问题 | 运行时机 |
| --- | --- | --- |
| `NullnessFact` / compatibility 单测 | 事实身份、null/undefined 区分、guard 分支、抽象证据、ArkAnalyzer 兼容边界 | 修改相应机制时 |
| `test/fixtures/nullness` 小型回归 | Map/find/SDK 摘要、字段更新、模块初始化、误报正反例、置信度与统计契约 | 修改对应规则或 runner 时，指定测试文件 |
| ArkDefectBench | 标注场景上的整链路检出与误报，覆盖传播、异常、生命周期、回调与异步 | 先运行相关 `--case`；跨机制修改或评估时另行运行完整基准 |
| 真实应用 | 可执行性、规模与人工复核候选 | 显式选择项目；无人工真值不报告缺陷精度 |

当前空指针 oracle 有 66 个 case。Bench 按源头与解引用的 class/method 对匹配诊断，输出 TP/FP/TN/FN、Recall、Accuracy；它不验证同一方法内的精确语句位置、完整执行路径、置信度或统计分解。因此不能用 bench 替代这些小测试，也不应把聚合 Accuracy 当成真实应用精度。

新增缺陷先写最小机制回归；需要评估场景覆盖时再补 bench 的独立正反例与 oracle，避免把整个 bench 样例复制进 `test/fixtures`。修复已有 bench case 时可直接用 `--case` 复现，只有需要更细的断言才另加小测试。受控基准仍由 Vitest 承载，但默认 npm 测试命令不运行它们；直接执行裸 `vitest` 会绕过这些排除参数。

## 真实应用脚本

清单位于 `HarmonyRealApps/meta.json`，源码目录与 SDK 需本机提供。先使用 `--list` 或 `--help` 查看选择范围；不带选择时可能分析完整清单。

```bash
npm run test:resource:real-apps -- --help
npm run test:nullness:real-apps -- --list

npm run test:resource:real-apps -- \
  --project PROJECT_NAME \
  --sdk-root "/path/to/sdk-root" --timeout-ms 180000 \
  --ifds-stats --output out/resource-real-apps.json
```

资源脚本直接运行唯一资源引擎，不接受 `--engine`。报告 schema 为 2，`resourceAnalysis.diagnostics` 为唯一诊断数组，计数、置信度、创建调用覆盖与统计分别保存。两个真实应用脚本分别运行资源或空指针，不负责闭包/内存真实应用精度评估。

逐项目独立进程、超时与增量报告记录执行状态、候选、覆盖、统计和内存。单项目成功只证明执行完成；缺少人工真值时不能计算可信的缺陷 Precision/Recall。

实验输出属于 `out/` 或 `artifacts/validation/`，不作为模块使用说明。保留数据必须带来源、版本/指纹、配置和覆盖；旧输出不代表当前稳定版本的实测结果。
