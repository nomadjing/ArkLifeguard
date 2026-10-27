import { expect, it } from 'vitest';
import 'arkanalyzer';
import type { BasicBlock } from '../../src/adapter/arkanalyzer';
import { createLifecycleModelCreator } from '../../src/lifecycle';
import { buildLifecycleScene } from '../helpers/buildScene';
import { isolateCallbackDispatch } from '../../scripts/lib/isolate-callback-dispatch';

it.each([false, true])('preserves calls and teardown and blocks other events with repeat=%s', repeat => {
    const creator = createLifecycleModelCreator(buildLifecycleScene('page-scope'));
    creator.create();
    const main = creator.getDummyMain();
    const signatures = () => main.getCfg()!.getStmts().flatMap(stmt => {
        const sig = stmt.getInvokeExpr()?.getMethodSignature().toString();
        return sig ? [sig] : [];
    }).sort();
    const before = signatures();
    const events = new Set([
        ...creator.getAbilities().flatMap(a => [...a.lifecycleMethods.values()]),
        ...creator.getComponents().flatMap(c => [...c.lifecycleMethods.values(), ...c.uiCallbacks.map(x => x.callbackMethod)]),
    ].map(m => m.getSignature().toString()));
    expect(isolateCallbackDispatch(main, events, repeat)).toBeGreaterThan(0);
    expect(signatures()).toEqual(before);
    const blocks = [...main.getCfg()!.getBlocks()];
    const find = (name: string) => blocks.find(b => b.getStmts().some(stmt =>
        stmt.getInvokeExpr()?.getMethodSignature().getMethodSubSignature().getMethodName() === name))!;
    const from = find('handleHomeTap');
    const other = find('handleDetailsTap');
    const seen = new Set<BasicBlock>();
    const pending = [...from.getSuccessors()];
    while (pending.length) {
        const block = pending.pop()!;
        if (seen.has(block)) continue;
        seen.add(block);
        pending.push(...block.getSuccessors());
    }
    expect(seen.has(from)).toBe(repeat);
    expect(seen.has(other)).toBe(false);
    expect([...seen].some(b => b.getSuccessors().length === 0)).toBe(true);
});
