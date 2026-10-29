import { expect, it } from 'vitest';
import { DummyMainCreater } from 'arkanalyzer';
import { ArkReturnVoidStmt, type BasicBlock } from '../../src/adapter/arkanalyzer';
import { buildLifecycleScene } from '../helpers/buildScene';
import { isolateNativeDispatch } from '../../scripts/lib/isolate-native-dispatch';

it('preserves native statements and prevents a second event or cycle after dispatch', () => {
    const creator = new DummyMainCreater(buildLifecycleScene('simple'), undefined, undefined, true);
    creator.createDummyMain();
    const main = creator.getDummyMain();
    const before = [...main.getCfg()!.getStmts()];
    expect(isolateNativeDispatch(main)).toBeGreaterThan(0);
    const cfg = main.getCfg()!;
    expect(cfg.getStmts()).toEqual(before);
    const active = new Set<BasicBlock>();
    const done = new Set<BasicBlock>();
    function visit(b: BasicBlock): void {
        expect(active.has(b)).toBe(false);
        if (done.has(b)) return;
        active.add(b);
        for (const next of b.getSuccessors()) {
            expect(next.getPredecessors()).toContain(b);
            visit(next);
        }
        active.delete(b); done.add(b);
    }
    visit(cfg.getStartingBlock()!);
    const entry = cfg.getStartingBlock()!;
    for (const b of cfg.getBlocks()) {
        if (b === entry || b.getTail() instanceof ArkReturnVoidStmt) continue;
        if (b.getStmts().some(s => s.getInvokeExpr())) {
            expect(b.getSuccessors()).toHaveLength(1);
            expect(b.getSuccessors()[0].getTail()).toBeInstanceOf(ArkReturnVoidStmt);
        }
    }
});
