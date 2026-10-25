import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sdk } from '../../src/adapter/arkanalyzer';
import { Scene, SceneConfig } from '../../src/adapter/arkanalyzer';
import { NullnessAnalysisRunner } from '../../src/analysis/nullness';
import * as callResolver from '../../src/ifds/CallResolver';
import { NullnessProblem } from '../../src/analysis/nullness/NullnessProblem';
import { NullnessSolver } from '../../src/analysis/nullness/NullnessSolver';

const sdk: Sdk = {
    name: '',
    path: path.join(__dirname, '../fixtures/sdk'),
    moduleName: '',
};

function buildScene(): Scene {
    const projectPath = path.join(__dirname, '../fixtures/nullness/module-initializer');
    const config = new SceneConfig();
    config.buildConfig(projectPath, projectPath, [sdk]);
    const scene = new Scene();
    scene.buildSceneFromProjectDir(config);
    scene.inferTypes();
    return scene;
}

describe('Nullness module initializer roots', () => {
    afterEach(() => vi.restoreAllMocks());

    it('analyzes a nullish source in an imported file default method', () => {
        const result = new NullnessAnalysisRunner(buildScene()).runFromDummyMain();

        expect(result.success, result.error).toBe(true);
        const diagnostics = result.diagnostics.filter(diagnostic =>
            diagnostic.dereferenceLocation.filePath.endsWith('ModuleState.ets') &&
            diagnostic.dereferenceStmt.getOriginalText()?.includes('missingAccount!.refresh()')
        );
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].nullness).toBe('null');
    });

    it('computes recursion once for all roots and refreshes it on the next run', () => {
        const scene = buildScene();
        const findRecursive = vi.spyOn(callResolver, 'findRecursiveMethods');
        const runner = new NullnessAnalysisRunner(scene, { collectSolverStatistics: true });
        const first = runner.runFromDummyMain();
        expect(first.success, first.error).toBe(true);
        expect(first.solverBreakdown!.supplementalRootCount).toBeGreaterThan(0);
        expect(findRecursive).toHaveBeenCalledTimes(1);

        const entry = scene.getMethods().find(method =>
            method.getSignature().toString() === first.entryMethod)!;
        const second = runner.runWithDummyMain(entry);
        expect(second.success, second.error).toBe(true);
        expect(findRecursive).toHaveBeenCalledTimes(2);
        expect(second.solverStatistics?.processedEdges).toBe(first.solverStatistics?.processedEdges);
        expect(second.reachedFacts.size).toBe(first.reachedFacts.size);
        expect(second.diagnostics.map(d => d.dereferenceStmt))
            .toEqual(first.diagnostics.map(d => d.dereferenceStmt));
    });

    it('skips recursion scanning when widening is disabled, including standalone solvers', () => {
        const scene = buildScene();
        const findRecursive = vi.spyOn(callResolver, 'findRecursiveMethods');
        const result = new NullnessAnalysisRunner(scene, {
            problem: { recursiveSccWidening: false },
        }).runFromDummyMain();
        expect(result.success, result.error).toBe(true);
        const entry = scene.getMethods().find(method =>
            method.getSignature().toString() === result.entryMethod)!;
        new NullnessSolver(new NullnessProblem(entry.getCfg()!.getStartingStmt(), entry, {
            recursiveSccWidening: false,
        }), scene);
        expect(findRecursive).not.toHaveBeenCalled();
    });
});
