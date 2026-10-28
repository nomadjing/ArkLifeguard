import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ArkReturnStmt, Scene, SceneConfig } from '../../src/adapter/arkanalyzer';
import { NullnessAnalysisRunner } from '../../src/analysis/nullness/NullnessAnalysisRunner';
import { NullnessProblem } from '../../src/analysis/nullness/NullnessProblem';
import { NullnessSolver } from '../../src/analysis/nullness/NullnessSolver';
import { NullnessLibraryRegistry } from '../../src/analysis/nullness/library/NullnessLibraryRegistry';

describe('Nullness call state and static diagnostics', () => {
    let scene: Scene;
    beforeAll(() => {
        const project = path.resolve(__dirname, '../fixtures/nullness/call-state-semantics');
        const config = new SceneConfig();
        config.buildConfig('call-state-semantics', project, [{ name: '', moduleName: '',
            path: path.resolve(__dirname, '../fixtures/sdk') }]);
        config.buildFromProjectDir(project);
        scene = new Scene();
        scene.buildSceneFromProjectDir(config);
        scene.inferTypes();
    });

    function analyze(name: string) {
        const method = scene.getMethods().find(m => m.getName() === name)!;
        const problem = new NullnessProblem(method.getCfg()!.getStartingStmt(), method, {},
            NullnessLibraryRegistry.createDefault(scene));
        const solver = new NullnessSolver(problem, scene);
        solver.solve();
        return { problem, solver };
    }

    it.each(['staticOverwrite', 'staticCallOverwrite', 'staticGuarded', 'staticShortCircuit',
        'staticOptional', 'argumentOverwrite', 'receiverOverwrite', 'aliasOverwrite',
        'callbackReceiverEntry', 'exceptionalReset', 'parameterRebindingSafe'])('does not report safe %s', name => {
        expect(analyze(name).problem.getNullDereferences()).toHaveLength(0);
    });

    it('maps parameter effects to the actual argument without changing other objects', () => {
        const diagnostics = analyze('separateArgumentObjects').problem.getNullDereferences();
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].dereferenceStmt.getOriginalText()).toContain('second.value!.touch()');
    });

    it.each(['trulyNullStatic', 'trulyNullArgument', 'argumentBecomesNull', 'unchangedArgument',
        'unknownArgumentCall', 'parameterRebinding', 'conditionalArgumentUpdate',
        'callbackRealDefect', 'lexicalCallbackUpdate', 'exceptionalClear'])('retains the defect in %s', name => {
        expect(analyze(name).problem.getNullDereferences().length).toBeGreaterThan(0);
    });

    it('returns lexical receiver state without inventing Promise fields', () => {
        const { solver } = analyze('callbackOwner');
        const facts = [...solver.getReachedFacts()].filter(([stmt]) => stmt instanceof ArkReturnStmt &&
            stmt.getCfg()?.getDeclaringMethod().getName() === 'attach').flatMap(([, facts]) => facts);
        expect(facts.some(f => f.accessPath.base?.getName() === 'this' &&
            f.accessPath.fields.some(field => field.getFieldName() === 'value'))).toBe(true);
        expect(facts.some(f => f.accessPath.base?.getName() === 'promise' &&
            f.accessPath.fields.some(field => field.getFieldName() === 'value'))).toBe(false);
    });

    it('propagates actual static writes between lifecycle methods', () => {
        const result = new NullnessAnalysisRunner(scene).runFromDummyMain();
        expect(result.success, result.error).toBe(true);
        expect(result.diagnostics.some(d => d.dereferenceStmt.getOriginalText()?.includes('LifecycleState.session!.close()'))).toBe(true);
    });
});
