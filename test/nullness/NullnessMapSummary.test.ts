import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Sdk } from '../../src/adapter/arkanalyzer';
import { Scene, SceneConfig } from '../../src/adapter/arkanalyzer';
import { NullnessAnalysisRunner } from '../../src/analysis/nullness';
import { NullnessProblem, NullnessSolver, NullnessLibraryRegistry } from '../../src/analysis/nullness';

const sdk: Sdk = {
    name: '',
    path: path.join(__dirname, '../fixtures/sdk'),
    moduleName: '',
};

function buildScene(): Scene {
    const projectPath = path.join(__dirname, '../fixtures/nullness/map-summary-precision');
    const config = new SceneConfig();
    config.buildConfig(projectPath, projectPath, [sdk]);
    const scene = new Scene();
    scene.buildSceneFromProjectDir(config);
    scene.inferTypes();
    return scene;
}

describe('Nullness Map summary', () => {
    it('models exact Map.get signatures without assuming key presence implies a non-null value', () => {
        const result = new NullnessAnalysisRunner(buildScene()).runFromDummyMain();

        expect(result.success, result.error).toBe(true);
        const dereferences = result.diagnostics.map(diagnostic =>
            diagnostic.dereferenceStmt.getOriginalText()
        );
        expect(dereferences.some(text => text?.includes("missingAccounts.get('missing')"))).toBe(true);
        expect(dereferences.some(text => text?.includes("knownAccounts.get('known')"))).toBe(true);
        expect(dereferences.some(text => text?.includes("guardedAccounts.get('known')"))).toBe(true);
        expect(dereferences.some(text => text?.includes("repository.get('known')"))).toBe(false);
        expect(result.diagnostics).toHaveLength(3);
        expect(result.diagnostics[0].nullness).toBe('maybe-undefined');
    });

    it.each(['guardedNonNull', 'guardedAlias', 'guardedNullable'])('keeps protected reads safe: %s', name => {
        expect(analyze(name)).toHaveLength(0);
    });
    it.each(['storedNull', 'unknownValues', 'anyValues', 'genericValues', 'castReceiver', 'rawMap'])(
        'retains nullable or uncertain values: %s', name => {
            expect(analyze(name).some(d => d.nullness === 'maybe-nullish' || d.nullness === 'maybe-null')).toBe(true);
        });
});

function analyze(name: string) {
    const scene = buildScene();
    const method = scene.getMethods().find(m => m.getName() === name)!;
    const problem = new NullnessProblem(method.getCfg()!.getStartingStmt(), method, {},
        NullnessLibraryRegistry.createDefault(scene));
    new NullnessSolver(problem, scene).solve();
    return problem.getNullDereferences();
}
