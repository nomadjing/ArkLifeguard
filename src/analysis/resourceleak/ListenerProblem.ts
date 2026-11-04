import {
    ArkInstanceInvokeExpr, ArkInstanceFieldRef, ArkStaticFieldRef,
    type ArkMethod, type Scene, type Stmt, type Value,
} from '../../adapter/arkanalyzer';
import type { FlowFunction } from '../../ifds/DataflowProblem';
import { ResourceProblem } from './ResourceProblem';
import { ResourceFact, hasResourceHandle, resourceValueKey } from './ResourceFact';
import { ListenerIdentity } from './ListenerIdentity';
import { ListenerEffects } from './ListenerEffects';
import type { ListenerRule } from './rules/ListenerRules';
import type { ResourceRule } from './rules/ResourceRule';

function listenerHandleKey(value: Value): string {
    if (value instanceof ArkInstanceFieldRef && value.getBase().getName() === 'this') {
        return `this-field:${value.getFieldSignature().toString()}`;
    }
    return resourceValueKey(value);
}

export function listenerContracts(rules: readonly ListenerRule[]): ResourceRule[] {
    return rules.map(rule => ({ id: rule.id, scope: 'listener',
        allocators: rule.allocators.map(methodSignature => ({ methodSignature,
            handleLocation: rule.kind === 'timer' ? { kind: 'return' as const }
                : { kind: 'param' as const, index: rule.callbackIndex } })),
        releasers: rule.releasers.map(methodSignature => ({ methodSignature,
            handleLocation: { kind: 'param' as const, index: rule.kind === 'timer' ? 0 : rule.releaseCallbackIndex ?? 0 } })),
    }));
}

/** IFDS registration obligations. Callback bodies are never executed as registration effects. */
export class ListenerProblem extends ResourceProblem {
    private readonly identities: ListenerIdentity;
    private readonly effects: ListenerEffects;
    constructor(entry: Stmt, method: ArkMethod, private readonly listenerRules: readonly ListenerRule[],
        scene: Scene, successors: (stmt: Stmt) => readonly Stmt[]) {
        super(entry, method, listenerContracts(listenerRules), successors);
        for (const rule of listenerRules) {
            for (const index of [rule.callbackIndex, rule.eventIndex, rule.releaseEventIndex, rule.releaseCallbackIndex]) {
                if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw new Error(`Invalid listener argument index: ${rule.id}`);
            }
        }
        this.identities = new ListenerIdentity(scene, successors);
        this.effects = new ListenerEffects(scene, listenerRules);
    }
    override getCallFlowFunction(stmt: Stmt, method: ArkMethod): FlowFunction<ResourceFact> {
        const signature = stmt.getInvokeExpr()?.getMethodSignature().toString();
        // Even the zero fact must not enter callbacks merely because registration
        // or Promise.then exposed them as possible call-graph targets.
        if (signature !== method.getSignature().toString() || this.listenerRules.some(rule =>
            rule.allocators.includes(signature!) || rule.releasers.includes(signature!))) {
            return { getDataFacts: () => new Set() };
        }
        const flow = super.getCallFlowFunction(stmt, method);
        return { getDataFacts: fact => {
            const result = new Set([...flow.getDataFacts(fact)].map(output =>
                output.isZero() ? output : output.derive({ frames: [] })));
            if (!fact.isZero()) {
                if (result.size) this.effects.statistics.entered++;
                else this.effects.statistics.skipped++;
                for (const output of result) if (!output.handles.length) this.effects.statistics.emptyHandleEntries++;
            }
            return result;
        } };
    }
    private restoreCallerFrame(fact: ResourceFact, call: Stmt, caller?: ResourceFact): ResourceFact {
        if (!caller || caller.isZero() || fact.isZero() || fact.allocationSite !== caller.allocationSite ||
            fact.ruleId !== caller.ruleId || fact.acquisitionContext.length !== caller.acquisitionContext.length ||
            !fact.acquisitionContext.every((site, index) => site === caller.acquisitionContext[index])) return fact;
        // Recovery data belongs to this incoming call, not the reusable callee input.
        return fact.derive({ frames: [{ callSite: call, callerHandles: caller.handles }] });
    }
    override getExitToReturnFlowFunction(exit: Stmt, target: Stmt, call: Stmt, caller?: ResourceFact): FlowFunction<ResourceFact> {
        const flow = super.getExitToReturnFlowFunction(exit, target, call);
        return { getDataFacts: fact => new Set([...flow.getDataFacts(this.restoreCallerFrame(fact, call, caller))]
            .map(output => output.isZero() ? output : output.derive({ acquisitionContext: [] }))) };
    }
    override getExceptionalExitToReturnFlowFunction(exit: Stmt, target: Stmt, call: Stmt, caller?: ResourceFact): FlowFunction<ResourceFact> {
        const flow = super.getExceptionalExitToReturnFlowFunction(exit, target, call);
        return { getDataFacts: fact => new Set([...flow.getDataFacts(this.restoreCallerFrame(fact, call, caller))]
            .map(output => output.isZero() ? output : output.derive({ acquisitionContext: [] }))) };
    }
    protected override shouldEnterCallee(stmt: Stmt, method: ArkMethod, fact: ResourceFact): boolean {
        if (this.bypassUnmappedRegistration(stmt, method, fact)) return false;
        return fact.state !== 'released' && fact.state !== 'escaped' && this.effects.mayAffect(method, fact.ruleId);
    }
    private bypassUnmappedRegistration(stmt: Stmt, method: ArkMethod, fact: ResourceFact): boolean {
        const mapped = this.mapCallerHandlesToCallee(stmt, method, fact.handles);
        if (mapped.length > 0) {
            // Skip unmapped field obligations only when the body and its resolved
            // callees never access those field signatures;
            // unknown external effects still lower the bypass to unknown.
            const unrelatedFieldsOnly = mapped.every(handle =>
                (handle instanceof ArkStaticFieldRef || handle instanceof ArkInstanceFieldRef) &&
                !this.effects.mayAccessField(method, handle.getFieldSignature().toString()));
            if (!unrelatedFieldsOnly) return false;
        }
        // Timers require a token. Events may cancel by registrar/event alone,
        // so preserve all transitive cancellation bodies, including off-all.
        return this.listenerRules.find(rule => rule.id === fact.ruleId)?.kind === 'timer' ||
            !this.effects.mayCancel(method, fact.ruleId);
    }
    override getPropagationStatistics() { return this.effects.statistics; }
    override getCallToReturnFlowFunction(stmt: Stmt, target: Stmt, callees?: ReadonlySet<ArkMethod>): FlowFunction<ResourceFact> {
        const flow = super.getCallToReturnFlowFunction(stmt, target, callees);
        return { getDataFacts: fact => {
            const outputs = flow.getDataFacts(fact);
            const uncertainSkip = !fact.isZero() && fact.state !== 'released' && fact.state !== 'escaped' &&
                [...(callees ?? [])].some(method => this.effects.mayAffect(method, fact.ruleId) &&
                    this.bypassUnmappedRegistration(stmt, method, fact));
            // Skipping opaque bodies is not proof of non-release. Keep the duty
            // and uncertainty, without a new evidence identity at every call.
            return uncertainSkip ? new Set([...outputs].map(output =>
                output.hasLostHandles() || output.state === 'released' || output.state === 'escaped' ? output : output.derive({
                state: 'unknown', event: 'unknown-ownership', eventSite: output.allocationSite,
            }))) : outputs;
        } };
    }
    protected override transfer(stmt: Stmt, fact: ResourceFact): Set<ResourceFact> {
        const invoke = stmt.getInvokeExpr();
        const signature = invoke?.getMethodSignature().toString();
        if (fact.isZero()) {
            const result = new Set([fact]);
            for (const rule of this.listenerRules) {
                if (!invoke || !rule.allocators.includes(signature!) || rule.selfExpiring) continue;
                const callback = invoke.getArgs()[rule.callbackIndex];
                const registrar = rule.registrar === 'system' ? 'system'
                    : invoke instanceof ArkInstanceInvokeExpr
                        ? this.identities.receiver(invoke.getBase(), stmt, rule.id)
                        : undefined;
                const event = rule.kind === 'timer' ? 'timer' : this.identities.event(invoke.getArgs()[rule.eventIndex ?? 0], stmt);
                const callbackId = this.identities.resolve(callback, stmt);
                const knownCallback = callbackId && !callbackId.startsWith('constant:');
                const contract = listenerContracts([rule])[0];
                const handle = this.handleAt(stmt, contract.allocators[0].handleLocation);
                const allocated = ResourceFact.allocate(rule.id, stmt, handle);
                result.add(allocated.derive({ registration: { registrar, event,
                    callback: knownCallback ? callbackId : undefined },
                    state: registrar && event && (rule.kind === 'timer' || knownCallback) ? 'allocated' : 'unknown',
                }));
            }
            return result;
        }
        return super.transfer(stmt, fact);
    }
    protected override releaseAt(stmt: Stmt, fact: ResourceFact): ResourceFact | undefined {
        if (fact.isZero() || fact.state === 'released') return undefined;
        const rule = this.listenerRules.find(rule => rule.id === fact.ruleId)!;
        const invoke = stmt.getInvokeExpr();
        if (!invoke || !rule.releasers.includes(invoke.getMethodSignature().toString())) return undefined;
        if (rule.kind === 'timer') {
            const token = invoke.getArgs()[0];
            const tokenKey = token ? listenerHandleKey(token) : undefined;
            return tokenKey && fact.handles.some(handle => listenerHandleKey(handle) === tokenKey)
                ? fact.derive({ state: 'released', eventSite: stmt })
                : undefined;
        }
        const identity = fact.registration!;
        const registrar = rule.registrar === 'system' ? 'system'
            : invoke instanceof ArkInstanceInvokeExpr
                ? this.identities.receiver(invoke.getBase(), stmt, rule.id)
                : undefined;
        const event = this.identities.event(invoke.getArgs()[rule.releaseEventIndex ?? 0], stmt);
        if (!registrar || !identity.registrar || !event || !identity.event) return undefined;
        if (registrar !== identity.registrar || event !== identity.event) return undefined;
        const callback = rule.releaseCallbackIndex === undefined ? undefined : invoke.getArgs()[rule.releaseCallbackIndex];
        const callbackIdentity = callback ? this.identities.resolve(callback, stmt) : undefined;
        const matched = callback
            ? !!identity.callback && callbackIdentity !== undefined && callbackIdentity === identity.callback
            : rule.allowRemoveAll;
        return matched ? fact.derive({
            state: 'released',
            eventSite: stmt,
            registration: !callback && rule.allowRemoveAll ? { ...identity, removeAll: true } : identity,
        }) : undefined;
    }
}
