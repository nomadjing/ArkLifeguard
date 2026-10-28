import {
    ArkArrayRef, ArkAssignStmt, ArkAwaitExpr, ArkCastExpr, ArkDeleteExpr, ArkInstanceFieldRef,
    ArkInstanceInvokeExpr, ArkMethod, ArkNewArrayExpr, ArkNewExpr, ArkParameterRef, ArkPtrInvokeExpr,
    ArkReturnStmt, ArkStaticFieldRef, ArkThisRef, ArkThrowStmt, ArkIfStmt, ClosureFieldRef, ClosureType,
    Constant, FunctionType, GlobalRef, Local, NullConstant, Scene, Stmt, UndefinedConstant, Value, ts,
} from '../../adapter/arkanalyzer';
import { CfgIndex } from '../../ifds/icfg';
import { HeapState } from './HeapState';

export interface LifetimeBoundary {
    readonly classSignature: string;
    readonly endMethodSignatures: readonly string[];
}
export interface HeapFlowOptions {
    readonly lifetimes?: readonly LifetimeBoundary[];
    readonly maxCallDepth?: number;
    readonly maxStates?: number;
}
export interface HeapContext {
    readonly method: ArkMethod;
    readonly scope: string;
    readonly receiver: readonly string[];
    readonly args: readonly (readonly string[])[];
    readonly lifetimeOwner?: string;
}
export interface HeapFlowHooks<S extends HeapState> {
    invoke(stmt: Stmt, state: S, context: HeapContext, flow: HeapFlow<S>): boolean;
    boundary(exit: Stmt, state: S, context: HeapContext): void;
}
interface Frame { readonly call: Stmt; readonly context: HeapContext; }
interface Work<S> { readonly stmt: Stmt; readonly state: S; readonly context: HeapContext; readonly frames: readonly Frame[]; }
export interface HeapFlowRun {
    readonly success: boolean;
    readonly processedStates: number;
    readonly reachedStatements: number;
    readonly limitations: readonly string[];
}

/** Path-sensitive abstract interpretation over the existing statement CFG.
 * Heap updates are non-distributive, so this is deliberately not an IFDS problem.
 * API registration hooks own retention, never dispatch a callback as a synchronous call.
 */
export class HeapFlow<S extends HeapState> {
    private readonly cfg: CfgIndex;
    private readonly ids = new WeakMap<object, number>();
    private nextId = 1;
    private readonly ends = new Set<string>();
    private readonly ownerClasses = new Set<string>();
    private readonly limits = new Set<string>();
    private readonly lexicalThis = new WeakMap<ArkMethod, boolean>();
    constructor(private readonly scene: Scene, private readonly hooks: HeapFlowHooks<S>,
        private readonly options: HeapFlowOptions = {}) {
        this.cfg = new CfgIndex(scene);
        for (const lifetime of options.lifetimes ?? []) {
            this.ownerClasses.add(lifetime.classSignature);
            for (const method of lifetime.endMethodSignatures) this.ends.add(method);
        }
    }

    siteId(site: object): number {
        let id = this.ids.get(site);
        if (!id) { id = this.nextId++; this.ids.set(site, id); }
        return id;
    }

    run(entry: ArkMethod, initial: S): HeapFlowRun {
        for (const [name, value] of [['maxStates', this.options.maxStates], ['maxCallDepth', this.options.maxCallDepth]] as const) {
            if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer`);
        }
        this.cfg.initialize(entry);
        const start = entry.getCfg()?.getStartingBlock()?.getHead();
        if (!start) throw new Error('Retention analysis entry has no CFG');
        const symbols = new Map<string, number>();
        const encode = (value: string): number => {
            let id = symbols.get(value);
            if (id === undefined) { id = symbols.size + 1; symbols.set(value, id); }
            return id;
        };
        const context: HeapContext = { method: entry, scope: `entry:${encode(entry.getSignature().toString())}`, receiver: [], args: [] };
        const queue: Array<Work<S> | undefined> = [{ stmt: start, state: initial, context, frames: [] }];
        const signatures = new WeakMap<S, string>();
        const seen = new Set<string>();
        const reached = new Set<Stmt>();
        let processedStates = 0;
        let lifecycleBoundaries = 0;
        const enqueue = (stmt: Stmt, state: S, ctx: HeapContext, frames: readonly Frame[]): void => {
            queue.push({ stmt, state, context: ctx, frames });
        };
        for (let index = 0; index < queue.length; index++) {
            const work = queue[index]!;
            queue[index] = undefined;
            const { stmt, context: ctx, frames } = work;
            let signature = signatures.get(work.state);
            if (signature === undefined) {
                signature = work.state.signature(encode);
                signatures.set(work.state, signature);
            }
            const key = `${this.siteId(stmt)}|${encode(ctx.scope)}|${frames.map(frame => this.siteId(frame.call)).join(',')}|${signature}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (++processedStates > (this.options.maxStates ?? 20000)) {
                this.limits.add('state-budget-exceeded'); break;
            }
            reached.add(stmt);
            const state = work.state.clone() as S;
            if (stmt instanceof ArkIfStmt) state.uncertainties.add('branch-feasibility-not-modeled');
            for (const reason of state.uncertainties) this.limits.add(reason);
            // Exceptional successors use the PRE-statement heap: a throwing release/store
            // cannot be assumed to have completed.
            const exceptional = this.cfg.getExceptionalSuccessors(stmt);
            for (const handler of exceptional) enqueue(handler, work.state, ctx, frames);
            const invoke = stmt.getInvokeExpr();
            const handled = invoke ? this.hooks.invoke(stmt, state, ctx, this) || this.builtin(stmt, state, ctx) : false;
            if (invoke && !handled) {
                const callees = this.directCallees(stmt, state, ctx);
                if (callees.length && frames.length < (this.options.maxCallDepth ?? 4)) {
                    for (const callee of callees) {
                        const receiver = invoke instanceof ArkInstanceInvokeExpr ? this.read(invoke.getBase(), state, ctx) : [];
                        const owner = receiver.find(id => this.ownerClasses.has(state.objects.get(id)?.classSignature ?? ''));
                        const calleeContext: HeapContext = { method: callee,
                            scope: `${ctx.scope}>${this.siteId(stmt)}:${encode(callee.getSignature().toString())}`, receiver,
                            args: invoke.getArgs().map(arg => this.read(arg, state, ctx)),
                            lifetimeOwner: owner ?? ctx.lifetimeOwner };
                        enqueue(callee.getCfg()!.getStartingBlock()!.getHead()!, state.clone() as S,
                            calleeContext, [...frames, { call: stmt, context: ctx }]);
                    }
                    continue;
                }
                if (callees.length) { this.limits.add('call-depth-exceeded'); state.uncertainties.add('call-depth-exceeded'); }
                else if ([...invoke.getArgs(), ...(invoke instanceof ArkInstanceInvokeExpr ? [invoke.getBase()] : [])]
                    .some(arg => this.read(arg, state, ctx).some(id => state.objects.has(id)))) {
                    state.uncertainties.add('unknown-external-call');
                }
                if (stmt instanceof ArkAssignStmt) this.write(stmt.getLeftOp(),
                    [`unknown:${this.siteId(stmt)}:${ctx.scope}`], state, ctx, stmt);
            } else if (!invoke && stmt instanceof ArkAssignStmt) {
                const right = stmt.getRightOp();
                const values = right instanceof ArkParameterRef ? ctx.args[right.getIndex()] ?? []
                    : right instanceof ArkThisRef ? ctx.receiver : this.read(right, state, ctx, stmt);
                this.write(stmt.getLeftOp(), values, state, ctx, stmt);
            }
            if (this.cfg.isExitStatement(stmt)) {
                if (this.ends.has(ctx.method.getSignature().toString()) && !(stmt instanceof ArkThrowStmt)) {
                    for (const owner of ctx.receiver) state.endedOwners.set(owner, stmt);
                    lifecycleBoundaries++;
                    this.hooks.boundary(stmt, state, ctx);
                }
                const frame = frames.at(-1);
                if (!frame) continue;
                if (stmt instanceof ArkThrowStmt) {
                    const handlers = this.cfg.getExceptionalSuccessors(frame.call);
                    for (const handler of handlers) enqueue(handler, state, frame.context, frames.slice(0, -1));
                    if (!handlers.length) this.limits.add('unhandled-exception-path');
                } else {
                    const value = stmt instanceof ArkReturnStmt ? this.read(stmt.getOp(), state, ctx) : [];
                    if (frame.call instanceof ArkAssignStmt) this.write(frame.call.getLeftOp(), value, state, frame.context, frame.call);
                    for (const successor of this.cfg.getNormalSuccessors(frame.call)) enqueue(successor,
                        state, frame.context, frames.slice(0, -1));
                }
                continue;
            }
            // Queued states are immutable snapshots. Each consumer clones before transfer,
            // so sibling edges can share one snapshot without sharing mutable branch state.
            for (const successor of this.cfg.getNormalSuccessors(stmt)) enqueue(successor, state, ctx, frames);
        }
        if (!lifecycleBoundaries) this.limits.add('no-observed-lifecycle-end');
        return { success: !this.limits.has('state-budget-exceeded') && !this.limits.has('call-depth-exceeded'),
            processedStates, reachedStatements: reached.size, limitations: [...this.limits].sort() };
    }

    localSlot(value: Local, ctx: HeapContext): string {
        return `local:${ctx.scope}:${value.getName()}`;
    }

    read(value: Value, state: S, ctx: HeapContext, site?: Stmt): readonly string[] {
        if (value instanceof ArkCastExpr) return this.read(value.getOp(), state, ctx, site);
        if (value instanceof ArkAwaitExpr) return this.read(value.getPromise(), state, ctx, site);
        if (value instanceof NullConstant || value instanceof UndefinedConstant) return [];
        if (value instanceof Constant) return [`constant:${value.getType()}:${value.toString()}`];
        if (value instanceof ArkNewExpr || value instanceof ArkNewArrayExpr) {
            if (!site) return [];
            const type = value instanceof ArkNewExpr ? value.getClassType() : undefined;
            const id = `object:${this.siteId(site)}:${ctx.scope}`;
            if (state.objects.has(id)) state.uncertainties.add('repeated-allocation-site');
            state.objects.set(id, { id, kind: 'object', label: type?.getClassSignature().getClassName() ?? 'Array',
                allocation: site, classSignature: type?.getClassSignature().toString(),
                lifetimeOwner: this.ends.has(ctx.method.getSignature().toString()) ? undefined : ctx.lifetimeOwner });
            return [id];
        }
        if (value instanceof ArkDeleteExpr) { this.write(value.getField(), [], state, ctx, site); return []; }
        const slots = this.slots(value, state, ctx);
        const values = [...new Set(slots.flatMap(slot => state.slots.get(slot) ?? []))];
        if (values.length) return values;
        // An explicitly cleared function binding is not a fresh function literal.
        if (slots.length && slots.every(slot => state.initializedSlots.has(slot))) return [];
        const type = value.getType();
        if (type instanceof FunctionType) {
            const signature = type.getMethodSignature();
            const callback = this.scene.getMethod(signature);
            if (!callback?.getCfg()) {
                state.uncertainties.add('unknown-callback-identity');
                return [`unknown:${signature}:${ctx.scope}`];
            }
            const contextual = type instanceof ClosureType || !!callback?.getOuterMethod() || callback?.getName().startsWith('%');
            const id = `closure:${signature}:${contextual ? ctx.scope : 'declaration'}`;
            if (!state.objects.has(id) && (site ?? callback?.getCfg()?.getStartingBlock()?.getHead())) {
                const allocation = site ?? callback!.getCfg()!.getStartingBlock()!.getHead()!;
                if (!callback?.getCode()) state.uncertainties.add('callback-capture-source-unavailable');
                state.objects.set(id, { id, kind: 'closure', label: signature.toString(), allocation,
                    lifetimeOwner: ctx.lifetimeOwner });
                if (callback && this.capturesLexicalThis(callback)) {
                    state.set(`field:${id}:capture:this`, ctx.receiver, allocation);
                }
                const captures = type instanceof ClosureType ? type.getLexicalEnv().getClosures() : [];
                for (const capture of captures) {
                    state.set(`field:${id}:capture:${capture.getName()}`, [`ref:${this.localSlot(capture, ctx)}`], allocation);
                }
                // ArkAnalyzer may retain globals instead of a ClosureType in lowered callbacks.
                for (const [name, captured] of callback?.getBody()?.getUsedGlobals() ?? []) {
                    if (captured instanceof Local) state.set(`field:${id}:capture:${name}`,
                        [`ref:${this.localSlot(captured, ctx)}`], allocation);
                    else if (captured instanceof ClosureFieldRef) state.set(`field:${id}:capture:${name}`,
                        [`ref:local:${ctx.scope}:${captured.getFieldName()}`], allocation);
                }
            }
            return [id];
        }
        return [];
    }

    /** IR uses an ordinary FunctionType for some arrows. Recover ONLY lexical-this
     * semantics from the callback AST; ordinary functions have dynamic receivers. */
    private capturesLexicalThis(method: ArkMethod): boolean {
        const cached = this.lexicalThis.get(method);
        if (cached !== undefined) return cached;
        const source = ts.createSourceFile('callback.ts', `const callback = (${method.getCode() ?? ''});`,
            ts.ScriptTarget.Latest, true);
        let initializer = ts.isVariableStatement(source.statements[0])
            ? source.statements[0].declarationList.declarations[0]?.initializer : undefined;
        while (initializer && ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
        let found = false;
        const visit = (node: ts.Node): void => {
            if (node.kind === ts.SyntaxKind.ThisKeyword) found = true;
            if ((ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node)) return;
            ts.forEachChild(node, visit);
        };
        if (initializer && ts.isArrowFunction(initializer)) visit(initializer.body);
        this.lexicalThis.set(method, found);
        return found;
    }

    write(value: Value, values: readonly string[], state: S, ctx: HeapContext, site?: Stmt): void {
        const slots = this.slots(value, state, ctx);
        for (const slot of slots) {
            state.set(slot, values, site, slots.length > 1 || state.uncertainties.has('repeated-allocation-site'));
            if (slot.startsWith('static:') || slot.startsWith('global:')) state.roots.add(slot);
        }
    }

    private slots(value: Value, state: S, ctx: HeapContext): string[] {
        if (value instanceof Local) return [this.localSlot(value, ctx)];
        if (value instanceof ArkStaticFieldRef) return [`static:${value.getFieldSignature()}`];
        if (value instanceof GlobalRef) {
            const ref = value.getRef();
            return ref instanceof Local ? [`global:${ref.getSignature() ?? value.getName()}`] : [`global:${value.getName()}`];
        }
        if (value instanceof ArkInstanceFieldRef) return this.read(value.getBase(), state, ctx)
            .map(base => `field:${base}:${value.getFieldSignature().getFieldName()}`);
        if (value instanceof ArkArrayRef) return this.read(value.getBase(), state, ctx)
            .map(base => `field:${base}:index:${value.getIndex().toString()}`);
        if (value instanceof ClosureFieldRef) return [`local:${ctx.scope}:${value.getFieldName()}`];
        return [];
    }

    private directCallees(stmt: Stmt, state: S, ctx: HeapContext): ArkMethod[] {
        const invoke = stmt.getInvokeExpr()!;
        if (invoke instanceof ArkPtrInvokeExpr) {
            const methods = this.read(invoke.getFuncPtrLocal(), state, ctx).flatMap(id => {
                const label = state.objects.get(id)?.label;
                return this.scene.getMethods().filter(method => method.getSignature().toString() === label && method.getCfg());
            });
            return methods;
        }
        const exact = this.scene.getMethod(invoke.getMethodSignature());
        if (exact?.getCfg()) return [exact];
        return this.scene.getMethods().filter(method => method.getCfg() &&
            method.getDeclaringArkClass().getSignature().toString() === invoke.getMethodSignature().getDeclaringClassSignature().toString() &&
            method.getName() === invoke.getMethodSignature().getMethodSubSignature().getMethodName());
    }

    private builtin(stmt: Stmt, state: S, ctx: HeapContext): boolean {
        const invoke = stmt.getInvokeExpr()!;
        const method = invoke.getMethodSignature().getMethodSubSignature().getMethodName();
        const receiver = invoke instanceof ArkInstanceInvokeExpr ? this.read(invoke.getBase(), state, ctx) : [];
        const args = invoke.getArgs().map(arg => this.read(arg, state, ctx, stmt));
        if (method === 'bind' && receiver.some(id => state.objects.get(id)?.kind === 'closure')) {
            const id = `closure:bound:${this.siteId(stmt)}:${ctx.scope}`;
            state.objects.set(id, { id, kind: 'closure', label: 'bound function', allocation: stmt, lifetimeOwner: ctx.lifetimeOwner });
            state.set(`field:${id}:bound-this`, args[0] ?? [], stmt);
            state.set(`field:${id}:bound-function`, receiver, stmt);
            if (stmt instanceof ArkAssignStmt) this.write(stmt.getLeftOp(), [id], state, ctx, stmt);
            return true;
        }
        for (const id of receiver) {
            const object = state.objects.get(id);
            const type = invoke.getMethodSignature().getDeclaringClassSignature();
            const builtIn = ['built-in', '@built-in', 'test-sdk'].includes(type.getDeclaringFileSignature().getProjectName()) ||
                type.getDeclaringFileSignature().getFileName().includes('lib.es');
            if (!builtIn || !object) continue;
            if (method === 'construct-signature' || method === 'constructor') {
                if (object.label.startsWith('Weak')) {
                    state.objects.set(id, { ...object, kind: 'weak' });
                    state.set(`field:${id}:[[weak]]:target`, args[0] ?? [], stmt);
                    if (object.label !== 'WeakRef') state.uncertainties.add('weak-collection-ephemerons-not-modeled');
                }
                if (stmt instanceof ArkAssignStmt) this.write(stmt.getLeftOp(), receiver, state, ctx, stmt);
                return true;
            }
            if (['Map', 'Set', 'Array', 'WeakMap', 'WeakSet', 'WeakRef'].includes(object.label)) {
                const weak = object.label.startsWith('Weak');
                const prefix = `field:${id}:${weak ? '[[weak]]' : 'entry'}:`;
                if (method === 'set' || method === 'add' || method === 'push') {
                    const key = (args[0] ?? []).join(',') || `unknown:${this.siteId(stmt)}`;
                    state.set(`${prefix}${key}`, args.flat(), stmt, method === 'push' || method === 'add');
                    if (weak) state.uncertainties.add('weak-collection-ephemerons-not-modeled');
                    if (stmt instanceof ArkAssignStmt) this.write(stmt.getLeftOp(), method === 'push'
                        ? [`unknown:${this.siteId(stmt)}:array-length`] : receiver, state, ctx, stmt);
                    return true;
                }
                if (method === 'clear') {
                    for (const slot of [...state.slots.keys()]) if (slot.startsWith(prefix)) state.slots.delete(slot);
                    return true;
                }
                if (method === 'delete' && (args[0] ?? []).length === 1) { state.slots.delete(`${prefix}${args[0][0]}`); return true; }
                if (method === 'constructor' && weak) { state.set(`field:${id}:[[weak]]:target`, args[0] ?? [], stmt); return true; }
            }
        }
        return false;
    }
}
