import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Scene, SceneConfig } from '../../src/adapter/arkanalyzer';
import { NullnessAnalysisRunner } from '../../src/analysis/nullness';
import { NullnessLibraryRegistry } from '../../src/analysis/nullness';
import { NullnessSourceSemantics } from '../../src/analysis/nullness/NullnessSourceSemantics';

describe('nullness supplemental root admission', () => {
    it('collects callbacks only from reached call sites', () => {
        const projectPath = path.resolve(
            __dirname,
            '../fixtures/nullness/callback-root-admission'
        );
        const config = new SceneConfig();
        config.buildConfig('callback-root-admission', projectPath, []);
        const scene = new Scene();
        scene.buildSceneFromProjectDir(config);
        scene.inferTypes();

        const active = scene.getMethods().find(method =>
            method.getSignature().toString().includes('activeRegistration'))!;
        const clean = scene.getMethods().find(method =>
            method.getSignature().toString().includes('cleanRegistration'))!;
        const runner = new NullnessAnalysisRunner(scene);
        const roots = runner['getCallbackBodyRoots'](
            [
                ...active.getCfg()!.getStmts(),
                ...clean.getCfg()!.getStmts(),
            ],
            NullnessLibraryRegistry.createDefault(scene),
            new NullnessSourceSemantics()
        );
        const signatures = [...roots].map(method =>
            method.getSignature().toString()
        );

        expect(signatures).toHaveLength(1);
        expect(signatures[0]).toContain('activeRegistration');
        expect(signatures.some(signature =>
            signature.includes('inactiveRegistration')
        )).toBe(false);
    });
});
