import { ArkInstanceInvokeExpr, type ArkMethod, type Stmt } from '../../adapter/arkanalyzer';
import { DataflowProblem, type FlowFunction } from '../../ifds/DataflowProblem';
import { ResourceFact, resourceValueKey } from './ResourceFact';
import type { ResourceProblem } from './ResourceProblem';

export interface ReleaseOwner {
    readonly classSignature: string;
    readonly endMethods: readonly string[];
}

/** Owner identity comes from generated entry calls, never from callback captures. */
export class OwnerBoundaryProblem extends DataflowProblem<ResourceFact> {
    private readonly owners = new Map<Stmt, string>();
    private readonly boundaries = new Map<Stmt, string>();

    constructor(private readonly problem: ResourceProblem, entry: ArkMethod, definitions: readonly ReleaseOwner[]) {
        super();
        const lastEnd = new Map<string, Stmt>();
        for (const stmt of entry.getCfg()?.getStmts() ?? []) {
            const invoke = stmt.getInvokeExpr();
            if (!(invoke instanceof ArkInstanceInvokeExpr)) continue;
            const definition = definitions.find(owner => owner.classSignature ===
                invoke.getMethodSignature().getDeclaringClassSignature().toString());
            if (!definition) continue;
            const owner = resourceValueKey(invoke.getBase());
            this.owners.set(stmt, owner);
            if (definition.endMethods.includes(invoke.getMethodSignature().toString())) lastEnd.set(owner, stmt);
        }
        for (const [owner, stmt] of lastEnd) this.boundaries.set(stmt, owner);
    }

    private wrap(flow: FlowFunction<ResourceFact>, call?: Stmt): FlowFunction<ResourceFact> {
        return { getDataFacts: fact => {
            // Boundary facts remain available as evidence at the return site,
            // but cannot be discharged by a later owner's cleanup.
            if (fact.boundary) return new Set();
            const result = flow.getDataFacts(fact);
            if (!call) return result;
            return new Set([...result].map(output => {
                if (output.isZero()) return output;
                const owner = output.owner ?? this.owners.get(call);
                return output.derive({ owner,
                    boundary: owner && this.boundaries.get(call) === owner ? call : undefined });
            }));
        } };
    }

    getNormalFlowFunction(src: Stmt, dst: Stmt) { return this.wrap(this.problem.getNormalFlowFunction(src, dst)); }
    getCallFlowFunction(src: Stmt, method: ArkMethod) { return this.wrap(this.problem.getCallFlowFunction(src, method)); }
    getExitToReturnFlowFunction(src: Stmt, dst: Stmt, call: Stmt, callerFact?: ResourceFact) {
        return this.wrap(this.problem.getExitToReturnFlowFunction(src, dst, call, callerFact), call);
    }
    getCallToReturnFlowFunction(src: Stmt, dst: Stmt, callees?: ReadonlySet<ArkMethod>) {
        return this.wrap(this.problem.getCallToReturnFlowFunction(src, dst, callees), src);
    }
    getExceptionalFlowFunction(src: Stmt, dst: Stmt) { return this.wrap(this.problem.getExceptionalFlowFunction(src, dst)); }
    getExceptionalExitFlowFunction(src: Stmt) { return this.wrap(this.problem.getExceptionalExitFlowFunction(src)); }
    getCallToExceptionalReturnFlowFunction(src: Stmt, dst: Stmt, callees?: ReadonlySet<ArkMethod>, fromCallee = false) {
        return this.wrap(this.problem.getCallToExceptionalReturnFlowFunction(src, dst, callees, fromCallee), src);
    }
    getExceptionalExitToReturnFlowFunction(src: Stmt, dst: Stmt, call: Stmt, callerFact?: ResourceFact) {
        return this.wrap(this.problem.getExceptionalExitToReturnFlowFunction(src, dst, call, callerFact), call);
    }
    override getFactStatisticsKey(fact: ResourceFact) { return this.problem.getFactStatisticsKey(fact); }
    createZeroValue() { return this.problem.createZeroValue(); }
    getEntryPoint() { return this.problem.getEntryPoint(); }
    getEntryMethod() { return this.problem.getEntryMethod(); }
    factEqual(left: ResourceFact, right: ResourceFact) { return this.problem.factEqual(left, right); }
    factHash(fact: ResourceFact) { return this.problem.factHash(fact); }
}
