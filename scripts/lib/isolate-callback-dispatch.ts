import {
    ArkBody, ArkConditionExpr, ArkIfStmt, ArkReturnVoidStmt, BasicBlock, Cfg,
    RelationalBinaryOperator, ValueUtil,
} from '../../src/adapter/arkanalyzer';
import type { ArkMethod, Stmt } from '../../src/adapter/arkanalyzer';

/** Experimental underapproximation: init -> choose one event -> repeat it or teardown. */
export function isolateCallbackDispatch(main: ArkMethod, events: ReadonlySet<string>, repeat = true): number {
    const oldCfg = main.getCfg()!;
    const oldBlocks = [...oldCfg.getBlocks()];
    const entry = oldCfg.getStartingBlock()!;
    const exits = oldBlocks.filter(block => block.getStmts().at(-1) instanceof ArkReturnVoidStmt);
    if (exits.length !== 1) throw new Error('Expected one synthetic teardown block');
    const exit = exits[0];
    const groups: Stmt[][] = [];
    for (const block of oldBlocks) {
        if (block === entry || block === exit) continue;
        let pending: Stmt[] = [];
        for (const stmt of block.getStmts()) {
            pending.push(stmt);
            const target = stmt.getInvokeExpr()?.getMethodSignature().toString();
            if (target && events.has(target)) {
                groups.push(pending);
                pending = [];
            }
        }
        if (pending.some(stmt => stmt.getInvokeExpr())) {
            throw new Error('Unclassified event invocation would be discarded');
        }
    }
    const cfg = new Cfg();
    cfg.setDeclaringMethod(main);
    const blockOf = (stmts: readonly Stmt[]): BasicBlock => {
        const block = new BasicBlock();
        for (const stmt of stmts) block.addStmt(stmt);
        cfg.addBlock(block);
        return block;
    };
    const head = (): BasicBlock => blockOf([new ArkIfStmt(new ArkConditionExpr(
        ValueUtil.getBooleanConstant(true), ValueUtil.getBooleanConstant(false),
        RelationalBinaryOperator.InEquality,
    ))]);
    const link = (from: BasicBlock, to: BasicBlock): void => {
        from.addSuccessorBlock(to);
        to.addPredecessorBlock(from);
    };
    const start = blockOf(entry.getStmts());
    const choice = head();
    const end = blockOf(exit.getStmts());
    link(start, choice);
    link(choice, end);
    for (const stmts of groups) {
        const event = blockOf(stmts);
        link(choice, event);
        if (repeat) {
            const continuation = head();
            link(event, continuation); // ICFG calls must have a single return site.
            link(continuation, event);
            link(continuation, end);
        } else {
            link(event, end);
        }
    }
    main.setBody(new ArkBody(new Set(main.getBody()!.getLocals().values()), cfg));
    cfg.setStartingStmt(start.getStmts()[0]);
    for (const block of cfg.getBlocks()) {
        cfg.updateStmt2BlockMap(block);
        for (const stmt of block.getStmts()) stmt.setCfg(cfg);
    }
    return groups.length;
}
