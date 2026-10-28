import {
    ArkAssignStmt, ArkCastExpr, ArkInstanceFieldRef, ArkInstanceInvokeExpr, ArkNewExpr,
    ArkParameterRef, ArkStaticFieldRef, ArkThisRef, Constant, FunctionType, Local,
    type Scene, type Stmt, type Value,
} from '../../adapter/arkanalyzer';
import { resourceValueKey } from './ResourceFact';

/** Small, query-local identity resolution for registration arguments. No capture or heap graph.
 * Multiple reaching definitions/callers remain unknown instead of selecting one arbitrarily.
 */
export class ListenerIdentity {
    private readonly ids = new WeakMap<object, number>();
    private nextId = 1;
    private readonly callers = new Map<string, Stmt[]>();
    private readonly fieldWrites = new Map<string, number>();
    constructor(scene: Scene, private readonly successors: (stmt: Stmt) => readonly Stmt[]) {
        for (const method of scene.getMethods()) for (const stmt of method.getCfg()?.getStmts() ?? []) {
            const signature = stmt.getInvokeExpr()?.getMethodSignature().toString();
            if (signature) {
                const entries = this.callers.get(signature) ?? [];
                entries.push(stmt); this.callers.set(signature, entries);
            }
            const left = stmt instanceof ArkAssignStmt ? stmt.getLeftOp() : undefined;
            if (left instanceof ArkInstanceFieldRef || left instanceof ArkStaticFieldRef) {
                const key = left.getFieldSignature().toString();
                this.fieldWrites.set(key, (this.fieldWrites.get(key) ?? 0) + 1);
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
        if (value instanceof ArkCastExpr) return this.resolve(value.getOp(), at, seen);
        if (value instanceof Constant) return `constant:${value.getType()}:${value.toString()}`;
        const key = `${this.id(value)}:${this.id(at)}`;
        if (seen.has(key) || seen.size >= 64) return undefined;
        const next = new Set(seen).add(key);
        if (value instanceof ArkNewExpr) return `allocation:${this.id(at)}`;
        if ((value instanceof ArkInstanceFieldRef || value instanceof ArkStaticFieldRef) &&
            (this.fieldWrites.get(value.getFieldSignature().toString()) ?? 0) > 1) return undefined;
        if (value instanceof ArkStaticFieldRef) return `static:${value.getFieldSignature()}`;
        if (value instanceof ArkInstanceFieldRef) {
            const base = this.resolve(value.getBase(), at, next);
            return base ? `field:${base}:${value.getFieldSignature()}` : undefined;
        }
        if (!(value instanceof Local)) return undefined;
        const definitions = this.definitions(value, at);
        if (definitions.length) {
            const values = definitions.map(stmt => {
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
        const type = value.getType();
        if (type instanceof FunctionType) return `function:${type.getMethodSignature()}`;
        return undefined;
    }
    event(value: Value | undefined, at: Stmt): string | undefined {
        if (!value) return undefined;
        const identity = this.resolve(value, at);
        // emitter.on takes {eventId}, whereas off takes the numeric eventId.
        const writes = at.getCfg()?.getStmts().filter(stmt => {
            if (!(stmt instanceof ArkAssignStmt)) return false;
            const left = stmt.getLeftOp();
            return left instanceof ArkInstanceFieldRef && left.getFieldSignature().getFieldName() === 'eventId' &&
                identity !== undefined && this.resolve(left.getBase(), stmt) === identity;
        }) as ArkAssignStmt[] | undefined;
        if (writes?.length) return this.unique(writes.map(stmt => this.resolve(stmt.getRightOp(), stmt)));
        return identity;
    }
    private unique(values: readonly (string | undefined)[]): string | undefined {
        return values.length && values.every(value => value !== undefined && value === values[0]) ? values[0] : undefined;
    }
    private definitions(value: Local, at: Stmt): ArkAssignStmt[] {
        const statements = at.getCfg()?.getStmts() ?? [];
        const predecessors = new Map<Stmt, Stmt[]>();
        for (const stmt of statements) for (const successor of this.successors(stmt)) {
            const entries = predecessors.get(successor) ?? [];
            entries.push(stmt); predecessors.set(successor, entries);
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
        const declaration = value.getDeclaringStmt();
        if (!result.length && declaration instanceof ArkAssignStmt &&
            (declaration.getRightOp() instanceof ArkParameterRef || declaration.getRightOp() instanceof ArkThisRef)) result.push(declaration);
        return result;
    }
}
