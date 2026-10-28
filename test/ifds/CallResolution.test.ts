import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import 'arkanalyzer';
import { ArkMethod, Scene, SceneConfig, Stmt } from '../../src/adapter/arkanalyzer';
import { ArkInterproceduralCFG, DataflowProblem, DataflowSolver } from '../../src/ifds';
import { findRecursiveMethods } from '../../src/ifds/CallResolver';

class ReachabilityProblem extends DataflowProblem<string> {
    constructor(private readonly entry: ArkMethod) { super(); }
    getNormalFlowFunction() { return { getDataFacts: (fact: string) => new Set([fact]) }; }
    getCallFlowFunction() { return this.getNormalFlowFunction(); }
    getExitToReturnFlowFunction() { return this.getNormalFlowFunction(); }
    getCallToReturnFlowFunction() { return this.getNormalFlowFunction(); }
    createZeroValue() { return 'ZERO'; }
    getEntryPoint() { return this.entry.getCfg()!.getStartingStmt(); }
    getEntryMethod() { return this.entry; }
    factEqual(left: string, right: string) { return left === right; }
}

describe('enhanced call resolution', () => {
    let scene: Scene;
    const method = (name: string): ArkMethod => scene.getMethods().find(m => m.getName() === name)!;
    const call = (name: string): Stmt => method(name).getCfg()!.getStmts().find(s => s.getInvokeExpr())!;

    beforeAll(() => {
        const projectPath = path.resolve(__dirname, '../fixtures/ifds/call-resolution');
        const config = new SceneConfig();
        config.buildConfig('call-resolution', projectPath, [{
            name: 'callbacksSdk',
            path: path.resolve(__dirname, '../fixtures/ifds/call-resolution-sdk'),
            moduleName: '',
        }]);
        scene = new Scene();
        scene.buildSceneFromProjectDir(config);
        scene.inferTypes();
    });

    it('uses a resolved SDK declaration with no executable body', () => {
        const signature = call('runSdk').getInvokeExpr()!.getMethodSignature();
        const file = signature.getDeclaringClassSignature().getDeclaringFileSignature();
        expect(scene.hasSdkFile(file)).toBe(true);
        expect(scene.getMethod(signature, true)?.getCfg()).toBeUndefined();
    });

    it('identifies self recursion and mutually recursive methods without including callers', () => {
        expect([...findRecursiveMethods(scene)].map(m => m.getName()).sort())
            .toEqual(['recursiveA', 'recursiveB', 'recursiveIgnore']);
    });

    it.each([
        ['runIgnored', ['ignore']],
        ['runUsed', ['invokeSecond', 'used']],
        ['runForward', ['forward', 'used']],
        ['runRecursive', ['recursiveB', 'used']],
        ['runRecursiveIgnore', ['recursiveIgnore']],
        ['runSdk', ['unused', 'used']],
        ['runSdkStatement', ['unused', 'used']],
        ['runForwardToSdk', ['forwardToSdk', 'unused', 'used']],
        ['runPointer', ['invokeSecond', 'used']],
        ['runPointerAlias', ['used']],
        ['runSameTarget', ['sameTarget']],
        ['runReassignedPointer', ['unused', 'used']],
        ['runCrossClassSdk', ['first', 'second']],
    ])(`resolves %s without inventing unused callback edges`, (entryName, expected) => {
        const icfg = new ArkInterproceduralCFG(scene);
        icfg.initialize(method(entryName as string));
        const stmt = call(entryName as string);
        expect(icfg.isCallStatement(stmt)).toBe(true);
        expect([...icfg.getCalleesOfCallAt(stmt)].map(m => m.getName()).sort())
            .toEqual([...expected].sort());
    });

    it(`preserves virtual targets and unions their invoked parameters`, () => {
        const icfg = new ArkInterproceduralCFG(scene);
        icfg.initialize(method('runVirtual'));
        expect([...icfg.getCalleesOfCallAt(call('runVirtual'))]
            .map(m => `${m.getDeclaringArkClass().getName()}.${m.getName()}`).sort())
            .toEqual(['%dflt.used', 'Base.dispatch', 'Derived.dispatch']);
    });

    it.each([false, true])(`clears call caches on initialize with CFG reuse=%s`, reuseCfgIndex => {
        const icfg = new ArkInterproceduralCFG(scene, reuseCfgIndex);
        const entry = method('runUsed');
        icfg.initialize(entry);
        const stmt = call('runUsed');
        const expression = stmt.getInvokeExpr()!;
        const argumentsBefore = [...expression.getArgs()];
        const irBefore = stmt.toString();
        const first = icfg.getCalleesOfCallAt(stmt);
        expect(icfg.getCalleesOfCallAt(stmt)).toBe(first);
        expect(stmt.toString()).toBe(irBefore);
        expect(expression.getArgs()).toEqual(argumentsBefore);
        icfg.initialize(entry);
        const second = icfg.getCalleesOfCallAt(stmt);
        expect(second).not.toBe(first);
        expect(second).toEqual(first);
    });

    it.each([
        ['runIgnored', [], ['unused', 'used']],
        ['runUsed', ['used'], ['unused']],
        ['runForward', ['used'], ['unused']],
        ['runSdk', ['unused', 'used'], []],
    ])('IFDS reaches only the expected callback bodies for %s', (entryName, included, excluded) => {
        const solver = new DataflowSolver(new ReachabilityProblem(method(entryName as string)), scene);
        solver.solve();
        const reached = new Set([...solver.getPathEdgeSet()]
            .map(edge => edge.edgeEnd.node.getCfg()!.getDeclaringMethod().getName()));
        for (const name of included) expect(reached.has(name)).toBe(true);
        for (const name of excluded) expect(reached.has(name)).toBe(false);
    });
});
