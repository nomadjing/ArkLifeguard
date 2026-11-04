import {
    ArkAssignStmt, ArkCastExpr, ArkInstanceFieldRef, ArkInstanceInvokeExpr, ArkNewExpr,
    ArkParameterRef, ArkStaticFieldRef, ArkThisRef, Constant, FunctionType, Local, NullConstant,
    UndefinedConstant,
    type Scene, type Stmt, type Value,
} from '../../adapter/arkanalyzer';
import { resourceValueKey } from './ResourceFact';

/** Small, query-local identity resolution for registration arguments. No capture or heap graph.
 * Multiple reaching definitions/callers remain unknown instead of selecting one arbitrarily.
 */
export class ListenerIdentity {
    private readonly ids = new WeakMap<object, number>();
    private nextId = 1;
    private readonly resolved = new Map<string, string | undefined>();
    private readonly definitionCache = new Map<string, ArkAssignStmt[]>();
    private readonly predecessorCache = new WeakMap<object, Map<Stmt, Stmt[]>>();
    private readonly callers = new Map<string, Stmt[]>();
    private readonly fieldWrites = new Map<string, ArkAssignStmt[]>();
    private readonly eventIdWrites: ArkAssignStmt[] = [];
    private readonly globalWrites = new Map<string, ArkAssignStmt[]>();
    constructor(private readonly scene: Scene, private readonly successors: (stmt: Stmt) => readonly Stmt[]) {
        for (const method of scene.getMethods()) for (const stmt of method.getCfg()?.getStmts() ?? []) {
            const signature = stmt.getInvokeExpr()?.getMethodSignature().toString();
            if (signature) {
                const entries = this.callers.get(signature) ?? [];
                entries.push(stmt); this.callers.set(signature, entries);
            }
            if (stmt instanceof ArkAssignStmt) {
                const left = stmt.getLeftOp();
                if (method.getDeclaringArkClass().getName() === '%dflt' && left instanceof Local) {
                    const entries = this.globalWrites.get(left.getName()) ?? [];
                    entries.push(stmt);
                    this.globalWrites.set(left.getName(), entries);
                }
                if (!(left instanceof ArkInstanceFieldRef || left instanceof ArkStaticFieldRef)) continue;
                const key = left.getFieldSignature().toString();
                const entries: ArkAssignStmt[] = this.fieldWrites.get(key) ?? [];
                entries.push(stmt);
                this.fieldWrites.set(key, entries);
                if (left.getFieldSignature().getFieldName() === 'eventId') this.eventIdWrites.push(stmt);
            }
        }
    }
    private id(value: object): number {
        let id = this.ids.get(value);
        if (!id) { id = this.nextId++; this.ids.set(value, id); }
        return id;
    }
    resolve(value: Value | undefined, at: Stmt, seen = new Set<string>()): string | undefined {
        if (!value) return undefined;
        if (seen.size === 0) {
            const key = `${this.id(value)}:${this.id(at)}`;
            if (this.resolved.has(key)) return this.resolved.get(key);
            const result = this.resolveUncached(value, at, seen);
            this.resolved.set(key, result);
            return result;
        }
        return this.resolveUncached(value, at, seen);
    }
    private resolveUncached(value: Value, at: Stmt, seen: Set<string>): string | undefined {
        if (value instanceof ArkCastExpr) return this.resolve(value.getOp(), at, seen);
        if (value instanceof ArkThisRef) {
            const owner = at.getCfg()?.getDeclaringMethod().getDeclaringArkClass().getSignature();
            return owner ? `this:${owner}` : undefined;
        }
        if (value instanceof Constant) return `constant:${value.getType()}:${value.toString()}`;
        const key = `${this.id(value)}:${this.id(at)}`;
        if (seen.has(key) || seen.size >= 64) return undefined;
        const next = new Set(seen).add(key);
        if (value instanceof ArkNewExpr) return `allocation:${this.id(at)}`;
        if (value instanceof ArkInstanceFieldRef || value instanceof ArkStaticFieldRef) {
            const localWrites = this.definitions(value, at);
            if (localWrites.length > 0) {
                return this.unique(localWrites.map(stmt => {
                    const right = stmt.getRightOp();
                    return right === value ? undefined : this.resolve(right, stmt, next);
                }));
            }
            const writes = this.fieldWrites.get(value.getFieldSignature().toString()) ?? [];
            if (writes.length > 0) {
                const identities = writes.flatMap(stmt => {
                    const right = stmt.getRightOp();
                    return right === value || right instanceof NullConstant || right instanceof UndefinedConstant
                        ? []
                        : [this.resolve(right, stmt, next)];
                });
                const identity = this.unique(identities);
                if (identity !== undefined) return identity;
                if (writes.length > 1) return undefined;
            }
        }
        if (value instanceof ArkStaticFieldRef) return `static:${value.getFieldSignature()}`;
        if (value instanceof ArkInstanceFieldRef) {
            const base = this.resolve(value.getBase(), at, next);
            return base ? `field:${base}:${value.getFieldSignature()}` : undefined;
        }
        if (!(value instanceof Local)) return undefined;
        const definitions = this.definitions(value, at);
        if (definitions.length) {
            const nonConstructor = definitions.filter(stmt => {
                const invoke = stmt.getInvokeExpr();
                return !(invoke instanceof ArkInstanceInvokeExpr && invoke.getBase() === value &&
                    /construct(?:or|-signature)/.test(invoke.getMethodSignature().getMethodSubSignature().getMethodName()));
            });
            const values = (nonConstructor.length > 0 ? nonConstructor : definitions).map(stmt => {
                const right = stmt.getRightOp();
                if (right instanceof ArkParameterRef || right instanceof ArkThisRef) {
                    const method = stmt.getCfg()?.getDeclaringMethod();
                    const callers = this.callers.get(method?.getSignature().toString() ?? '') ?? [];
                    return this.unique(callers.map(call => {
                        const invoke = call.getInvokeExpr()!;
                        const argument = right instanceof ArkParameterRef ? invoke.getArgs()[right.getIndex()]
                            : invoke instanceof ArkInstanceInvokeExpr ? invoke.getBase() : undefined;
                        return this.resolve(argument, call, next);
                    }));
                }
                // Each bind/factory invocation creates a distinct identity at this site.
                if (stmt.getInvokeExpr()) return `call:${this.id(stmt)}`;
                return this.resolve(right, stmt, next);
            });
            return this.unique(values);
        }
        const globals = this.globalWrites.get(value.getName()) ?? [];
        if (globals.length > 0) {
            return this.unique(globals.map(stmt => this.resolve(stmt.getRightOp(), stmt, next)));
        }
        const type = value.getType();
        if (type instanceof FunctionType) {
            const signature = type.getMethodSignature();
            const position = this.scene.getMethod(signature)?.getImplOriginFullPosition();
            return `function:${signature}:${position?.getFirstLine() ?? 0}:${position?.getFirstCol() ?? 0}`;
        }
        return undefined;
    }
    event(value: Value | undefined, at: Stmt): string | undefined {
        if (!value) return undefined;
        const eventValue = value instanceof Local
            ? (() => {
                const bases = this.definitions(value, at).flatMap(stmt => {
                    const right = stmt.getRightOp();
                    return right instanceof ArkInstanceFieldRef &&
                        right.getFieldSignature().getFieldName() === 'eventId'
                        ? [right.getBase()]
                        : [];
                });
                return bases.length === 1 ? bases[0] : value;
            })()
            : value;
        const descriptor = eventValue instanceof ArkInstanceFieldRef &&
            eventValue.getFieldSignature().getFieldName() === 'eventId'
            ? this.resolve(eventValue.getBase(), at)
            : this.resolve(eventValue, at);
        if (descriptor === undefined) return undefined;
        // on commonly receives an InnerEvent descriptor while off receives its
        // primitive eventId. Normalize both through the descriptor's field write.
        const writes = this.eventIdWrites.filter(stmt => {
            const left = stmt.getLeftOp();
            return left instanceof ArkInstanceFieldRef && this.resolve(left.getBase(), stmt) === descriptor;
        });
        if (writes.length) return this.unique(writes.map(stmt => this.resolve(stmt.getRightOp(), stmt)));
        return descriptor;
    }
    receiver(value: Value | undefined, at: Stmt, ruleId: string): string | undefined {
        if (!value) return undefined;
        if (ruleId === 'EventHubRegistration') {
            let field: ArkInstanceFieldRef | undefined =
                value instanceof ArkInstanceFieldRef ? value : undefined;
            if (!field && value instanceof Local) {
                const fields = this.definitions(value, at).flatMap(stmt => {
                    const right = stmt.getRightOp();
                    return right instanceof ArkInstanceFieldRef &&
                        right.getFieldSignature().getFieldName() === 'eventHub' ? [right] : [];
                });
                if (fields.length === 1) field = fields[0];
            }
            if (field?.getFieldSignature().getFieldName() === 'eventHub') {
                return `event-hub:${field.getFieldSignature().toString()}`;
            }
        }
        return this.resolve(value, at);
    }
    private unique(values: readonly (string | undefined)[]): string | undefined {
        return values.length && values.every(value => value !== undefined && value === values[0]) ? values[0] : undefined;
    }
    private definitions(value: Value, at: Stmt): ArkAssignStmt[] {
        const cacheKey = `${this.id(value)}:${this.id(at)}`;
        const cached = this.definitionCache.get(cacheKey);
        if (cached) return cached;
        const cfg = at.getCfg();
        let predecessors = cfg ? this.predecessorCache.get(cfg) : undefined;
        if (!predecessors) {
            predecessors = new Map<Stmt, Stmt[]>();
            for (const stmt of cfg?.getStmts() ?? []) for (const successor of this.successors(stmt)) {
                const entries = predecessors.get(successor) ?? [];
                entries.push(stmt); predecessors.set(successor, entries);
            }
            if (cfg) this.predecessorCache.set(cfg, predecessors);
        }
        const pending = [...(predecessors.get(at) ?? [])];
        const visited = new Set<Stmt>();
        const result: ArkAssignStmt[] = [];
        while (pending.length) {
            const stmt = pending.pop()!;
            if (visited.has(stmt)) continue;
            visited.add(stmt);
            if (stmt instanceof ArkAssignStmt && resourceValueKey(stmt.getLeftOp()) === resourceValueKey(value)) {
                result.push(stmt);
            } else pending.push(...(predecessors.get(stmt) ?? []));
        }
        // CFG parameter bindings may be before the indexed method entry.
        const declaration = value instanceof Local ? value.getDeclaringStmt() : undefined;
        if (!result.length && declaration instanceof ArkAssignStmt &&
            value instanceof Local &&
            (declaration.getRightOp() instanceof ArkParameterRef || declaration.getRightOp() instanceof ArkThisRef)) result.push(declaration);
        this.definitionCache.set(cacheKey, result);
        return result;
    }
}
