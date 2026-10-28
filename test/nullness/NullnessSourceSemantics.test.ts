import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ArkInstanceInvokeExpr, Scene, SceneConfig } from '../../src/adapter/arkanalyzer';
import type { ArkFile, ArkMethod, Stmt } from '../../src/adapter/arkanalyzer';
import { NullnessSourceSemantics, NULL, UNDEFINED } from '../../src/analysis/nullness/NullnessSourceSemantics';
import { NullnessProblem } from '../../src/analysis/nullness/NullnessProblem';
import { NullnessSolver } from '../../src/analysis/nullness/NullnessSolver';
import { NullnessAccessPath, NullnessFact, NullnessKind, NullnessOriginKind } from '../../src/analysis/nullness/NullnessFact';

function sourceStatement(code: string) {
    code = `// source fixture\n${code}`;
    const getCode = vi.fn(() => code);
    const file = { getCode, getFilePath: () => 'test.ts' } as unknown as ArkFile;
    const stmt = {
        getOriginPositionInfo: () => ({ getLineNo: () => 1, getColNo: () => 1 }),
        getOriginalText: () => code,
        getCfg: () => ({ getDeclaringMethod: () => ({ getDeclaringArkFile: () => file }) }),
    } as unknown as Stmt;
    return { stmt, getCode };
}

describe('source access semantics', () => {
    it.each([
        ['(): void => { this.value = null; }', true],
        ['async (value: number) => value', true],
        ['function () { return () => 1; }', false],
    ])('classifies and caches arrow receiver ownership in %s', (code, expected) => {
        const getCode = vi.fn(() => code);
        const method = { getCode, isAnonymousMethod: () => true,
            getOuterMethod: () => undefined } as unknown as ArkMethod;
        const semantics = new NullnessSourceSemantics();
        expect(semantics.isArrowMethod(method)).toBe(expected);
        expect(semantics.isArrowMethod(method)).toBe(expected);
        expect(getCode).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['x && x!.run();', NULL | UNDEFINED],
        ['!x || x!.run();', NULL | UNDEFINED],
        ['x !== null && x!.run();', NULL],
        ['x !== undefined && x!.run();', UNDEFINED],
        ['x != null && x!.run();', NULL | UNDEFINED],
        ['x instanceof Account && x!.run();', NULL | UNDEFINED],
        ['if (!x) return; x!.run();', 0], // Top-level return has no enclosing method block.
        ['function f() { if (!x) return; x!.run(); }', NULL | UNDEFINED],
        ['if (x) { x = null; x!.run(); }', 0],
        ['this.x && reset() && this.x!.run();', 0],
        ['if (this.x) { reset(); this.x!.run(); }', 0],
        ['function f() { if (!x) return; x = null; x!.run(); }', 0],
        ['if (a || (x = create())) { a = false; const v = a ? 0 : x!.run(); }', 0],
        ['if (check() || (x = create())) { const v = check() ? 0 : x!.run(); }', 0],
        ['if (x) { const f = () => x!.run(); }', 0],
        ['if (x) { let x = null; x!.run(); }', 0],
        ['if (x) { const { x } = object; x!.run(); }', 0],
        ['if (x) { while (true) { x!.run(); x = null; } }', 0],
        ['if (getValue()) { getValue()!.run(); }', 0],
        ['x!.run() || x === undefined;', 0],
    ])('respects evaluation order and invalidation in %s', (code, excluded) => {
        const { stmt } = sourceStatement(code);
        const accesses = new NullnessSourceSemantics().getAccesses(stmt);
        const use = accesses.find(access => access.member === 'run')!;
        expect(use, code).toBeDefined();
        expect(use.excluded).toBe(excluded);
    });

    it('distinguishes individual accesses, comments, strings and template coercion', () => {
        const { stmt, getCode } = sourceStatement('const v = [x?.field, y!.field, `x?.field ${z}`, "y!.field"]; /* a!.field */');
        const semantics = new NullnessSourceSemantics();
        const accesses = semantics.getAccesses(stmt);
        expect(accesses.filter(access => access.member === 'field')).toEqual([
            expect.objectContaining({ receiver: 'x', optional: true, asserted: false }),
            expect.objectContaining({ receiver: 'y', optional: false, asserted: true }),
        ]);
        expect(accesses.find(access => access.receiver === 'z')?.coercion).toBe(true);
        expect(semantics.getAccesses(stmt)).toBe(accesses);
        semantics.getAccesses({ ...stmt } as Stmt);
        expect(getCode).toHaveBeenCalledTimes(1);
    });

    it('identifies only a null check evaluated after the asserted access', () => {
        const { stmt } = sourceStatement('x!.run() || x === undefined;');
        expect(new NullnessSourceSemantics().getAccesses(stmt)
            .find(access => access.member === 'run')?.checkedLater).toBe(UNDEFINED);
        const safe = sourceStatement('x === undefined || x!.run();').stmt;
        expect(new NullnessSourceSemantics().getAccesses(safe)
            .find(access => access.member === 'run')?.checkedLater).toBe(0);
    });
});

describe('nullness source recovery regressions', () => {
    let scene: Scene;
    beforeAll(() => {
        const project = path.resolve(__dirname, '../fixtures/nullness/source-semantics');
        const config = new SceneConfig();
        config.buildConfig('source-semantics', project, []);
        scene = new Scene();
        scene.buildSceneFromProjectDir(config);
        scene.inferTypes();
    });

    it.each(['mixedAccesses', 'guardThenWrite', 'repeatedCall', 'readyWithoutResource'])(
        'keeps concrete nullish evidence in %s', name => {
            const method = scene.getMethods().find(method => method.getName() === name)!;
            const problem = new NullnessProblem(method.getCfg()!.getStartingStmt(), method);
            new NullnessSolver(problem, scene).solve();
            const diagnostics = problem.getNullDereferences();
            expect(diagnostics.some(diagnostic => diagnostic.dereferenceStmt.getOriginalText()?.includes('!.touch()')))
                .toBe(true);
            if (name === 'mixedAccesses') {
                expect(diagnostics.some(diagnostic => diagnostic.accessPath.toString() === 'safe')).toBe(false);
            }
        }
    );

    it.each(['optionalIndex', 'optionalUnknownIndex', 'guardedArrayRead', 'guardedStringRead', 'guardedStringArgument',
        'guardedFieldAlias', 'ternaryFieldAlias', 'templateReturnCoercion', 'guardedCalleeArgument', 'mapGuardInLoop',
        'preservedFieldSnapshot', 'arrayGuardWithNestedComparison', 'shadowedCallbackCapture',
        'preservedSnapshotArgument', 'compoundFieldGuard'])(
        'does not report protected access in %s', name => {
        const method = scene.getMethods().find(method => method.getName() === name)!;
        const problem = new NullnessProblem(method.getCfg()!.getStartingStmt(), method);
        new NullnessSolver(problem, scene).solve();
        expect(problem.getNullDereferences()).toHaveLength(0);
    });

    it.each(['assertedIndex', 'nullableChildInOptionalChain', 'typeofObjectStillNull',
        'arbitraryPredicateStillNull', 'staleTypeofStillNull', 'explicitPredicateComparisonStillNull',
        'sameNamedPredicateStillNull', 'mixedIndexedAccesses', 'explicitReturnToString',
        'nullOnlyFallbackStillUndefined', 'unguardedCalleeArgument', 'mapGuardThenDelete',
        'nullableFieldSnapshot', 'realCallbackCapture', 'nullableSnapshotArgument', 'mapFalseGuard',
        'mapGuardThenUnknownCall', 'staleSnapshotGuardStillNull',
        'compoundFieldGuardThenMutation'])('retains a null dereference in %s', name => {
        const method = scene.getMethods().find(method => method.getName() === name)!;
        const problem = new NullnessProblem(method.getCfg()!.getStartingStmt(), method);
        new NullnessSolver(problem, scene).solve();
        expect(problem.getNullDereferences().length).toBeGreaterThan(0);
        if (name === 'mixedIndexedAccesses') {
            expect(problem.getNullDereferences().every(diagnostic => diagnostic.accessPath.base?.getName() === 'unsafe'))
                .toBe(true);
        }
    });

    it('reuses statement extraction across facts and reports one source location once', () => {
        const method = scene.getMethods().find(method => method.getName() === 'mixedAccesses')!;
        const sink = method.getCfg()!.getStmts().find(stmt => {
            const invoke = stmt.getInvokeExpr();
            return invoke instanceof ArkInstanceInvokeExpr && invoke.getBase().getName() === 'unsafe';
        })!;
        const invoke = sink.getInvokeExpr() as ArkInstanceInvokeExpr;
        const accessPath = NullnessAccessPath.fromValue(invoke.getBase());
        const problem = new NullnessProblem(method.getCfg()!.getStartingStmt(), method);
        const uses = vi.spyOn(sink, 'getUses');
        try {
            const flow = problem.getNormalFlowFunction(sink, sink);
            const propagate = (kind: NullnessKind): void => {
                flow.getDataFacts(NullnessFact.create(accessPath, kind, {
                    kind: NullnessOriginKind.NullLiteral, stmt: sink,
                }));
            };
            propagate(NullnessKind.Null);
            // Initial extraction includes ArkAnalyzer's getInvokeExpr and library matching.
            const initialScans = uses.mock.calls.length;
            expect(initialScans).toBeGreaterThan(0);
            propagate(NullnessKind.MaybeNull);
            expect(uses).toHaveBeenCalledTimes(initialScans);
            expect(problem.getNullDereferences()).toHaveLength(1);
        } finally {
            uses.mockRestore();
        }
    });
});
