import { beforeAll, describe, expect, it } from 'vitest';
import type { Scene } from '../../src/adapter/arkanalyzer';
import { ListenerRunner, resolveListenerRules, ResourceRunner } from '../../src/analysis/resourceleak';
import { buildResourceScene, fixturePath } from '../helpers/buildScene';

describe('listener registration cleanup obligations without capture analysis', () => {
    let scene: Scene;
    beforeAll(() => { scene = buildResourceScene('retention', fixturePath('resource', 'platform-sdk')); });
    const entry = (name: string) => {
        const method = scene.getMethods().find(method => method.getDeclaringArkClass().getName() === 'Cases' && method.getName() === `${name}Case`);
        if (!method) throw new Error(`Missing ${name}`);
        return method;
    };
    const run = (name: string) => new ListenerRunner(scene, undefined, true).runWithDummyMain(entry(name));
    it('binds exact SDK registration APIs', () => {
        const rules = resolveListenerRules(scene);
        expect(rules.rules.map(rule => rule.id)).toEqual(expect.arrayContaining(['EmitterRegistration', 'EventHubRegistration', 'IntervalRegistration']));
        expect(rules.unresolvedRuleIds).toContain('WindowRegistration');
    });
    it.each(['EventLeak', 'WrongEvent', 'WrongCallback', 'IntervalLeak', 'WrongRegistrar', 'BoundIdentity',
        'WrongTimer', 'NoCapture', 'CapturedCellCleared', 'LocalRegistrar', 'CallbackCleanup'])(
        'reports the missing cleanup without requiring an owner capture: %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0]).not.toHaveProperty('retentionPath');
            expect(result.diagnostics[0]).not.toHaveProperty('capturedObject');
            expect(result.solverStatistics?.processedEdges).toBeGreaterThan(0);
        });
    it.each(['EventRelease', 'OffAll', 'IntervalRelease', 'HelperRegistration', 'MethodIdentity', 'PartialOff', 'AliasListener', 'BoundAlias', 'RemoveAllSameEvent'])(
        'accepts a reachable matching cancellation under the cleanup contract: %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.diagnostics).toEqual([]);
        });
    it.each(['OnceListener', 'TimeoutListener'])(
        'does not require explicit cancellation for a self-expiring rule: %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.diagnostics).toEqual([]);
        });
    it('keeps independent registrations and resource ownership separate', () => {
        expect(run('TwoListeners').diagnostics).toHaveLength(2);
        expect(new ResourceRunner(scene).runWithDummyMain(entry('EventLeak')).diagnostics).toEqual([]);
        expect(run('StaticRetained').diagnostics).toEqual([]);
    });
    it('does not cancel another registration for the same event', () => {
        expect(run('OneRemaining').diagnostics).toHaveLength(1);
    });
    it.each(['UnknownEvent', 'UnknownCallback', 'ReplacedRegistrar'])(
        'preserves uncertain identities as low-confidence candidates: %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0]).toMatchObject({ reason: 'unknown-registration', confidence: 'low' });
        });
    it('does not seed nested registrations from an unexecuted callback body', () => {
        const result = run('NestedCallbackRegistration');
        expect(result.success, result.error).toBe(true);
        expect(result.diagnostics).toHaveLength(1);
        const coverage = result.coverage?.find(rule => rule.ruleId === 'EmitterRegistration');
        expect(coverage?.reachedAllocatorCalls).toBe(1);
    });
    it('fails explicitly for missing or invalid rules', () => {
        expect(new ListenerRunner(scene, []).runWithDummyMain(entry('EventLeak')).success).toBe(false);
        const rule = resolveListenerRules(scene).rules[0];
        expect(new ListenerRunner(scene, [{ ...rule, callbackIndex: -1 }]).runWithDummyMain(entry('EventLeak')).success).toBe(false);
    });
});
