import {
    ArkAssignStmt,
    ArkArrayRef,
    ArkCastExpr,
    ArkInstanceFieldRef,
    ArkInstanceInvokeExpr,
    ArkMethod,
    ArkParameterRef,
    ArkReturnStmt,
    ArkStaticFieldRef,
    GlobalRef,
    ArkThisRef,
    Local,
    NullConstant,
    Stmt,
    UndefinedConstant,
    Value,
} from '../../adapter/arkanalyzer';
import { DataflowProblem, FlowFunction } from '../../ifds/DataflowProblem';
import {
    hasResourceHandle,
    ResourceFact,
    resourceValueKey,
    uniqueResourceHandles,
} from './ResourceFact';
import type { ResourceApi, ResourceHandleLocation, ResourceRule } from './rules/ResourceRule';

/** Rule-driven IFDS transfer functions. No global mutable allocation/release map is used. */
export class ResourceProblem extends DataflowProblem<ResourceFact> {
    private readonly zero = ResourceFact.zeroFact();
    private readonly rules: readonly ResourceRule[];
    private readonly objectIds = new WeakMap<object, number>();
    private readonly factKeys = new WeakMap<ResourceFact, string>();
    private readonly factHashes = new WeakMap<ResourceFact, number>();
    private nextObjectId = 1;
    private readonly maxCallDepth = 4;

    constructor(
        private readonly entryPoint: Stmt,
        private readonly entryMethod: ArkMethod,
        rules: readonly ResourceRule[],
    ) {
        super();
        const ids = new Set<string>();
        for (const rule of rules) {
            if (!rule.id || ids.has(rule.id) || rule.allocators.length === 0 ||
                (rule.releasers.length === 0 && !rule.releaseByNullify)) {
                throw new Error(`无效或重复的资源规则: ${rule.id}`);
            }
            for (const api of [...rule.allocators, ...rule.releasers]) {
                if (!api.methodSignature ||
                    (api.handleLocation.kind === 'param' &&
                        (!Number.isInteger(api.handleLocation.index) ||
                            api.handleLocation.index < 0))) {
                    throw new Error(`资源规则 ${rule.id} 的 API 或句柄位置无效`);
                }
            }
            ids.add(rule.id);
        }
        this.rules = rules;
    }

    getNormalFlowFunction(srcStmt: Stmt, _tgtStmt: Stmt): FlowFunction<ResourceFact> {
        return { getDataFacts: fact => this.transfer(srcStmt, fact) };
    }

    getCallFlowFunction(srcStmt: Stmt, method: ArkMethod): FlowFunction<ResourceFact> {
        return {
            getDataFacts: fact => {
                if (fact.isZero()) return new Set([fact]);
                if (this.isRuleApi(srcStmt)) return new Set();
                if (!this.isDirectCallee(srcStmt, method)) return new Set();
                if (fact.frames.length >= this.maxCallDepth) {
                    return new Set();
                }
                const mapped = this.mapCallerHandlesToCallee(srcStmt, method, fact.handles);
                if (mapped.length === 0) return new Set();
                return new Set([fact.derive({
                    handles: mapped,
                    frames: [...fact.frames, { callSite: srcStmt, callerHandles: fact.handles }],
                })]);
            },
        };
    }

    getExitToReturnFlowFunction(exitStmt: Stmt, _returnSite: Stmt, callStmt: Stmt): FlowFunction<ResourceFact> {
        return {
            getDataFacts: fact => {
                if (fact.isZero()) return new Set([fact]);
                const frame = fact.frames.at(-1);
                if (frame?.callSite === callStmt) {
                    const handles = this.mapCalleeHandlesToCaller(exitStmt, callStmt, fact.handles);
                    // A caller's aliases survive pass-by-value parameter assignments.
                    return new Set([fact.derive({
                        handles: uniqueResourceHandles([...frame.callerHandles, ...handles]),
                        frames: fact.frames.slice(0, -1),
                    })]);
                }
                // An allocation in this callee can reach its caller only through
                // the returned value or a receiver/static field.
                const handles = this.mapCalleeHandlesToCaller(exitStmt, callStmt, fact.handles);
                return handles.length > 0
                    ? new Set([fact.derive({ handles })])
                    : new Set();
            },
        };
    }

    getCallToReturnFlowFunction(
        srcStmt: Stmt,
        _tgtStmt: Stmt,
        callees?: ReadonlySet<ArkMethod>,
    ): FlowFunction<ResourceFact> {
        return {
            getDataFacts: fact => {
                const transferred = this.transfer(srcStmt, fact);
                if (fact.isZero()) return transferred;
                if (this.isRuleApi(srcStmt)) return transferred;
                if (fact.state === 'released' || fact.state === 'escaped') return transferred;
                if ([...(callees ?? [])].some(method =>
                    !this.isDirectCallee(srcStmt, method))) {
                    // CallResolver includes callback targets on a registration
                    // call. Their execution is optional at this boundary; the
                    // caller continuation cannot claim definite non-release.
                    return new Set([...transferred].map(item => item.derive({
                        state: 'unknown', event: 'unknown-ownership', eventSite: srcStmt,
                    })));
                }
                if (fact.frames.length >= this.maxCallDepth) {
                    return new Set([fact.derive({
                        state: 'unknown', event: 'unknown-ownership', eventSite: srcStmt,
                    })]);
                }
                const directCallees = [...(callees ?? [])].filter(method =>
                    method.getCfg() && this.isDirectCallee(srcStmt, method));
                if (directCallees.some(method =>
                    this.mapCallerHandlesToCallee(srcStmt, method, fact.handles).length > 0)) {
                    // The callee summary owns this path. Keeping an unchanged bypass
                    // would reintroduce a leak after a definite release in the callee.
                    return new Set();
                }
                return transferred;
            },
        };
    }

    createZeroValue(): ResourceFact { return this.zero; }
    getEntryPoint(): Stmt { return this.entryPoint; }
    getEntryMethod(): ArkMethod { return this.entryMethod; }

    factEqual(left: ResourceFact, right: ResourceFact): boolean {
        return left === right || this.factKey(left) === this.factKey(right);
    }

    factHash(fact: ResourceFact): number {
        const cached = this.factHashes.get(fact);
        if (cached !== undefined) return cached;
        const key = this.factKey(fact);
        let hash = 2166136261;
        for (let index = 0; index < key.length; index++) {
            hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
        }
        const result = hash >>> 0;
        this.factHashes.set(fact, result);
        return result;
    }

    private factKey(fact: ResourceFact): string {
        if (fact.isZero()) return 'zero';
        const cached = this.factKeys.get(fact);
        if (cached !== undefined) return cached;
        const key = [fact.ruleId, this.id(fact.allocationSite!), fact.state,
            fact.handles.map(resourceValueKey).sort().join(','), fact.event ?? '',
            fact.eventSite ? this.id(fact.eventSite) : 0,
            ...fact.frames.map(frame => `${this.id(frame.callSite)}:${frame.callerHandles
                .map(resourceValueKey).sort().join(',')}`)].join('|');
        this.factKeys.set(fact, key);
        return key;
    }

    private id(value: object): number {
        let id = this.objectIds.get(value);
        if (!id) {
            id = this.nextObjectId++;
            this.objectIds.set(value, id);
        }
        return id;
    }

    private transfer(stmt: Stmt, fact: ResourceFact): Set<ResourceFact> {
        if (fact.isZero()) {
            const result = new Set([fact]);
            for (const rule of this.rules) {
                for (const allocator of rule.allocators) {
                    if (!this.matchesApi(stmt, allocator)) continue;
                    result.add(ResourceFact.allocate(
                        rule.id, stmt, this.handleAt(stmt, allocator.handleLocation)
                    ));
                }
            }
            return result;
        }
        if (fact.state === 'released' || fact.state === 'escaped') return new Set([fact]);
        const rule = this.rules.find(item => item.id === fact.ruleId)!;
        for (const releaser of rule.releasers) {
            if (!this.matchesApi(stmt, releaser)) continue;
            const handle = this.handleAt(stmt, releaser.handleLocation);
            if (handle && hasResourceHandle(fact.handles, handle)) {
                return new Set([fact.derive({ state: 'released', eventSite: stmt })]);
            }
        }
        for (const other of this.rules) {
            if (other.id === rule.id) continue;
            for (const releaser of other.releasers) {
                if (!this.matchesApi(stmt, releaser)) continue;
                const handle = this.handleAt(stmt, releaser.handleLocation);
                if (handle && hasResourceHandle(fact.handles, handle)) {
                    return new Set([fact.derive({ event: 'wrong-release', eventSite: stmt })]);
                }
            }
        }
        if (stmt instanceof ArkAssignStmt && !stmt.getInvokeExpr()) {
            const left = stmt.getLeftOp();
            const right = this.unwrap(stmt.getRightOp());
            // Parameter/this bindings are synthetic CFG entry statements. The
            // call flow already mapped the incoming handle onto their locals.
            if (right instanceof ArkParameterRef || right instanceof ArkThisRef) {
                return new Set([fact]);
            }
            const wasHandle = hasResourceHandle(fact.handles, left);
            const copied = hasResourceHandle(fact.handles, right);
            if (rule.releaseByNullify && wasHandle &&
                (right instanceof NullConstant || right instanceof UndefinedConstant)) {
                return new Set([fact.derive({ state: 'released', eventSite: stmt })]);
            }
            const remaining = fact.handles.filter(handle =>
                resourceValueKey(handle) !== resourceValueKey(left));
            if (copied) remaining.push(left);
            const handles = uniqueResourceHandles(remaining);
            if (copied && (left instanceof ArkArrayRef || left instanceof ArkStaticFieldRef ||
                left instanceof GlobalRef ||
                (left instanceof ArkInstanceFieldRef && left.getBase().toString() !== 'this'))) {
                return new Set([fact.derive({
                    handles,
                    state: 'unknown',
                    event: 'unknown-ownership',
                    eventSite: stmt,
                })]);
            }
            if (handles.length === 0 && wasHandle) {
                return new Set([fact.derive({ handles, event: 'overwritten', eventSite: stmt })]);
            }
            return new Set([fact.derive({ handles })]);
        }
        const invoke = stmt.getInvokeExpr();
        if (invoke && !this.isRuleApi(stmt) && invoke.getArgs().some(arg =>
            hasResourceHandle(fact.handles, arg))) {
            return new Set([fact.derive({
                state: 'unknown', event: 'unknown-ownership', eventSite: stmt,
            })]);
        }
        if (stmt instanceof ArkAssignStmt && stmt.getInvokeExpr()) {
            const left = stmt.getLeftOp();
            if (hasResourceHandle(fact.handles, left)) {
                const handles = fact.handles.filter(handle =>
                    resourceValueKey(handle) !== resourceValueKey(left));
                return new Set([fact.derive({
                    handles,
                    event: handles.length ? fact.event : 'overwritten',
                    eventSite: handles.length ? fact.eventSite : stmt,
                })]);
            }
        }
        return new Set([fact]);
    }

    private matchesApi(stmt: Stmt, api: ResourceApi): boolean {
        return stmt.getInvokeExpr()?.getMethodSignature().toString() === api.methodSignature;
    }

    private isRuleApi(stmt: Stmt): boolean {
        return this.rules.some(rule => [...rule.allocators, ...rule.releasers]
            .some(api => this.matchesApi(stmt, api)));
    }

    private handleAt(stmt: Stmt, location: ResourceHandleLocation): Value | undefined {
        const invoke = stmt.getInvokeExpr();
        if (!invoke) return undefined;
        if (location.kind === 'return') {
            return stmt instanceof ArkAssignStmt ? stmt.getLeftOp() : undefined;
        }
        if (location.kind === 'base') {
            return invoke instanceof ArkInstanceInvokeExpr ? invoke.getBase() : undefined;
        }
        if (location.kind === 'param') return invoke.getArgs()[location.index];
        return undefined;
    }

    private unwrap(value: Value): Value {
        return value instanceof ArkCastExpr ? value.getOp() : value;
    }

    private isDirectCallee(stmt: Stmt, method: ArkMethod): boolean {
        const invoked = stmt.getInvokeExpr()?.getMethodSignature();
        return !!invoked && invoked.toString() === method.getSignature().toString();
    }

    private mapCallerHandlesToCallee(stmt: Stmt, method: ArkMethod, handles: readonly Value[]): Value[] {
        const invoke = stmt.getInvokeExpr();
        if (!invoke) return [];
        const mapped: Value[] = [];
        for (let index = 0; index < invoke.getArgs().length; index++) {
            const argument = invoke.getArgs()[index];
            if (!hasResourceHandle(handles, argument)) continue;
            const parameter = this.getParameterLocal(method, index);
            if (parameter) mapped.push(parameter);
        }
        if (invoke instanceof ArkInstanceInvokeExpr) {
            const receiver = invoke.getBase();
            const thisLocal = this.getThisLocal(method);
            if (thisLocal) {
                for (const handle of handles) {
                    const rebased = this.rebase(handle, receiver, thisLocal);
                    if (rebased) mapped.push(rebased);
                }
            }
        }
        for (const handle of handles) {
            if (handle instanceof ArkStaticFieldRef) mapped.push(handle);
        }
        return uniqueResourceHandles(mapped);
    }

    private mapCalleeHandlesToCaller(exit: Stmt, call: Stmt, handles: readonly Value[]): Value[] {
        const invoke = call.getInvokeExpr();
        if (!invoke) return [];
        const result: Value[] = [];
        const method = exit.getCfg()?.getDeclaringMethod();
        if (method) {
            for (let index = 0; index < invoke.getArgs().length; index++) {
                const parameter = this.getParameterLocal(method, index);
                if (parameter && hasResourceHandle(handles, parameter)) {
                    result.push(invoke.getArgs()[index]);
                }
            }
        }
        if (invoke instanceof ArkInstanceInvokeExpr) {
            for (const handle of handles) {
                const rebased = this.rebase(handle, this.getThisLocal(method), invoke.getBase());
                if (rebased) result.push(rebased);
            }
        }
        if (exit instanceof ArkReturnStmt && call instanceof ArkAssignStmt &&
            hasResourceHandle(handles, this.unwrap(exit.getOp()))) {
            result.push(call.getLeftOp());
        }
        for (const handle of handles) {
            if (handle instanceof ArkStaticFieldRef) result.push(handle);
        }
        return uniqueResourceHandles(result);
    }

    private rebase(handle: Value, from: Value | null, to: Value): Value | undefined {
        if (!from) return undefined;
        if (resourceValueKey(handle) === resourceValueKey(from)) return to;
        // Field references created in another CFG can have a distinct object
        // while retaining the same base and signature. Rebuild with the new base.
        if (handle instanceof ArkInstanceFieldRef && from instanceof Local && to instanceof Local &&
            resourceValueKey(handle.getBase()) === resourceValueKey(from)) {
            return new ArkInstanceFieldRef(to, handle.getFieldSignature());
        }
        return undefined;
    }

    private getParameterLocal(method: ArkMethod, index: number): Local | null {
        for (const stmt of method.getCfg()?.getStartingBlock()?.getStmts() ?? []) {
            if (!(stmt instanceof ArkAssignStmt)) continue;
            const reference = stmt.getRightOp();
            if (reference instanceof ArkParameterRef &&
                reference.getIndex() === index &&
                stmt.getLeftOp() instanceof Local) {
                return stmt.getLeftOp() as Local;
            }
        }
        return null;
    }

    private getThisLocal(method?: ArkMethod): Local | null {
        for (const stmt of method?.getCfg()?.getStartingBlock()?.getStmts() ?? []) {
            if (stmt.getDef() instanceof Local && stmt.getDef()?.toString() === 'this') {
                return stmt.getDef() as Local;
            }
        }
        return null;
    }
}
