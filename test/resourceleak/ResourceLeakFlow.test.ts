import { beforeAll, describe, expect, it } from 'vitest';
import type { ArkMethod, Scene } from '../../src/adapter/arkanalyzer';
import { ResourceRunner } from '../../src/analysis/resourceleak';
import { resourceValueKey } from '../../src/analysis/resourceleak/ResourceFact';
import type { ResourceRule } from '../../src/analysis/resourceleak';
import { createLifecycleModelCreator } from '../../src/lifecycle';
import { buildResourceScene } from '../helpers/buildScene';

describe('new resource-leak IFDS flow', () => {
    let scene: Scene;
    let rules: ResourceRule[];

    const method = (name: string): ArkMethod => {
        const found = scene.getMethods().find(candidate =>
            candidate.getSignature().getMethodSubSignature().getMethodName() === name &&
            candidate.getDeclaringArkClass().getName() === 'FlowCases');
        if (!found) throw new Error(`missing method ${name}`);
        return found;
    };

    const signature = (className: string, methodName: string): string => {
        for (const owner of scene.getMethods()) {
            for (const stmt of owner.getCfg()?.getStmts() ?? []) {
                const candidate = stmt.getInvokeExpr()?.getMethodSignature();
                if (candidate?.getDeclaringClassSignature().getClassName() === className &&
                    candidate.getMethodSubSignature().getMethodName() === methodName) {
                    return candidate.toString();
                }
            }
        }
        const declared = scene.getMethods().find(candidate =>
            candidate.getDeclaringArkClass().getName() === className &&
            candidate.getSignature().getMethodSubSignature().getMethodName() === methodName);
        if (declared) return declared.getSignature().toString();
        throw new Error(`missing API ${className}.${methodName}`);
    };

    const run = (name: string) => new ResourceRunner(scene, rules).runWithDummyMain(method(name));

    beforeAll(() => {
        scene = buildResourceScene('flow');
        rules = [
            {
                id: 'HandleNotReleased', scope: 'resource',
                allocators: [{ methodSignature: signature('Handle', 'open'),
                    handleLocation: { kind: 'return' } }],
                releasers: [{ methodSignature: signature('Handle', 'release'),
                    handleLocation: { kind: 'base' } }],
            },
            {
                id: 'OtherNotClosed', scope: 'resource',
                allocators: [{ methodSignature: signature('Other', 'open'),
                    handleLocation: { kind: 'return' } }],
                releasers: [{ methodSignature: signature('Other', 'close'),
                    handleLocation: { kind: 'param', index: 0 } }],
            },
            {
                id: 'TokenNotNullified', scope: 'compatibility',
                allocators: [{ methodSignature: signature('Token', 'subscribe'),
                    handleLocation: { kind: 'return' } }],
                releasers: [], releaseByNullify: true,
            },
        ];
    });

    it('reports an unreleased allocation with an exit location', () => {
        const result = run('leak');
        expect(result.status).toBe('success');
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toMatchObject({
            ruleId: 'HandleNotReleased', reason: 'unreleased', confidence: 'high',
        });
        expect(result.diagnostics[0].allocation.line).toBeGreaterThan(0);
        expect(result.diagnostics[0].boundary.line).toBeGreaterThan(0);
    });

    it('releases an alias and a value passed through a direct call', () => {
        expect(run('releaseAlias').diagnostics).toEqual([]);
        expect(run('releaseInCallee').diagnostics).toEqual([]);
    });

    it('maps a returned resource back to its caller', () => {
        expect(run('releaseFactoryResult').diagnostics).toEqual([]);
    });

    it('does not release an old allocation through a replaced call-result handle', () => {
        const result = run('overwriteByReturn');
        expect(result.status).toBe('success');
        expect(result.diagnostics).toMatchObject([{ reason: 'overwritten', confidence: 'high' }]);
        expect(result.diagnostics).toHaveLength(1);
        expect(run('preserveReturnedAlias').diagnostics).toEqual([]);
        expect(run('preserveOtherAlias').diagnostics).toEqual([]);
    });

    it('retains the leaking return branch when another branch returns the old resource', () => {
        const result = run('conditionalReturnedAlias');
        expect(result.status).toBe('success');
        expect(result.diagnostics).toMatchObject([{ reason: 'partially-released' }]);
        expect(result.diagnostics).toHaveLength(1);
    });

    it('does not transfer a callee parameter reassignment to the caller local', () => {
        const result = run('parameterAssignmentIsLocal');
        expect(result.status).toBe('success');
        expect(result.diagnostics).toHaveLength(1);
        const allocationLine = method('reassignParameter').getCfg()!.getStmts()
            .find(stmt => stmt.getInvokeExpr()?.getMethodSignature().getMethodSubSignature()
                .getMethodName() === 'open')!.getOriginPositionInfo().getLineNo();
        expect(result.diagnostics[0]).toMatchObject({
            allocation: { line: allocationLine }, reason: 'unreleased',
        });
    });

    it('distinguishes wrong release, overwrite and partial release', () => {
        expect(run('wrongRelease').diagnostics.map(item => item.reason)).toEqual(['wrong-release']);
        expect(run('overwritten').diagnostics.map(item => item.reason)).toEqual(['overwritten']);
        expect(run('partial').diagnostics.map(item => item.reason)).toEqual(['partially-released']);
    });

    it('keeps two allocation sites separate', () => {
        const result = run('oneOfTwo');
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0].reason).toBe('unreleased');
    });

    it('keeps same-named locals in different method scopes distinct', () => {
        const first = method('releaseAlias').getBody()?.getLocals().get('handle');
        const second = method('wrongRelease').getBody()?.getLocals().get('handle');
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        expect(resourceValueKey(first!)).not.toBe(resourceValueKey(second!));
    });

    it('carries a receiver field through a second method', () => {
        expect(run('releaseAcrossMethods').diagnostics).toEqual([]);
        expect(run('leakAcrossMethods').diagnostics.map(item => item.reason))
            .toEqual(['unreleased']);
    });

    it('rebases an owner field onto a parameter without conflating owners', () => {
        const released = run('releaseThroughOwnerParameter');
        expect(released.status).toBe('success');
        expect(released.diagnostics).toEqual([]);
        const leaking = run('releaseDifferentOwner');
        expect(leaking.status).toBe('success');
        expect(leaking.diagnostics).toMatchObject([{ reason: 'unreleased' }]);
        expect(leaking.diagnostics).toHaveLength(1);
    });

    it('preserves multiple contracts for one full API signature', () => {
        const shared = { ...rules[0], id: 'SharedHandleContract' };
        const analyze = (name: string) => new ResourceRunner(scene, [rules[0], shared])
            .runWithDummyMain(method(name));
        const leaking = analyze('leak');
        expect(leaking.status).toBe('success');
        expect(leaking.diagnostics.map(item => item.ruleId).sort())
            .toEqual(['HandleNotReleased', 'SharedHandleContract']);
        expect(analyze('releaseAlias').diagnostics).toEqual([]);
    });

    it('keeps unknown ownership uncertain and honors explicit nullification rules', () => {
        expect(run('unknownOwnership').diagnostics).toMatchObject([{
            reason: 'unknown-ownership', confidence: 'low',
        }]);
        expect(run('nullify').diagnostics).toEqual([]);
        expect(run('returnToCaller').diagnostics).toEqual([]);
        expect(run('storeInContainer').diagnostics).toMatchObject([{
            reason: 'unknown-ownership', confidence: 'low',
        }]);
    });

    it('keeps optional callback release uncertain', () => {
        expect(run('optionalCallbackRelease').diagnostics).toMatchObject([{
            reason: 'unknown-ownership', confidence: 'low',
        }]);
        expect(run('promiseCallbackRelease').diagnostics).toMatchObject([{
            reason: 'unknown-ownership', confidence: 'low',
        }]);
        expect(run('releaseThenCallback').diagnostics).toEqual([]);
    });

    it('rejects duplicate rule identities before solving', () => {
        const result = new ResourceRunner(scene, [rules[0], rules[0]])
            .runWithDummyMain(method('leak'));
        expect(result.status).toBe('failed');
        expect(result.error).toContain('重复');
        expect(result.diagnostics).toEqual([]);
    });

    it('keeps an Ability field alive from onCreate to onDestroy', () => {
        const lifecycleScene = buildResourceScene('lifecycle-release');
        const creator = createLifecycleModelCreator(lifecycleScene, 'flat');
        creator.create();
        const find = (name: string) => {
            for (const owner of lifecycleScene.getMethods()) {
                for (const stmt of owner.getCfg()?.getStmts() ?? []) {
                    const invoked = stmt.getInvokeExpr()?.getMethodSignature();
                    if (invoked?.getDeclaringClassSignature().getClassName() === 'Handle' &&
                        invoked.getMethodSubSignature().getMethodName() === name) {
                        return invoked.toString();
                    }
                }
            }
            throw new Error(`missing Handle.${name}`);
        };
        const result = new ResourceRunner(lifecycleScene, [{
            id: 'HandleNotReleased', scope: 'resource',
            allocators: [{ methodSignature: find('open'), handleLocation: { kind: 'return' } }],
            releasers: [{ methodSignature: find('release'), handleLocation: { kind: 'base' } }],
        }]).runWithDummyMain(creator.getDummyMain());
        expect(result.status).toBe('success');
        expect(result.diagnostics).toEqual([]);

        const leakScene = buildResourceScene('lifecycle-leak');
        const leakCreator = createLifecycleModelCreator(leakScene, 'flat');
        leakCreator.create();
        const leakAllocator = leakScene.getMethods()
            .flatMap(owner => owner.getCfg()?.getStmts() ?? [])
            .map(stmt => stmt.getInvokeExpr()?.getMethodSignature())
            .find(signature => signature?.getDeclaringClassSignature().getClassName() === 'Handle' &&
                signature.getMethodSubSignature().getMethodName() === 'open');
        const leakReleaser = leakScene.getMethods().find(owner =>
            owner.getDeclaringArkClass().getName() === 'Handle' &&
            owner.getSignature().getMethodSubSignature().getMethodName() === 'release');
        if (!leakAllocator || !leakReleaser) throw new Error('missing lifecycle rule API');
        const leakResult = new ResourceRunner(leakScene, [{
            id: 'HandleNotReleased', scope: 'resource',
            allocators: [{ methodSignature: leakAllocator.toString(),
                handleLocation: { kind: 'return' } }],
            releasers: [{ methodSignature: leakReleaser.getSignature().toString(),
                handleLocation: { kind: 'base' } }],
        }]).runWithDummyMain(leakCreator.getDummyMain());
        expect(leakResult.status).toBe('success');
        expect(leakResult.diagnostics).toMatchObject([{
            ruleId: 'HandleNotReleased', reason: 'unreleased',
        }]);
    });
});
