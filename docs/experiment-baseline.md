# 2026-10-17 实验代码基线

固定标签：`baseline/2026-10-17-opt-flat`。该标签指向本次整理提交；后续实验从此版本开始，比较基线显式选择 `opt-flat`。CLI 默认仍为 `flat`，没有修改默认行为。

## 本次取舍

| 改动 | 处理与依据 |
| --- | --- |
| hierarchical 调用后的唯一返回节点 | 保留。ICFG 每次调用只读取一个返回位置；先返回唯一节点再分支，避免遗漏导航目标或页面入口的非零事实。 |
| 对应 CFG 数量断言及 IFDS 回归测试 | 保留。复用已有 `page-scope` fixture，覆盖旧布局负对照、导航本地和目标后继、页面枚举顺序及唯一返回位置。 |
| 来源页面保留开关、导航风险分类器、按页 fallback 调用块、实验 scope 字段和真实应用脚本参数 | 回退。1017 筛查未发现传播工作量收益，不纳入正式基线。 |
| fallback 上下文实验测试和 fixture | 移入本地实验归档，不作为维护中的功能测试。 |
| b=0、临时切断及配对模型等 `out/1017` 实验 | 留在忽略目录，不进入生产代码或本次提交。 |
| 已有 `.gitignore` 修改及两份研究文档搬迁 | 保持工作区原状，不纳入本次提交；不影响基线代码。 |

回退前的补丁、源码和实验测试快照保存在 `out/1017/baseline-freeze-*`；`out/1017/baseline-freeze-latest.txt` 记录本次归档位置。历史实验需使用各自 provenance 恢复环境，不能直接把新基线的运行结果与旧结果拼为配对实验。

## 后续对照配置

空指针实验共同使用以下配置；改变配置须另行命名并让两组同时改变：

- 生命周期：`opt-flat`；compact dispatcher 和可达 Ability 裁剪均开启。
- 根集合：保留默认生命周期、模块初始化及框架 sink 根，不使用 `--lifecycle-root-only`。
- AP 参数 5，事实推导深度 40；保留现有大项目自动抽象规则，并记录实际生效值。它们不是事件次数预算。
- SDK：API 17，OpenHarmony/HMS ETS `5.0.5.165`。
- 单 worker 串行运行，V8 heap 4096 MiB，每项目超时 300 秒；两组使用相同项目版本。
- 依赖使用本提交的 `package-lock.json`；冻结时 Node `v22.19.0`、npm `11.11.0`。

示例（本次未运行真实应用）：

```bash
NODE_OPTIONS=--max-old-space-size=4096 npm run test:nullness:real-apps -- \
  --project harmony-utils --lifecycle-model opt-flat --ifds-stats \
  --sdk-root sdk/default --timeout-ms 300000 \
  --max-access-path-length 5 --max-propagation-depth 40 \
  --output out/next-experiment/opt-flat.json
```

每次结果需记录代码 commit、项目 commit、SDK、依赖与有效配置，并分开报告合成节点和非合成方法的传播量。每个候选先单独与 opt-flat 比较，不把多个优化组合的收益归给一个措施。

## 保留的边界与验证

本次没有新增生命周期协议、事实过滤或预算；`onDidBuild` 的循环近似、入口统一创建组件、静态来源与解引用的全局配对等现有行为均保留。因此该版本是可复现的比较起点，不代表模型语义已完整或获得性能提升。

本次验证：`npm run typecheck:test`；定向运行 `HierarchicalLifecycleModelCreator.test.ts` 和 `LifecycleCallContinuations.test.ts`，共 8 项通过。未运行完整测试、全量构建、端到端测试或真实应用基准。
