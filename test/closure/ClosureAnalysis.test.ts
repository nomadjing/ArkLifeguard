import { beforeAll, describe, expect, it } from 'vitest';
import type { Scene } from '../../src/adapter/arkanalyzer';
import { ClosureRunner, resolveRegistrationRules } from '../../src/analysis/closure';
import { MemoryRunner } from '../../src/analysis/memory';
import type { HeapFlowOptions } from '../../src/analysis/shared/HeapFlow';
import { buildResourceScene, fixturePath } from '../helpers/buildScene';

describe('independent registration and closure retention analysis', () => {
    let scene: Scene;
    let options: HeapFlowOptions;
    beforeAll(() => {
        scene = buildResourceScene('retention', fixturePath('resource', 'platform-sdk'));
        options = { lifetimes: scene.getClasses().flatMap(cls => {
            const end = cls.getMethods().find(method => method.getName() === 'onDestroy');
            return end ? [{ classSignature: cls.getSignature().toString(), endMethodSignatures: [end.getSignature().toString()] }] : [];
        }) };
    });
    const entry = (name: string) => {
        const method = scene.getMethods().find(method => method.getDeclaringArkClass().getName() === 'Cases' && method.getName() === `${name}Case`);
        if (!method) throw new Error(`Missing ${name}`);
        return method;
    };
    const run = (name: string) => new ClosureRunner(scene, undefined, options).runWithDummyMain(entry(name));

    it('resolves exact SDK event and timer APIs without user on/off name matching', () => {
        const rules = resolveRegistrationRules(scene);
        expect(rules.rules.map(rule => rule.id)).toEqual(expect.arrayContaining(['EmitterRegistration', 'EventHubRegistration', 'IntervalRegistration']));
        expect(rules.unresolvedRuleIds).toContain('WindowRegistration');
    });
    it.each(['EventLeak', 'WrongEvent', 'WrongCallback', 'IntervalLeak', 'WrongRegistrar', 'BoundIdentity', 'CapturedCellRetained', 'CapturedBuffer', 'WrongTimer'])(
        'reports a strong registrar -> callback -> ended owner chain for %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.closureRetentionLeaks).toHaveLength(1);
            expect(result.registrationLeaks).toEqual([]);
            const diagnostic = result.closureRetentionLeaks[0];
            expect(diagnostic.retentionPath.length).toBeGreaterThanOrEqual(2);
            expect(diagnostic.lifecycleEnd.line).toBeGreaterThan(0);
            expect(diagnostic.callbacks).toHaveLength(1);
            if (diagnostic.ruleId === 'IntervalRegistration') expect(diagnostic.timerId).toMatch(/^timer:/);
        });
    it.each(['EventRelease', 'OffAll', 'IntervalRelease', 'HelperRegistration', 'MethodIdentity'])(
        'honors exact cancellation and aliases across lifecycle calls for %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.registrationLeaks).toEqual([]);
            expect(result.closureRetentionLeaks).toEqual([]);
        });
    it.each(['NoCapture', 'CapturedCellCleared', 'LocalRegistrar', 'DynamicThis'])(
        'does not call an unremoved registration a proven closure retention for %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.registrationLeaks).toHaveLength(1);
            expect(result.closureRetentionLeaks).toEqual([]);
        });
    it('does not execute Promise cleanup merely because its callback is registered', () => {
        const result = run('CallbackCleanup');
        expect(result.success, result.error).toBe(true);
        expect(result.closureRetentionLeaks).toHaveLength(1);
        expect(result.closureRetentionLeaks[0].confidence).toBe('low');
    });
    it('requires an observed lifecycle boundary, not an arbitrary method return', () => {
        const result = run('NoLifecycleEnd');
        expect(result.closureRetentionLeaks).toEqual([]);
        expect(result.registrationLeaks).toEqual([]);
    });
    it('keeps listener retention related to memory without counting it twice', () => {
        const result = new MemoryRunner(scene, options).runWithDummyMain(entry('EventLeak'));
        expect(result.success, result.error).toBe(true);
        expect(result.memoryRetentionCandidates).toEqual([]);
        expect(result.registrationRetentions).toHaveLength(1);
    });
    it('reports budget failure instead of an apparently clean result', () => {
        const result = new ClosureRunner(scene, undefined, { ...options, maxStates: 1 }).runWithDummyMain(entry('EventLeak'));
        expect(result.success).toBe(false);
        expect(result.limitations).toContain('state-budget-exceeded');
    });
    it.each(['OnceListener', 'TimeoutListener'])('downgrades pending self-expiring callbacks for %s', name => {
        const result = run(name);
        expect(result.success, result.error).toBe(true);
        expect(result.closureRetentionLeaks).toHaveLength(1);
        expect(result.closureRetentionLeaks[0]).toMatchObject({ confidence: 'low', reason: 'unknown-registration' });
    });
    it('reports cleanup on only some lifecycle paths', () => {
        expect(run('PartialOff').closureRetentionLeaks[0]).toMatchObject({ reason: 'partially-unregistered', confidence: 'low' });
    });
    it('preserves registrations on exceptional cleanup paths', () => {
        const result = run('ThrowingCleanup');
        expect(result.success, result.error).toBe(true);
        expect(result.closureRetentionLeaks).toHaveLength(1);
        expect(result.closureRetentionLeaks[0].confidence).toBe('low');
    });
    it('finds the path through each registration when callbacks retain the same owner', () => {
        expect(run('TwoListeners').closureRetentionLeaks).toHaveLength(2);
    });
    it('rejects invalid rules independently', () => {
        const result = new ClosureRunner(scene, [], options).runWithDummyMain(entry('EventLeak'));
        expect(result.success).toBe(false);
        expect(result.error).toContain('No configured');
    });
    it('does not turn an unrelated static root into callback retention when callback identity is unknown', () => {
        const result = run('UnknownCallback');
        expect(result.success, result.error).toBe(true);
        expect(result.closureRetentionLeaks).toEqual([]);
        expect(result.registrationLeaks).toHaveLength(1);
        expect(result.registrationLeaks[0]).toMatchObject({ confidence: 'low', reason: 'unknown-registration' });
    });
});
