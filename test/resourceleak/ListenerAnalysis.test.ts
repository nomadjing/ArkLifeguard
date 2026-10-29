import { beforeAll, describe, expect, it } from 'vitest';
import type { Scene } from '../../src/adapter/arkanalyzer';
import { ListenerRunner, resolveListenerRules, ResourceRunner } from '../../src/analysis/resourceleak';
import { buildResourceScene, fixturePath } from '../helpers/buildScene';
import { ResourceFact } from '../../src/analysis/resourceleak/ResourceFact';
import { ResourceProblem } from '../../src/analysis/resourceleak/ResourceProblem';

describe('listener registration cleanup obligations without capture analysis', () => {
    let scene: Scene;
    beforeAll(() => { scene = buildResourceScene('retention', fixturePath('resource', 'platform-sdk')); });
    const entry = (name: string) => {
        const method = scene.getMethods().find(method => method.getDeclaringArkClass().getName() === 'Cases' && method.getName() === `${name}Case`);
        if (!method) throw new Error(`Missing ${name}`);
        return method;
    };
    const run = (name: string) => new ListenerRunner(scene, undefined, true).runWithDummyMain(entry(name));
    it('merges unknown-registration witnesses but preserves distinct overwrite evidence', () => {
        const method = entry('TwoListeners');
        const stmts = method.getCfg()!.getStmts();
        const first = ResourceFact.allocate('test', stmts[0]).derive({
            registration: { registrar: 'system', event: 'event', callback: 'callback' },
            state: 'unknown', event: 'unknown-ownership', eventSite: stmts[1],
        });
        const second = first.derive({ eventSite: stmts[2] });
        const problem = new ResourceProblem(stmts[0], method, []);
        expect(problem.factEqual(first, second)).toBe(true);
        expect(problem.factHash(first)).toBe(problem.factHash(second));
        expect(problem.factEqual(first.derive({ event: 'overwritten' }), second.derive({ event: 'overwritten' }))).toBe(false);
    });
    it('binds exact SDK registration APIs', () => {
        const rules = resolveListenerRules(scene);
        expect(rules.rules.map(rule => rule.id)).toEqual(expect.arrayContaining(['EmitterRegistration', 'EventHubRegistration', 'IntervalRegistration']));
        const eventHub = rules.rules.find(rule => rule.id === 'EventHubRegistration')!;
        expect(eventHub.allocators.some(signature => signature.includes('/application/EventHub.d.ts'))).toBe(true);
        expect(eventHub.releasers.some(signature => signature.includes('/application/EventHub.d.ts'))).toBe(true);
        expect(rules.unresolvedRuleIds).toContain('WindowRegistration');
    });
    it('bypasses unrelated opaque helpers without declaring the registration safe', () => {
        const result = run('EventUnrelatedHelper');
        expect(result.success, result.error).toBe(true);
        expect(result.diagnostics).toMatchObject([{ reason: 'unknown-registration', confidence: 'low' }]);
        expect(result.propagationStatistics?.emptyHandleEntries).toBe(0);
        expect(result.propagationStatistics?.skipped).toBeGreaterThan(0);
    });
    it('retains transitive off-all without a callback argument', () => {
        const result = run('EventOffAllHelper');
        expect(result.success, result.error).toBe(true);
        expect(result.diagnostics).toEqual([]);
        expect(result.propagationStatistics?.emptyHandleEntries).toBeGreaterThan(0);
    });
    it('still discovers new registrations in a helper skipped by an existing obligation', () => {
        const result = run('EventNewRegistrationHelper');
        expect(result.success, result.error).toBe(true);
        expect(result.diagnostics).toHaveLength(2);
    });
    it('retains timer cancellation through a token parameter and rejects a different token', () => {
        expect(run('TimerHelper').diagnostics).toEqual([]);
        const wrong = run('WrongTimerHelper');
        expect(wrong.diagnostics).toHaveLength(1);
        expect(wrong.diagnostics[0]).toMatchObject({ reason: 'unknown-registration', confidence: 'low' });
        expect(wrong.propagationStatistics?.emptyHandleEntries).toBe(0);
    });
    it('reuses callee summaries without losing deep calls or mixing caller tokens', () => {
        expect(run('DeepTimerHelper').diagnostics).toEqual([]);
        expect(run('ExceptionalTimerReturn').diagnostics).toEqual([]);
        const two = run('TwoTimerCallers');
        expect(two.success, two.error).toBe(true);
        expect(two.diagnostics).toHaveLength(1);
        expect(run('TwoTimerFactoryCallers').diagnostics).toHaveLength(1);
        expect(run('BothTimerFactoryCallers').diagnostics).toEqual([]);
    });
    it('preserves transitive static-token cleanup and overwrite, and bypasses unrelated fields', () => {
        expect(run('StaticTimerRelease').diagnostics).toEqual([]);
        const overwritten = run('StaticTimerOverwrite');
        // Existing static ownership handling yields UNKNOWN; pruning must not erase it.
        expect(overwritten.diagnostics).toMatchObject([{ reason: 'unknown-registration', confidence: 'low' }]);
        expect(overwritten.propagationStatistics?.entered).toBeGreaterThan(0);
        const unrelated = run('StaticTimerUnrelated');
        expect(unrelated.diagnostics).toMatchObject([{ reason: 'unknown-registration', confidence: 'low' }]);
        expect(unrelated.propagationStatistics?.skipped).toBeGreaterThan(0);
    });
    it('skips unrelated receiver fields and retains transitive instance-token cleanup', () => {
        const result = run('TimerFieldHelper');
        expect(result.success, result.error).toBe(true);
        expect(result.diagnostics).toEqual([]);
        expect(result.propagationStatistics?.skipped).toBeGreaterThan(0);
        expect(result.propagationStatistics?.entered).toBeGreaterThan(0);
    });
    it('skips unrelated bodies while retaining cross-method cleanup', () => {
        const leak = run('EventLeak');
        expect(leak.propagationStatistics?.skipped).toBeGreaterThan(0);
        expect(leak.propagationStatistics?.emptyHandleEntries).toBe(0);
        expect(run('HelperRegistration').diagnostics).toEqual([]);
        expect(run('OffAll').diagnostics).toEqual([]);
    });
    it.each(['EventLeak', 'EventRelease'])('checks an explicit owner boundary: %s', name => {
        const cls = scene.getMethods().find(method => method.getDeclaringArkClass().getName() === name)!.getDeclaringArkClass();
        const result = new ListenerRunner(scene, undefined, true, [{
            classSignature: cls.getSignature().toString(),
            endMethods: cls.getMethods().filter(method => method.getName() === 'onDestroy')
                .map(method => method.getSignature().toString()),
        }]).runWithDummyMain(entry(name));
        expect(result.success, result.error).toBe(true);
        expect(result.diagnostics).toHaveLength(name === 'EventLeak' ? 1 : 0);
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
