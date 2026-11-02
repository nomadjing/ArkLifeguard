import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ArkStaticInvokeExpr, Scene, SceneConfig, type Stmt } from '../../src/adapter/arkanalyzer';
import { createArkUiSynchronousCallbackModel } from '../../src/analysis/callgraph/ArkUiSynchronousCallbacks';
import { createNullnessInterproceduralCFG } from '../../src/analysis/nullness/NullnessCallGraph';

describe('verified ArkUI synchronous callbacks', () => {
    let scene: Scene;
    let ownerBuild: Stmt;
    let contentCalls: Stmt[];
    let plainCall: Stmt;

    beforeAll(() => {
        const projectPath = path.resolve(__dirname, '../fixtures/nullness/arkui-synchronous-callback');
        const config = new SceneConfig();
        config.buildConfig('arkui-synchronous-callback', projectPath, []);
        scene = new Scene();
        scene.buildSceneFromProjectDir(config);
        scene.inferTypes();

        const owner = scene.getMethods().find(method =>
            method.getSignature().toString().includes('Owner.build()'))!;
        const viewCalls = owner.getCfg()!.getStmts().filter(statement =>
            statement.getInvokeExpr() instanceof ArkStaticInvokeExpr &&
            statement.getInvokeExpr()!.getMethodSignature().toString() === '@%unk/%unk: View.create()');
        contentCalls = viewCalls.filter(call => call.getInvokeExpr()!.getArgs().length === 2);
        plainCall = viewCalls.find(call => call.getInvokeExpr()!.getArgs().length === 1)!;
        ownerBuild = owner.getCfg()!.getStartingStmt();
    });

    it('recognizes only the component content callback slot', () => {
        const model = createArkUiSynchronousCallbackModel(scene);

        expect(contentCalls).toHaveLength(1);
        expect([...model(contentCalls[0])]).toEqual([1]);
        expect([...model(plainCall)]).toEqual([]);
    });

    it('uses the verified callback contract in the unified nullness ICFG', () => {
        const icfg = createNullnessInterproceduralCFG(scene);
        icfg.initialize(ownerBuild.getCfg()!.getDeclaringMethod());

        expect(icfg.isCallStatement(contentCalls[0])).toBe(true);
        expect(icfg.isCallStatement(plainCall)).toBe(false);
    });
});
