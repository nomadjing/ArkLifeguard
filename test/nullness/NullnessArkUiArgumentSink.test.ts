import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Sdk } from '../../src/adapter/arkanalyzer';
import { Scene, SceneConfig } from '../../src/adapter/arkanalyzer';
import { NullnessAnalysisRunner } from '../../src/analysis/nullness';

const sdk: Sdk = {
    name: '',
    path: path.join(__dirname, '../fixtures/sdk'),
    moduleName: '',
};

function buildScene(): Scene {
    const projectPath = path.join(__dirname, '../fixtures/nullness/arkui-argument-sink');
    const config = new SceneConfig();
    config.buildConfig(projectPath, projectPath, [sdk]);
    const scene = new Scene();
    scene.buildSceneFromProjectDir(config);
    scene.inferTypes();
    return scene;
}

describe('Nullness ArkUI collection boundaries', () => {
    it('does not mistake a rejected ForEach input for an internal null dereference', () => {
        const result = new NullnessAnalysisRunner(buildScene()).runFromDummyMain();

        expect(result.success, result.error).toBe(true);
        const diagnostics = result.diagnostics.filter(diagnostic =>
            diagnostic.dereferenceStmt.getOriginalText()?.includes('ForEach(')
        );
        expect(diagnostics).toHaveLength(0);
    });

    it('does not seed callbacks from an uncalled owner without local evidence', () => {
        const result = new NullnessAnalysisRunner(buildScene()).runFromDummyMain();
        expect(result.success, result.error).toBe(true);
        expect(result.solverBreakdown!.supplementalRootCount).toBe(0);
        expect(result.diagnostics.some(diagnostic =>
            diagnostic.dereferenceStmt.getCfg()?.getDeclaringMethod().getName() === 'uncalledCollectionOwner' &&
            diagnostic.dereferenceStmt.getOriginalText()?.includes('account!.touch()'))).toBe(false);
    });
});
