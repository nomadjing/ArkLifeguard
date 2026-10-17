import { describe, expect, it } from 'vitest';
import 'arkanalyzer';
import type { ArkMethod, Stmt } from '../../src/adapter/arkanalyzer';
import { DataflowProblem, DataflowSolver, FlowFunction } from '../../src/ifds';
import { createLifecycleModelCreator } from '../../src/lifecycle';
import { buildLifecycleScene } from '../helpers/buildScene';

/** A nonzero caller fact observed before any subsequent event call. */
class CallerFactProblem extends DataflowProblem<string> {
    constructor(private readonly main: ArkMethod, private readonly source: Stmt) { super(); }
    private identity: FlowFunction<string> = { getDataFacts: fact => new Set([fact]) };
    getNormalFlowFunction() { return this.identity; }
    getCallFlowFunction(): FlowFunction<string> {
        return { getDataFacts: fact => new Set(fact === 'ZERO' ? [fact] : []) };
    }
    getExitToReturnFlowFunction() { return this.identity; }
    getCallToReturnFlowFunction(stmt: Stmt): FlowFunction<string> {
        return { getDataFacts: fact => {
            if (fact === 'PAYLOAD' && stmt !== this.source) return new Set();
            return new Set(stmt === this.source && fact === 'ZERO' ? [fact, 'PAYLOAD'] : [fact]);
        } };
    }
    createZeroValue() { return 'ZERO'; }
    getEntryPoint() { return this.main.getCfg()!.getStartingStmt(); }
    getEntryMethod() { return this.main; }
    factEqual(a: string, b: string) { return a === b; }
}
class CallerFactSolver extends DataflowSolver<string> {}

function run(sourceName: string, normalize = true, reverse = false) {
    const scene = buildLifecycleScene('page-scope');
    const creator = createLifecycleModelCreator(scene, 'hierarchical');
    if (!normalize) (creator as any).normalizeCallContinuations = () => {};
    if (reverse) {
        const original = (creator as any).collectUnambiguousPageGroups.bind(creator);
        (creator as any).collectUnambiguousPageGroups = () => original().reverse();
    }
    creator.create();
    const main = creator.getDummyMain();
    const calls = [...main.getCfg()!.getBlocks()].flatMap(block => block.getStmts())
        .filter(stmt => stmt.getInvokeExpr());
    const source = calls.find(stmt => stmt.getInvokeExpr()!.getMethodSignature()
        .getMethodSubSignature().getMethodName() === sourceName)!;
    expect(source).toBeDefined();
    const solver = new CallerFactSolver(new CallerFactProblem(main, source), scene);
    solver.solve();
    const reached = new Set([...solver.getPathEdgeSet()]
        .filter(edge => edge.edgeEnd.fact === 'PAYLOAD').map(edge => edge.edgeEnd.node));
    const pages = creator.getScopeModelInfo()!.pageScopes
        .filter(page => reached.has(page.eventHead)).map(page => page.pageId).sort();
    return { pages, calls, main };
}

describe('hierarchical call continuations in the IFDS solver', () => {
    it('reproduces the missed target with the old multi-successor call layout', () => {
        expect(run('navigateToDetails', false).pages).not.toContain('pages/DetailsPage');
    });
    it('propagates a nonzero post-navigation fact to both local and target continuations', () => {
        expect(run('navigateToDetails').pages).toEqual(['pages/DetailsPage', 'pages/HomePage']);
    });
    it('preserves all foreground entries independently of page enumeration order', () => {
        for (const reverse of [false, true]) {
            expect(run('onForeground', true, reverse).pages)
                .toEqual(['pages/DetailsPage', 'pages/HomePage']);
        }
    });
    it('gives every synthetic call at most one immediate normal successor', () => {
        const { calls, main } = run('onForeground');
        for (const call of calls) {
            const block = main.getCfg()!.getStmtToBlock().get(call)!;
            if (block.getTail() === call) expect(block.getSuccessors().length).toBeLessThanOrEqual(1);
        }
    });
});
