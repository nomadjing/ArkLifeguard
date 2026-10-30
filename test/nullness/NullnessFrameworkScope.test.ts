import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Scene, SceneConfig } from '../../src/adapter/arkanalyzer';
import { NullnessAnalysisRunner } from '../../src/analysis/nullness';

describe('framework-dependent diagnostic scope', () => {
    it('filters component initialization assumptions while retaining local and explicit-write defects', () => {
        const config = new SceneConfig();
        config.buildConfig('framework-scope', path.resolve(__dirname, '../fixtures/nullness/framework-scope'), [
            { name: '', moduleName: '', path: path.resolve(__dirname, '../fixtures/sdk') },
        ]);
        const scene = new Scene(); scene.buildSceneFromProjectDir(config); scene.inferTypes();
        const result = new NullnessAnalysisRunner(scene).runFromDummyMain();
        expect(result.success, result.error).toBe(true);
        const sinks = result.diagnostics.map(d => d.dereferenceStmt.getOriginalText() ?? '');
        expect(result.diagnostics.some(d => d.sourceStmt.getCfg()?.getDeclaringMethod().getName() === '%instInit')).toBe(false);
        expect(sinks.some(text => text.includes('local!.touch()'))).toBe(true);
        expect(sinks.some(text => text.includes('callbackLocal!.touch()'))).toBe(true);
        expect(sinks.some(text => text.includes('this.account!.touch()'))).toBe(true);
    });
});
