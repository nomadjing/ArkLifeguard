import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ArkIfStmt, ArkInstanceInvokeExpr, ArkInstanceFieldRef, ArkAssignStmt, Scene, SceneConfig } from '../../src/adapter/arkanalyzer';
import { NullnessProblem } from '../../src/analysis/nullness/NullnessProblem';
import { NullnessSolver } from '../../src/analysis/nullness/NullnessSolver';
import { NullnessSourceSemantics } from '../../src/analysis/nullness/NullnessSourceSemantics';

describe('optional chains lowered to CFG guards', () => {
    let scene: Scene;
    beforeAll(() => {
        const config = new SceneConfig();
        config.buildConfig('optional-chains', path.resolve(__dirname, '../fixtures/nullness/optional-chains'), []);
        scene = new Scene();
        scene.buildSceneFromProjectDir(config);
        scene.inferTypes();
    });
    function analyze(name: string) {
        const method = scene.getMethods().find(m => m.getName() === name)!;
        const problem = new NullnessProblem(method.getCfg()!.getStartingStmt(), method);
        // Prove safety without source access matching or diagnostic suppression.
        const accesses = vi.spyOn(NullnessSourceSemantics.prototype, 'getAccesses').mockReturnValue([]);
        const operands = vi.spyOn(NullnessSourceSemantics.prototype, 'getOperandAccesses').mockReturnValue(null);
        try {
            new NullnessSolver(problem, scene).solve();
            return problem.getNullDereferences();
        } finally { accesses.mockRestore(); operands.mockRestore(); }
    }
    it.each(['continuous', 'multiple', 'indexed', 'invoked', 'optionalFunction', 'optionalMethod', 'aigis', 'evaluatedOnce', 'optionalDelete', 'optionalMatch'])(
        'protects %s without source filtering', name => expect(analyze(name)).toHaveLength(0));
    it.each(['brokenByParentheses', 'nullableChild', 'optionalResult', 'laterDirect', 'assertedReturn', 'guardThenMutation', 'assertedMatch', 'deletedStillUndefined'])(
        'retains unsafe dereferences in %s', name => expect(analyze(name).length).toBeGreaterThan(0));
    it.each(['indexed', 'invoked', 'optionalFunction'])('skips effects on the short-circuit branch in %s', name => {
        const method = scene.getMethods().find(m => m.getName() === name)!;
        const blocks = [...method.getCfg()!.getBlocks()];
        const guard = blocks.find(b => b.getStmts().some(s => s instanceof ArkIfStmt))!;
        const visited = new Set<typeof guard>();
        const pending = [guard.getSuccessors()[1]];
        while (pending.length) {
            const block = pending.pop()!;
            if (visited.has(block)) continue;
            visited.add(block);
            expect(block.getStmts().some(s => /(?:indexEffect|argumentEffect)/.test(s.getInvokeExpr()?.getMethodSignature().getMethodSubSignature().getMethodName() ?? ''))).toBe(false);
            pending.push(...block.getSuccessors());
        }
    });
    it('evaluates a receiver call once, before its guard', () => {
        const method = scene.getMethods().find(m => m.getName() === 'evaluatedOnce')!;
        const stmts = method.getCfg()!.getStmts();
        expect(stmts.filter(s => s.getInvokeExpr()?.getMethodSignature().getMethodSubSignature().getMethodName() === 'receiverEffect')).toHaveLength(1);
    });
    it('captures the method receiver before arguments can reassign it', () => {
        const method = scene.getMethods().find(m => m.getName() === 'capturedMethodReceiver')!;
        const call = method.getCfg()!.getStmts().map(s => s.getInvokeExpr()).find(invoke =>
            invoke?.getMethodSignature().getMethodSubSignature().getMethodName() === 'touch');
        expect(call).toBeInstanceOf(ArkInstanceInvokeExpr);
        expect((call as ArkInstanceInvokeExpr).getBase().getName()).not.toBe('child');
    });
    it('returns true when optional delete short-circuits', () => {
        const method = scene.getMethods().find(m => m.getName() === 'optionalDelete')!;
        expect(method.getCfg()!.getStmts().some(s => s instanceof ArkAssignStmt && s.getRightOp().toString() === 'true')).toBe(true);
    });
    it('emits a nullish guard and separate undefined result branch', () => {
        const method = scene.getMethods().find(m => m.getName() === 'continuous')!;
        const blocks = [...method.getCfg()!.getBlocks()];
        const stmts = blocks.flatMap(b => b.getStmts());
        expect(stmts.filter(s => s instanceof ArkIfStmt)).toHaveLength(1);
        expect(stmts.some(s => s.toString().includes('undefined'))).toBe(true);
        const fieldBlocks = blocks.filter(b => b.getStmts().some(s => s instanceof ArkAssignStmt && s.getRightOp() instanceof ArkInstanceFieldRef));
        expect(fieldBlocks.length).toBeGreaterThan(0);
        expect(blocks.length).toBeGreaterThan(2);
    });
});
