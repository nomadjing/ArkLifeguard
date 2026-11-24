import { beforeAll, describe, expect, it } from 'vitest';
import type { Scene } from '../../src/adapter/arkanalyzer';
import { ResourceRunner, resolveHarmonyResourceRules } from '../../src/analysis/resourceleak';
import { HARMONY_RESOURCE_DEFINITIONS } from '../../src/analysis/resourceleak/rules/HarmonyResourceRules';
import type { ResourceRule } from '../../src/analysis/resourceleak/rules/ResourceRule';
import { buildResourceScene, fixturePath } from '../helpers/buildScene';

describe('HarmonyOS SDK resource rules', () => {
    let scene: Scene;
    beforeAll(() => {
        scene = buildResourceScene('platform', fixturePath('resource', 'platform-sdk'));
    });
    const run = (name: string, rules?: readonly ResourceRule[]) => {
        const method = scene.getMethods().find(method =>
            method.getDeclaringArkClass().getName() === 'PlatformCases' && method.getName() === name);
        if (!method) throw new Error(`Missing fixture ${name}`);
        return new ResourceRunner(scene, rules, true).runWithDummyMain(method);
    };

    it('resolves all ten resource families against SDK declarations', () => {
        const resolved = resolveHarmonyResourceRules(scene);
        expect(resolved.unresolvedRuleIds).toEqual([]);
        expect(resolved.rules).toHaveLength(10);
    });

    it('keeps asynchronous factory acquisition contexts through a shared owner return', () => {
        const leaking = run('playerFactoryPairLeak');
        expect(leaking.status).toBe('success');
        expect(leaking.diagnostics).toMatchObject([{
            ruleId: 'AVPlayerNotReleased', reason: 'unreleased',
        }]);
        expect(leaking.diagnostics).toHaveLength(1);
        const released = run('playerFactoryPairRelease');
        expect(released.status).toBe('success');
        expect(released.diagnostics).toEqual([]);
    });

    it.each([
        ['http', 'HttpRequestNotDestroyed'], ['file', 'FileNotClosed'],
        ['fileio', 'FileIONotClosed'], ['source', 'ImageSourceNotReleased'],
        ['pixel', 'PixelMapNotReleased'], ['packer', 'ImagePackerNotReleased'],
        ['player', 'AVPlayerNotReleased'], ['renderer', 'AudioRendererNotReleased'],
        ['capturer', 'AudioCapturerNotReleased'], ['result', 'ResultSetNotClosed'],
    ])('detects a missing release and accepts the matching release for %s', (name, ruleId) => {
        const leaking = run(`${name}Leak`);
        expect(leaking.status).toBe('success');
        expect(leaking.diagnostics).toMatchObject([{ ruleId, reason: 'unreleased' }]);
        expect(leaking.diagnostics).toHaveLength(1);
        expect(run(`${name}Release`).diagnostics).toEqual([]);
    });

    it('pairs only the correct file handle, including fd aliases', () => {
        expect(run('fileDescriptorAlias').diagnostics).toEqual([]);
        expect(run('fileWrongObject').diagnostics).toMatchObject([{ ruleId: 'FileNotClosed' }]);
        expect(run('fileWrongObject').diagnostics).toHaveLength(1);
    });

    it.each(['fileReleaseFailureCaught', 'fileReleaseFailureAwait', 'fileReleaseFailureFromHelper',
        'fileReleaseFailureFromMiddle', 'fileFailedReplacementKeepsHandle'])
    ('discharges cleanup duty when the matching release throws: %s', name => {
        const result = run(name);
        expect(result.status).toBe('success');
        expect(result.diagnostics).toEqual([]);
    });

    it.each(['fileWrapperFailsBeforeClose', 'fileMiddleFailsBeforeClose', 'fileUnreachableClose'])
    ('retains obligations for resources whose release was not called: %s', name => {
        const result = run(name);
        expect(result.status).toBe('success');
        expect(result.diagnostics).toHaveLength(1);
    });

    it.each(['fileDescriptorZeroLeak', 'fileDescriptorTruthyLeak', 'fileConditionalRelease', 'fileioZeroLeak'])
    ('reports conditional cleanup as partially released: %s', name => {
        const result = run(name);
        expect(result.status).toBe('success');
        expect(result.diagnostics).toMatchObject([{ reason: 'partially-released' }]);
    });

    it.each(['fileCalleeAllocationFailsBeforeClose', 'fileFactoryWorkCaller', 'fileWorkFailsBeforeClose', 'fileEarlyReturn'])
    ('reports a local exit that bypasses cleanup: %s', name => {
        expect(run(name).diagnostics).toMatchObject([{
            ruleId: 'FileNotClosed', reason: 'unreleased',
        }]);
    });

    it('keeps each outstanding file when a later open or a sibling close fails', () => {
        const diagnostics = run('fileReleaseFailureSkipsOther').diagnostics;
        expect(diagnostics).toHaveLength(2);
        expect(new Set(diagnostics.map(item => item.allocation.line)).size).toBe(2);
    });

    it.each(['fileWorkCleanedInFinally', 'fileReturnAwaitCleanedInFinally', 'fileLoopEntryCleanedInFinally'])
    ('honors finally cleanup when an SDK call can fail: %s', name => {
        const result = run(name);
        expect(result.status).toBe('success');
        expect(result.diagnostics).toEqual([]);
    });

    it('recognizes terminal state only on the resource being checked', () => {
        expect(run('playerReleasedGuard').diagnostics).toEqual([]);
        expect(run('resultClosedGuard').diagnostics).toEqual([]);
        expect(run('resultOtherGuard').diagnostics).toMatchObject([{ ruleId: 'ResultSetNotClosed' }]);
    });

    it('adds an SDK method predicate through the rule definition alone', () => {
        const definitions = HARMONY_RESOURCE_DEFINITIONS.map(definition => definition.id !== 'ResultSetNotClosed'
            ? definition
            : {
                ...definition,
                releasedWhen: [...(definition.releasedWhen ?? []), {
                    method: { module: '@ohos.data.relationalStore', owner: 'ResultSet', methods: ['isOpen'] },
                    equals: false,
                }],
            });
        const { rules } = resolveHarmonyResourceRules(scene, definitions);
        expect(run('resultMethodGuard').diagnostics).toMatchObject([{ ruleId: 'ResultSetNotClosed' }]);
        expect(run('resultMethodGuard', rules).diagnostics).toEqual([]);
        expect(run('resultClosedGuard', rules).diagnostics).toEqual([]);
        expect(run('resultOtherMethodGuard', rules).diagnostics).toMatchObject([{ ruleId: 'ResultSetNotClosed' }]);
    });

    it('passes a fulfilled await argument to its consumer', () => {
        expect(run('resultAwaitArgRelease').diagnostics).toEqual([]);
        expect(run('resultAwaitArgLeak').diagnostics).toMatchObject([{ ruleId: 'ResultSetNotClosed' }]);
    });

    it('passes a resource returned by an async factory to its fulfillment callback', () => {
        expect(run('resultFactoryThenClose').diagnostics).toEqual([]);
        expect(run('resultFactoryThenLeak').diagnostics).toMatchObject([{ ruleId: 'ResultSetNotClosed' }]);
        expect(run('resultFactoryCatchGuard').diagnostics).toEqual([]);
    });

    it('maps Promise fulfillment and captured handles without releasing other resources', () => {
        expect(run('resultThenRelease').diagnostics).toEqual([]);
        expect(run('fileCallbackRelease').diagnostics).toEqual([]);
        for (const name of ['resultThenLeak', 'resultThenWrongObject', 'resultCatchWrongObject', 'fileCallbackWrongObject']) {
            const result = run(name);
            expect(result.status, name).toBe('success');
            expect(result.diagnostics, name).toHaveLength(1);
        }
    });

    it.each(['fileGuardedDescriptor', 'fileGuardedDescriptorReturn', 'fileGuardedDescriptorThrow',
        'fileInvalidDescriptorReturn', 'fileGuardedObject', 'fileGuardedTruthyObject',
        'fileGuardedAwait', 'sourceGuardedObject', 'fileioGuardedDescriptor'])
    ('prunes invalid-handle paths after successful acquisition: %s', name => {
        const result = run(name);
        expect(result.status).toBe('success');
        expect(result.diagnostics).toEqual([]);
    });

    it.each(['fileDescriptorOverwritten', 'fileGuardedOtherObject'])
    ('retains feasible missing cleanup: %s', name => {
        const result = run(name);
        expect(result.status).toBe('success');
        expect(result.diagnostics).toHaveLength(1);
    });

    it('reports uncertain conditional cleanup without a handle-validity contract', () => {
        const method = scene.getMethods().find(method =>
            method.getDeclaringArkClass().getName() === 'PlatformCases' &&
            method.getName() === 'fileGuardedDescriptor');
        const rules = resolveHarmonyResourceRules(scene).rules.map(rule => ({ ...rule, handleValidity: undefined }));
        expect(new ResourceRunner(scene, rules).runWithDummyMain(method!).diagnostics).toMatchObject([
            { reason: 'partially-released' },
        ]);
    });

    it('propagates fulfilled handles without calling the Promise itself a resource', () => {
        expect(run('fileAwaitRelease').diagnostics).toEqual([]);
        expect(run('pixelAwaitRelease').diagnostics).toEqual([]);
        expect(run('pendingPlayer').diagnostics).toMatchObject([{
            reason: 'unknown-ownership',
        }]);
        expect(run('callbackPlayer').diagnostics).toMatchObject([{
            reason: 'unknown-ownership',
        }]);
    });

    it('excludes user APIs with the same names and reports coverage separately from leaks', () => {
        const result = run('userApi');
        expect(result.diagnostics).toEqual([]);
        expect(result.solverStatistics?.processedEdges).toBeGreaterThan(0);
        const http = result.coverage?.find(item => item.ruleId === 'HttpRequestNotDestroyed');
        expect(http?.allocatorCalls).toBe(2);
        expect(http?.reachedAllocatorCalls).toBe(0);
    });
});
