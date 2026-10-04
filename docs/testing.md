# 测试与调试

## 最小验证

先检查直接修改范围，再运行相关单元测试；不默认运行完整套件、构建、E2E 或耗时基准。预计超过两分钟先确认范围。工作区提供 `AGENTS.md` 时，同时遵守其中的测试策略。

| 命令 | 范围 |
| --- | --- |
| `npm run typecheck` | 生产源码 |
| `npm run typecheck:test` | 生产与测试源码 |
| `npm run typecheck:scripts` | 生产与脚本源码 |
| `npm run test:closure` / `test:memory` | 注册/捕获/迁移、内存保留 |
| `npm run test:ifds` / `test:lifecycle` | 求解机制、框架建模 |
| `npm run test:nullness` | 空指针单测，排除独立大范围 Bench 测试文件 |
| `npm run test:resource` | 当前旧资源模块单测；不包含独立资源测试 |
| `npm run test:cli` | 应用编排、CLI 和报告契约 |
| `npm test` | 默认大范围套件，排除 `NullnessArkDefectBench.test.ts` |

独立资源模块直接指定文件/目录：

```bash
./node_modules/.bin/vitest run test/resourceleak/ResourceLeakFlow.test.ts
./node_modules/.bin/vitest run test/resourceleak/HarmonyResourceRules.test.ts
```

测试资产与当前模块对应；已通过的历史次数不作为本版本稳定性或真实应用精度保证。类型检查、正反例、入口契约和真实应用真值解决不同问题。

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

## 真实应用脚本

清单位于 `HarmonyRealApps/meta.json`，源码目录与 SDK 需本机提供。先使用 `--list` 或 `--help` 查看选择范围；不带选择时可能分析完整清单。

```bash
npm run test:resource:real-apps -- --help
npm run test:nullness:real-apps -- --list

npm run test:resource:real-apps -- \
  --project PROJECT_NAME --engine new \
  --sdk-root "/path/to/sdk-root" --timeout-ms 180000 \
  --ifds-stats --output out/resource-real-apps.json
```

资源脚本使用 `--engine`，工程 CLI 使用 `--resource-engine`，不能混用。当前两个真实应用脚本分别运行资源或空指针，不负责闭包/内存真实应用精度评估。

逐项目独立进程、超时与增量报告记录执行状态、候选、覆盖、统计和内存。单项目成功只证明执行完成；缺少人工真值时不能计算可信的缺陷 Precision/Recall。

实验输出属于 `out/` 或 `artifacts/validation/`，不作为模块使用说明。保留数据必须带来源、版本/指纹、配置和覆盖；旧输出不代表当前稳定版本的实测结果。
