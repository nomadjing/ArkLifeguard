import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Scene, SceneConfig } from '../../src/adapter/arkanalyzer';
import { NullnessAnalysisRunner } from '../../src/analysis/nullness';

describe('inherited field writes', () => {
    it('kills inherited nullness after subclass initialization and retains missing initialization', () => {
        const config = new SceneConfig();
        config.buildConfig('inherited-field-write', path.resolve(__dirname, '../fixtures/nullness/inherited-field-write'), [
            { name: '', moduleName: '', path: path.resolve(__dirname, '../fixtures/sdk') },
        ]);
        const scene = new Scene();
        scene.buildSceneFromProjectDir(config);
        scene.inferTypes();
        const result = new NullnessAnalysisRunner(scene).runFromDummyMain();
        expect(result.success, result.error).toBe(true);
        const owners = result.diagnostics.map(d => d.dereferenceStmt.getCfg()?.getDeclaringMethod().getDeclaringArkClass().getName());
        expect(owners).not.toContain('SafeBase');
        expect(owners).toContain('UnsafeBase');
    });
});
