import { ArkInstanceInvokeExpr, type ArkMethod, type Scene, type Stmt } from '../../adapter/arkanalyzer';
import type { FlowFunction } from '../../ifds/DataflowProblem';
import { ResourceProblem } from './ResourceProblem';
import { ResourceFact, hasResourceHandle } from './ResourceFact';
import { ListenerIdentity } from './ListenerIdentity';
import type { ListenerRule } from './rules/ListenerRules';
import type { ResourceRule } from './rules/ResourceRule';

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
    constructor(entry: Stmt, method: ArkMethod, private readonly listenerRules: readonly ListenerRule[],
        scene: Scene, successors: (stmt: Stmt) => readonly Stmt[]) {
        super(entry, method, listenerContracts(listenerRules), successors);
        for (const rule of listenerRules) {
            for (const index of [rule.callbackIndex, rule.eventIndex, rule.releaseEventIndex, rule.releaseCallbackIndex]) {
                if (index !== undefined && (!Number.isInteger(index) || index < 0)) throw new Error(`Invalid listener argument index: ${rule.id}`);
            }
        }
        this.identities = new ListenerIdentity(scene, successors);
    }
    override getCallFlowFunction(stmt: Stmt, method: ArkMethod): FlowFunction<ResourceFact> {
        const signature = stmt.getInvokeExpr()?.getMethodSignature().toString();
        // Even the zero fact must not enter callbacks merely because registration
        // or Promise.then exposed them as possible call-graph targets.
        if (signature !== method.getSignature().toString() || this.listenerRules.some(rule =>
            rule.allocators.includes(signature!) || rule.releasers.includes(signature!))) {
            return { getDataFacts: () => new Set() };
        }
        return super.getCallFlowFunction(stmt, method);
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
                    : invoke instanceof ArkInstanceInvokeExpr ? this.identities.resolve(invoke.getBase(), stmt) : undefined;
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
            return token && hasResourceHandle(fact.handles, token) ? fact.derive({ state: 'released', eventSite: stmt }) : undefined;
        }
        const identity = fact.registration!;
        const registrar = rule.registrar === 'system' ? 'system'
            : invoke instanceof ArkInstanceInvokeExpr ? this.identities.resolve(invoke.getBase(), stmt) : undefined;
        const event = this.identities.event(invoke.getArgs()[rule.releaseEventIndex ?? 0], stmt);
        if (!registrar || !identity.registrar || !event || !identity.event) return undefined;
        if (registrar !== identity.registrar || event !== identity.event) return undefined;
        const callback = rule.releaseCallbackIndex === undefined ? undefined : invoke.getArgs()[rule.releaseCallbackIndex];
        const matched = callback ? hasResourceHandle(fact.handles, callback) ||
            (!!identity.callback && this.identities.resolve(callback, stmt) === identity.callback) : rule.allowRemoveAll;
        return matched ? fact.derive({ state: 'released', eventSite: stmt }) : undefined;
    }
}
