import assert from 'node:assert/strict';
import { ArkIfStmt, ArkReturnVoidStmt, type ArkMethod } from '../../src/adapter/arkanalyzer';

/** Keep native event payloads/paired calls intact; end dispatch after one event. */
export function isolateNativeDispatch(main: ArkMethod): number {
    const cfg = main.getCfg()!;
    const blocks = [...cfg.getBlocks()];
    const entry = cfg.getStartingBlock()!;
    assert.equal(entry.getSuccessors().length, 1);
    const head = entry.getSuccessors()[0];
    assert.ok(head.getTail() instanceof ArkIfStmt);
    const exits = blocks.filter(b => b.getTail() instanceof ArkReturnVoidStmt);
    assert.equal(exits.length, 1);
    const exit = exits[0];
    const middle = blocks.filter(b => b !== entry && b !== head && b !== exit);
    const events = middle.filter(b => !(b.getTail() instanceof ArkIfStmt));
    for (const event of events) {
        assert.ok(event.getStmts().some(s => s.getInvokeExpr()), 'Unknown native event block');
    }
    for (const block of [...middle, head]) {
        const targets = events.includes(block) ? [...block.getSuccessors()]
            : block.getSuccessors().filter(next => next === head);
        for (const next of targets) {
            block.removeSuccessorBlock(next);
            next.removePredecessorBlock(block);
        }
        if (targets.length && !block.getSuccessors().includes(exit)) {
            block.addSuccessorBlock(exit);
            exit.addPredecessorBlock(block);
        }
    }
    return events.length;
}
