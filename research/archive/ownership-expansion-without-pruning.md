# Ownership Expansion Without Transition Pruning

## 归档结论

“只要从 ViewTree 识别更多 Ability-owned Component，就能自然获得 hierarchy 性能收益”被本轮实验否定。ownership closure 的实现仍可复用，但它本身不再作为当前优化方向。

## 实现过的方案

- 从 `loadContent` / router 解析直接 Page 根；
- 沿 ViewTree custom-component 边求 Component 闭包；
- 从已归属 Component 的导航调用继续发现 Page；
- 路径优先匹配，类名唯一匹配只作后备；歧义与缺失均保守 fallback；
- 新增 ownership 和 callback-transition 直接计数。

## 实验结果

4 个项目中：

- owned Component：5 → 51；
- owner-bound callback：41 → 105；
- 候选 callback transition：726,804；
- `prunedCrossAbilityTransitions`：0；
- 99.02% transition 因至少一端 owner 未知而保守保留；
- 相对上一版 M1 只减少 70 条 reached fact/path edge 和 91 次 propagation attempt；时间无一致方向。

原因是新增 owner-bound callback 没有分布到 owner 集合不相交的 Ability scope。覆盖率提升是事实，但没有转化为可裁剪关系。

原始数据：[`out/pq1.5.1`](../../out/pq1.5.1)。

## 同期失败尝试

曾尝试在父 Component 的 ViewTree 遍历中截断子 Component 子树，CoolMallArkTS 的已建模 callback 从 52 降到 5。部分 V2 组件只在父页面展开树中暴露完整事件，因此该做法会破坏事件集合，已撤销。

## 已吸收的经验

1. ownership coverage 与 transition pruning 必须分别计数，不能用前者代替后者。
2. 不应为“归属更干净”而改变 callback collection；事件集必须先保持一致。
3. Ability 粒度过粗。下一次只值得尝试独立 Page 图、active-page scope 和 `prunedCrossPageTransitions`。

## 重新启用条件

只有当新数据表明 callback 分布到多个互斥 Page/Ability scope，并能在不丢合法路径的前提下产生非零直接 pruning 时，才把这条线重新提升到 `method/`。
