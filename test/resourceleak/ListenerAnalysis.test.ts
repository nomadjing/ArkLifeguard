import { beforeAll, describe, expect, it } from 'vitest';
import type { Scene } from '../../src/adapter/arkanalyzer';
import { ListenerRunner, resolveListenerRules, ResourceRunner } from '../../src/analysis/resourceleak';
import { buildResourceScene, fixturePath } from '../helpers/buildScene';
import { ResourceFact } from '../../src/analysis/resourceleak/ResourceFact';
import { ResourceProblem } from '../../src/analysis/resourceleak/ResourceProblem';
import { ListenerCleanupSummary } from '../../src/analysis/resourceleak/ListenerCleanupSummary';
import { listenerContracts } from '../../src/analysis/resourceleak/ListenerProblem';
import { ListenerIdentity } from '../../src/analysis/resourceleak/ListenerIdentity';
import { ArkInterproceduralCFG } from '../../src/ifds/icfg/ArkInterproceduralCFG';

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
    it('uses a stable callback identity for a multiply assigned listener field', () => {
        expect(run('StableFieldListener').diagnostics).toEqual([]);
    });
    it('does not release through a listener field reassigned to another callback', () => {
        const result = run('ReplacedFieldListener');
        expect(result.diagnostics).toHaveLength(1);
    });
    it('matches an InnerEvent descriptor with its eventId cancellation', () => {
        expect(run('StaticEventIdentity').diagnostics).toEqual([]);
    });
    it('accepts clearTimeout for an interval token', () => {
        expect(run('CrossTimerClear').diagnostics).toEqual([]);
    });
    it('ignores null clears when resolving a stable callback field', () => {
        expect(run('NullClearedListener').diagnostics).toEqual([]);
    });
    it('resolves top-level event constants across registration and cleanup', () => {
        expect(run('TopLevelEventIdentity').diagnostics).toEqual([]);
    });
    it('summarizes a guarded timer cleanup helper for active tokens', () => {
        expect(run('GuardedTimerMethodSummary').diagnostics).toEqual([]);
    });
    it('requires cleanup on every path that retains a live timer token', () => {
        const icfg = new ArkInterproceduralCFG(scene);
        icfg.initialize(entry('GuardedTimerMethodSummary'));
        const rule = resolveListenerRules(scene).rules.find(item => item.id === 'IntervalRegistration')!;
        const contract = listenerContracts([rule])[0];
        const classFor = (name: string) => scene.getMethods()
            .find(method => method.getDeclaringArkClass().getName() === name)!
            .getDeclaringArkClass();
        const methodFor = (className: string, methodName: string) => classFor(className).getMethods()
            .find(method => method.getName() === methodName)!;
        const summarize = (className: string) => {
            const cls = classFor(className);
            const endMethod = methodFor(className, 'onDestroy');
            const allocation = methodFor(className, 'onCreate').getCfg()!.getStmts()
                .find(stmt => stmt.getInvokeExpr()?.getMethodSignature().getMethodSubSignature()
                    .getMethodName() === 'setInterval')!;
            const summary = new ListenerCleanupSummary(scene, [contract], [{
                classSignature: cls.getSignature().toString(),
                endMethods: [endMethod.getSignature().toString()],
            }], stmt => icfg.getNormalSuccessors(stmt));
            return summary.clearsAtOwnerEnd(allocation, []);
        };
        expect(summarize('GuardedTimerMethodSummary')).toBe(true);
        expect(summarize('ConditionalTimerMethodSummary')).toBe(false);
    });
    it('matches exact direct and helper event cleanup methods', () => {
        const icfg = new ArkInterproceduralCFG(scene);
        icfg.initialize(entry('EventRelease'));
        const rule = resolveListenerRules(scene).rules.find(item => item.id === 'EmitterRegistration')!;
        const contract = listenerContracts([rule])[0];
        const identities = new ListenerIdentity(scene, stmt => icfg.getNormalSuccessors(stmt));
        const check = (className: string) => {
            const cls = scene.getMethods()
                .find(method => method.getDeclaringArkClass().getName() === className)!
                .getDeclaringArkClass();
            const onCreate = cls.getMethods().find(method => method.getName() === 'onCreate')!;
            const allocation = onCreate.getCfg()!.getStmts()
                .find(stmt => stmt.getInvokeExpr()?.getMethodSignature().getMethodSubSignature()
                    .getMethodName() === 'on')!;
            const invoke = allocation.getInvokeExpr()!;
            const summary = new ListenerCleanupSummary(scene, [contract], [{
                classSignature: cls.getSignature().toString(),
                endMethods: cls.getMethods().filter(method => method.getName() === 'onDestroy')
                    .map(method => method.getSignature().toString()),
            }], stmt => icfg.getNormalSuccessors(stmt));
            return summary.clearsEventAtOwnerEnd(allocation, {
                registrar: 'system',
                event: identities.event(invoke.getArgs()[0], allocation),
                callback: identities.resolve(invoke.getArgs()[1], allocation),
            });
        };
        expect(check('EventRelease')).toBe(true);
        expect(check('WrongEvent')).toBe(false);
        expect(check('PartialOff')).toBe(false);
        expect(check('HelperEventRelease')).toBe(true);
        expect(check('ConditionalEventRelease')).toBe(false);
    });
    it('recognizes only forwarding wrappers that pass the callback unchanged', () => {
        const icfg = new ArkInterproceduralCFG(scene);
        icfg.initialize(entry('EventRelease'));
        const rule = resolveListenerRules(scene).rules.find(item => item.id === 'EmitterRegistration')!;
        const contract = listenerContracts([rule])[0];
        const summary = new ListenerCleanupSummary(scene, [contract], [],
            stmt => icfg.getNormalSuccessors(stmt));
        const onMethod = (className: string) => scene.getMethods().find(method =>
            method.getDeclaringArkClass().getName() === className && method.getName() === 'on')!;
        const allocation = (className: string) => onMethod(className).getCfg()!.getStmts()
            .find(stmt => stmt.getInvokeExpr()?.getMethodSignature().getMethodSubSignature()
                .getMethodName() === 'on')!;
        expect(summary.isPureForwardingRegistration(allocation('ForwardingEmitter'))).toBe(true);
        expect(summary.isPureForwardingRegistration(allocation('WrappingEmitter'))).toBe(false);
        expect(summary.isPureForwardingRegistration(allocation('RetainingEmitter'))).toBe(false);
    });
    it('suppresses an overwrite only when cleanup precedes every re-registration', () => {
        expect(run('PreclearedRepeatedTimer').diagnostics).toEqual([]);
        const overwritten = run('OverwrittenRepeatedTimer');
        expect(overwritten.success, overwritten.error).toBe(true);
        expect(overwritten.diagnostics).toMatchObject([{ reason: 'overwritten' }]);
    });
    it('uses a boolean reentry guard only when it remains set through registration', () => {
        expect(run('GuardedRepeatedTimer').diagnostics).toEqual([]);
        expect(run('ResetGuardTimer').diagnostics).toMatchObject([{ reason: 'overwritten' }]);
    });
    it.each(['UnknownEvent', 'UnknownCallback'])(
        'preserves uncertain identities as low-confidence candidates: %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0]).toMatchObject({ reason: 'unknown-registration', confidence: 'low' });
        });
    it('reports a definitely replaced registrar as a high-confidence unregistered listener', () => {
        const result = run('ReplacedRegistrar');
        expect(result.success, result.error).toBe(true);
        expect(result.diagnostics).toMatchObject([{ reason: 'unregistered', confidence: 'high' }]);
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
