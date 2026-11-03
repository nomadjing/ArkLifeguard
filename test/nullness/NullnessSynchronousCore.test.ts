import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Scene, SceneConfig } from '../../src/adapter/arkanalyzer';
import { NullnessProblem, NullnessSolver, NullnessLibraryRegistry } from '../../src/analysis/nullness';
import { NullnessMetadataCache } from '../../src/analysis/nullness/NullnessProblem';
import { NullnessSourceSemantics } from '../../src/analysis/nullness/NullnessSourceSemantics';
import { NullnessFact } from '../../src/analysis/nullness/NullnessFact';
import { SdkSignatureSummary } from '../../src/analysis/nullness/library/SdkSignatureSummary';

describe('nullness synchronous core', () => {
    let scene: Scene;
    beforeAll(() => {
        const config = new SceneConfig();
        config.buildConfig('synchronous-core', path.resolve(__dirname, '../fixtures/nullness/synchronous-core'), []);
        scene = new Scene();
        scene.buildSceneFromProjectDir(config);
        scene.inferTypes();
    });
    function analyze(name: string) {
        const method = scene.getMethods().find(method => method.getName() === name)!;
        const registry = NullnessLibraryRegistry.createDefault(scene);
        const problem = new NullnessProblem(method.getCfg()!.getStartingStmt(), method, {}, registry);
        const solver = new NullnessSolver(problem, scene);
        solver.solve();
        return { diagnostics: problem.getNullDereferences(), registry, reached: solver.getReachedFacts() };
    }
    it('reuses metadata across roots while preserving independent facts and diagnostics', () => {
        const method = scene.getMethods().find(method => method.getName() === 'copiedUndefined')!;
        const registry = NullnessLibraryRegistry.createDefault(scene);
        const source = new NullnessSourceSemantics();
        const metadata = new NullnessMetadataCache(registry, source);
        const run = (shared: boolean) => {
            const problem = new NullnessProblem(method.getCfg()!.getStartingStmt(), method, {}, registry,
                source, shared ? metadata : undefined);
            expect(problem.getNullDereferences()).toHaveLength(0);
            const solver = new NullnessSolver(problem, scene);
            solver.solve();
            return { diagnostics: problem.getNullDereferences().map(d =>
                [d.nullness, d.sourceLocation, d.dereferenceLocation, d.accessPath.toString()]),
                facts: [...solver.getReachedFacts()].map(([stmt, facts]) =>
                    [stmt, facts.map(fact => fact.toString()).sort()]) };
        };
        const first = run(true);
        expect(first.diagnostics.length).toBeGreaterThan(0);
        const cached = method.getCfg()!.getStmts().map(stmt => metadata.statementInfo.get(stmt));
        expect(cached.some(Boolean)).toBe(true);
        expect(run(true)).toEqual(first);
        expect(method.getCfg()!.getStmts().map(stmt => metadata.statementInfo.get(stmt))).toEqual(cached);
        expect(run(false)).toEqual(first);
        expect(() => new NullnessProblem(method.getCfg()!.getStartingStmt(), method, {}, registry,
            new NullnessSourceSemantics(), metadata)).toThrow('same library registry and source semantics');
    });

    it.each(['mixedOptionalCalls', 'reversedOptionalCalls'])(
        'separates optional and asserted accesses in %s without equating repeated calls', name => {
            const result = analyze(name);
            expect(result.diagnostics).toHaveLength(1);
            const receiver = result.diagnostics[0].accessPath.base!;
            const definition = (receiver as import('../../src/adapter/arkanalyzer').Local).getDeclaringStmt()!;
            const position = definition.getOperandOriginalPosition(definition.getInvokeExpr()!)!;
            const text = definition.getCfg()!.getDeclaringMethod().getDeclaringArkFile().getCode().split('\n')[position.getFirstLine() - 1];
            expect(text.slice(position.getLastCol() - 1).trimStart().startsWith('!')).toBe(true);
        });
    it.each(['optionalCallOnly', 'guardedJson', 'stringApis', 'jsonNullGuard', 'jsonUndefinedReviver', 'jsonNullReviver'])('keeps protected API access safe in %s', name => {
        expect(analyze(name).diagnostics).toHaveLength(0);
    });
    it.each(['jsonNull', 'jsonUndefined', 'jsonCallableReviver', 'jsonNullStillUnsafe', 'jsonRoundtripToNull'])('retains explicit nullable API evidence in %s', name => {
        expect(analyze(name).diagnostics.length).toBeGreaterThan(0);
    });
    it.each(['guardedGetter', 'optionalGetter', 'flagGuard', 'guardedIteration', 'nestedGuarded', 'nestedReadMethod'])('proves the safe core case %s', name => {
        expect(analyze(name).diagnostics).toHaveLength(0);
    });
    it.each(['returnedParameter', 'nullableGetter', 'changedGetter', 'effectfulGetter',
        'flagGuardMissingAssignment', 'flagGuardThenNull', 'flagGuardWithAssignmentInCondition',
        'shadowedFlag', 'copiedUndefined', 'nestedUnsafe', 'nestedChanged', 'nestedChangedByCall', 'nestedSavedThenChanged', 'unrelatedGetterGuard'])(
        'retains the unsafe core case %s', name => {
            expect(analyze(name).diagnostics.length).toBeGreaterThan(0);
        });
    it('does not execute a registered callback synchronously outside the supported synchronous scope', () => {
        const result = analyze('deferredCallback');
        expect(result.diagnostics).toHaveLength(0);
        expect([...result.reached.keys()].some(stmt =>
            stmt.getCfg()?.getDeclaringMethod().isAnonymousMethod())).toBe(false);
    });
    it('keeps project-proven synchronous callbacks but does not inline timer wrappers', () => {
        expect(analyze('synchronousCallback').diagnostics.length).toBeGreaterThan(0);
        expect(analyze('synchronousForEachBody').diagnostics.length).toBeGreaterThan(0);
        expect(analyze('timerWrapper').diagnostics).toHaveLength(0);
    });
    it('propagates verified await completion values without entering async callees synchronously', () => {
        const call = analyze('callsAsync');
        expect(analyze('awaitedValue').diagnostics).toHaveLength(1);
        expect(analyze('awaitedNullableOperand').diagnostics).toHaveLength(1);
        expect([...call.reached.keys()].some(stmt =>
            stmt.getCfg()?.getDeclaringMethod().getName() === 'asynchronous')).toBe(false);
    });
    it('models exact built-in numeric conversions without assuming arbitrary toString is non-null', () => {
        const method = scene.getMethods().find(method => method.getName() === 'numericConversions')!;
        const calls = method.getCfg()!.getStmts().filter(stmt => stmt.getInvokeExpr());
        const registry = NullnessLibraryRegistry.createDefault(scene);
        const model = new SdkSignatureSummary();
        const find = (text: string) => calls.find(stmt =>
            stmt.getInvokeExpr()!.getMethodSignature().toString() === text)!;
        for (const signature of ['@built-in/lib.es5.d.ts: NumberConstructor.create(any)',
            '@built-in/lib.es5.d.ts: Number.toString(number)']) {
            const stmt = find(signature);
            expect(stmt).toBeDefined();
            expect(model.matches(stmt)).toBe(true);
            expect(registry.getCallToReturnFacts(stmt, NullnessFact.getZeroFact()).size).toBe(0);
        }
        const unknown = find('@%unk/%unk: .toString()');
        expect(unknown).toBeDefined();
        expect(model.matches(unknown)).toBe(false);
        expect(registry.getCallToReturnFacts(unknown, NullnessFact.getZeroFact()).size).toBe(0);
        const fake = { getInvokeExpr: () => ({ getMethodSignature: () => ({
            toString: () => '@business/lib.es5.d.ts: NumberConstructor.create(any)' }) }) };
        expect(model.matches(fake as never)).toBe(false);
    });

    it('never borrows a model from a same-name unresolved or project method', () => {
        const model = new SdkSignatureSummary();
        const signature = { toString: () => '@%unk/%unk: Map.get(K)' };
        const stmt = { getInvokeExpr: () => ({ getMethodSignature: () => signature }) };
        expect(model.matches(stmt as never)).toBe(false);
        signature.toString = () => '@business/lib.es2015.collection.d.ts: Map.get(K)';
        expect(model.matches({ ...stmt } as never)).toBe(false);
    });
    it('recognizes the inspected ArkTS JSON alias signature without a namespace fallback', () => {
        const model = new SdkSignatureSummary();
        const key = '@ohosSdk/api/@ohos.util.json.d.ts: json.%dflt.parse(string, @ohosSdk/api/@ohos.util.json.d.ts: json.%dflt.[static]%dflt()#Transformer, @ohosSdk/api/@ohos.util.json.d.ts: json.ParseOptions)';
        const statement = (text: string) => ({ getInvokeExpr: () => ({ getMethodSignature: () => ({ toString: () => text }) }) });
        expect(model.matches(statement(key) as never)).toBe(true);
        expect(model.matches(statement(key.replaceAll('@ohosSdk/', '@business/')) as never)).toBe(false);
    });
});
