import {
    ArkAssignStmt,
    ArkIfStmt,
    ArkInstanceFieldRef,
    ArkInstanceInvokeExpr,
    ArkParameterRef,
    ArkStaticFieldRef,
    ArkUnopExpr,
    BooleanConstant,
    Local,
    NullConstant,
    NumberConstant,
    RelationalBinaryOperator,
    Stmt,
    UndefinedConstant,
    UnaryOperator,
    type ArkMethod,
    type Scene,
    type Value,
} from '../../adapter/arkanalyzer';
import { resourceValueKey, type RegistrationIdentity } from './ResourceFact';
import { ListenerIdentity } from './ListenerIdentity';
import type { ReleaseOwner } from './OwnerBoundaryProblem';
import type { ResourceRule } from './rules/ResourceRule';

function tokenKey(value: Value | undefined): string | undefined {
    if (!value) return undefined;
    if (value instanceof ArkInstanceFieldRef && value.getBase().getName() === 'this') {
        return `this-field:${value.getFieldSignature().toString()}`;
    }
    return resourceValueKey(value);
}

/** Per-method listener cleanup summaries keyed by stable same-owner timer/event identities. */
export class ListenerCleanupSummary {
    private readonly ownerEndMethods = new Map<string, readonly ArkMethod[]>();
    private readonly timerRules: readonly ResourceRule[];
    private readonly eventRules: readonly ResourceRule[];
    private readonly methods: ReadonlyMap<string, ArkMethod>;
    private readonly identities: ListenerIdentity;
    private readonly cache = new Map<string, boolean>();
    private readonly checking = new Set<string>();

    constructor(
        private readonly scene: Scene,
        rules: readonly ResourceRule[],
        owners: readonly ReleaseOwner[],
        private readonly successors: (stmt: Stmt) => readonly Stmt[],
    ) {
        const methods = new Map(scene.getMethods().map(method => [method.getSignature().toString(), method]));
        this.methods = methods;
        for (const owner of owners) this.ownerEndMethods.set(owner.classSignature,
            owner.endMethods.flatMap(signature => methods.get(signature) ?? []));
        this.timerRules = rules.filter(rule =>
            rule.id === 'IntervalRegistration' || rule.id === 'TimeoutRegistration');
        this.eventRules = rules.filter(rule => !this.timerRules.includes(rule));
        this.identities = new ListenerIdentity(scene, successors);
    }

    clearsAtOwnerEnd(allocationSite: Stmt, handles: readonly Value[]): boolean {
        const method = allocationSite.getCfg()?.getDeclaringMethod();
        const classSignature = method?.getDeclaringArkClass().getSignature().toString();
        if (!classSignature) return false;
        const endMethods = this.ownerEndMethods.get(classSignature);
        if (!endMethods?.length) return false;
        const tokens = this.tokensAt(allocationSite, handles);
        if (tokens.length === 0) return false;
        for (const endMethod of endMethods) {
            if (tokens.some(token => {
                const key = tokenKey(token);
                return key !== undefined && this.methodClearsToken(endMethod, key);
            })) return true;
        }
        return false;
    }

    clearsBeforeAllocation(allocationSite: Stmt, handles: readonly Value[]): boolean {
        const method = allocationSite.getCfg()?.getDeclaringMethod();
        if (!method) return false;
        return this.tokensAt(allocationSite, handles).some(token => {
            const key = tokenKey(token);
            return key !== undefined && this.methodClearsTokenBefore(method, allocationSite, key);
        });
    }

    clearsEventAtOwnerEnd(allocationSite: Stmt, registration: RegistrationIdentity): boolean {
        if (!registration.event || registration.event === 'timer') return false;
        const method = allocationSite.getCfg()?.getDeclaringMethod();
        const classSignature = method?.getDeclaringArkClass().getSignature().toString();
        if (!classSignature) return false;
        const endMethods = this.ownerEndMethods.get(classSignature);
        if (!endMethods?.length) return false;
        return endMethods.some(endMethod => this.methodClearsEvent(endMethod, registration));
    }

    isPureForwardingRegistration(allocationSite: Stmt): boolean {
        const method = allocationSite.getCfg()?.getDeclaringMethod();
        const invoke = allocationSite.getInvokeExpr();
        if (!method || !invoke || !method.getCfg()) return false;
        const signature = invoke.getMethodSignature().toString();
        const contract = this.eventRules.find(rule => rule.allocators.some(allocator =>
            allocator.methodSignature === signature));
        const allocator = contract?.allocators.find(api => api.methodSignature === signature);
        if (!contract || !allocator || allocator.handleLocation.kind !== 'param') return false;
        const callback = invoke.getArgs()[allocator.handleLocation.index];
        if (!this.parameterDerived(callback)) return false;
        for (const stmt of method.getCfg()!.getStmts()) {
            if (!(stmt instanceof ArkAssignStmt)) continue;
            const left = stmt.getLeftOp();
            if ((left instanceof ArkInstanceFieldRef && left.getBase().getName() === 'this') ||
                left instanceof ArkStaticFieldRef) {
                return false;
            }
        }
        const classMethods = method.getDeclaringArkClass().getMethods();
        const paired = contract.releasers.some(releaser => classMethods.some(candidate =>
            candidate.getCfg()?.getStmts().some(stmt =>
                stmt.getInvokeExpr()?.getMethodSignature().toString() === releaser.methodSignature)));
        return paired;
    }

    isGuardedReentry(allocationSite: Stmt): boolean {
        const method = allocationSite.getCfg()?.getDeclaringMethod();
        const stmts = method?.getCfg()?.getStmts() ?? [];
        const targetIndex = stmts.indexOf(allocationSite);
        if (!method || targetIndex < 0) return false;
        for (const [assignIndex, stmt] of stmts.entries()) {
            if (assignIndex >= targetIndex || !(stmt instanceof ArkAssignStmt)) continue;
            const field = stmt.getLeftOp();
            const truth = this.booleanConstantValue(stmt.getRightOp());
            if (!(field instanceof ArkInstanceFieldRef) || field.getBase().getName() !== 'this' ||
                truth !== true) continue;
            const key = tokenKey(field);
            if (!key) continue;
            for (let guardIndex = 0; guardIndex < assignIndex; guardIndex++) {
                const guard = stmts[guardIndex];
                if (!(guard instanceof ArkIfStmt) || !this.conditionUsesToken(guard, key)) continue;
                const successors = this.successors(guard);
                if (successors.length !== 2) continue;
                const reaches = successors.map(successor =>
                    this.reachesWithinMethod(successor, allocationSite, method));
                if (reaches.filter(Boolean).length !== 1) continue;
                const reset = stmts.slice(assignIndex + 1, targetIndex).some(candidate =>
                    candidate instanceof ArkAssignStmt &&
                    tokenKey(candidate.getLeftOp()) === key &&
                    this.booleanConstantValue(candidate.getRightOp()) === false);
                if (!reset) return true;
            }
        }
        return false;
    }

    private tokensAt(allocationSite: Stmt, handles: readonly Value[]): Value[] {
        const method = allocationSite.getCfg()?.getDeclaringMethod();
        const tokens = [...handles];
        if (tokens.length === 0 && allocationSite instanceof ArkAssignStmt) {
            const aliases = new Set([resourceValueKey(allocationSite.getLeftOp())]);
            const statements = method?.getCfg()?.getStmts() ?? [];
            for (let changed = true; changed;) {
                changed = false;
                for (const stmt of statements) {
                    if (!(stmt instanceof ArkAssignStmt)) continue;
                    const left = stmt.getLeftOp();
                    if (!aliases.has(resourceValueKey(stmt.getRightOp()))) continue;
                    const key = resourceValueKey(left);
                    if (!aliases.has(key)) {
                        aliases.add(key);
                        changed = true;
                    }
                    if ((left instanceof ArkInstanceFieldRef || left instanceof ArkStaticFieldRef) &&
                        !tokens.some(token => tokenKey(token) === tokenKey(left))) tokens.push(left);
                }
            }
        }
        return tokens;
    }

    methodClearsToken(method: ArkMethod, token: string): boolean {
        const key = `${method.getSignature().toString()}|${token}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) return cached;
        if (this.checking.has(key)) return false;
        const cfg = method.getCfg();
        const entry = cfg?.getStartingStmt() ?? cfg?.getStartingBlock()?.getHead();
        if (!entry) {
            this.cache.set(key, false);
            return false;
        }
        this.checking.add(key);
        const pending: { stmt: Stmt; live: boolean }[] = [{ stmt: entry, live: true }];
        const visited = new Map<Stmt, Set<boolean>>();
        let clearsActiveToken = true;
        while (pending.length > 0) {
            const { stmt, live } = pending.pop()!;
            const states = visited.get(stmt) ?? new Set<boolean>();
            if (states.has(live)) continue;
            states.add(live);
            visited.set(stmt, states);
            const nextLive = live && !this.releasesToken(stmt, token);
            const next = this.successors(stmt);
            if (next.length === 0) {
                if (nextLive) {
                    clearsActiveToken = false;
                    break;
                }
                continue;
            }
            const invalidSuccessor = stmt instanceof ArkIfStmt
                ? this.invalidSuccessor(stmt, token)
                : undefined;
            for (const [index, successor] of next.entries()) {
                pending.push({ stmt: successor,
                    live: nextLive && successor !== invalidSuccessor });
            }
        }
        this.checking.delete(key);
        this.cache.set(key, clearsActiveToken);
        return clearsActiveToken;
    }

    private methodClearsTokenBefore(method: ArkMethod, target: Stmt, token: string): boolean {
        const key = `${method.getSignature().toString()}|before|${token}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) return cached;
        const cfg = method.getCfg();
        const entry = cfg?.getStartingStmt() ?? cfg?.getStartingBlock()?.getHead();
        if (!entry) return false;
        const pending: { stmt: Stmt; cleared: boolean }[] = [{ stmt: entry, cleared: false }];
        const visited = new Map<Stmt, Set<boolean>>();
        let reached = false;
        while (pending.length > 0) {
            const { stmt, cleared } = pending.pop()!;
            const states = visited.get(stmt) ?? new Set<boolean>();
            if (states.has(cleared)) continue;
            states.add(cleared);
            visited.set(stmt, states);
            if (stmt === target && !cleared) {
                this.cache.set(key, false);
                return false;
            }
            if (stmt === target) {
                reached = true;
                for (const successor of this.successors(stmt)) pending.push({ stmt: successor, cleared: false });
                continue;
            }
            const nextCleared = cleared || this.releasesToken(stmt, token);
            const next = this.successors(stmt);
            const invalidSuccessor = stmt instanceof ArkIfStmt
                ? this.invalidSuccessor(stmt, token)
                : undefined;
            for (const successor of next) {
                pending.push({ stmt: successor,
                    cleared: successor === invalidSuccessor ? true : nextCleared });
            }
        }
        this.cache.set(key, reached);
        return reached;
    }

    private methodClearsEvent(method: ArkMethod, registration: RegistrationIdentity): boolean {
        const key = `${method.getSignature().toString()}|event|${registration.event}|${registration.callback ?? '*'}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) return cached;
        if (this.checking.has(key)) return false;
        const cfg = method.getCfg();
        const entry = cfg?.getStartingStmt() ?? cfg?.getStartingBlock()?.getHead();
        if (!entry) return false;
        this.checking.add(key);
        const guardedTokens = new Set<string>();
        let foundDirectRelease = false;
        for (const stmt of cfg?.getStmts() ?? []) {
            if (!foundDirectRelease && stmt instanceof ArkAssignStmt) {
                const left = stmt.getLeftOp();
                if (left instanceof ArkInstanceFieldRef && left.getBase().getName() === 'this') {
                    const token = tokenKey(left);
                    if (token) guardedTokens.add(token);
                }
            }
            if (!this.matchesDirectEventRelease(stmt, registration)) continue;
            foundDirectRelease = true;
            const invoke = stmt.getInvokeExpr();
            if (invoke instanceof ArkInstanceInvokeExpr) {
                const base = tokenKey(invoke.getBase());
                if (base) guardedTokens.add(base);
            }
        }
        const pending: { stmt: Stmt; cleared: boolean }[] = [{ stmt: entry, cleared: false }];
        const visited = new Map<Stmt, Set<boolean>>();
        let clearsOnAllPaths = true;
        while (pending.length > 0) {
            const { stmt, cleared } = pending.pop()!;
            const states = visited.get(stmt) ?? new Set<boolean>();
            if (states.has(cleared)) continue;
            states.add(cleared);
            visited.set(stmt, states);
            const nextCleared = cleared || this.matchesEventRelease(stmt, registration);
            const next = this.successors(stmt);
            if (next.length === 0) {
                if (!nextCleared) {
                    clearsOnAllPaths = false;
                    break;
                }
                continue;
            }
            const invalidSuccessor = stmt instanceof ArkIfStmt
                ? this.invalidSuccessorForTokens(stmt, guardedTokens)
                : undefined;
            for (const successor of next) {
                pending.push({ stmt: successor,
                    cleared: successor === invalidSuccessor ? true : nextCleared });
            }
        }
        this.checking.delete(key);
        this.cache.set(key, clearsOnAllPaths);
        return clearsOnAllPaths;
    }

    private releasesToken(stmt: Stmt, token: string): boolean {
        const invoke = stmt.getInvokeExpr();
        if (!invoke) return false;
        const signature = invoke.getMethodSignature().toString();
        if (this.timerRules.some(rule => rule.releasers.some(releaser =>
            releaser.methodSignature === signature)) && this.matchesToken(invoke.getArgs()[0], token)) {
            return true;
        }
        if (token.startsWith('this-field:') &&
            (!(invoke instanceof ArkInstanceInvokeExpr) || invoke.getBase().getName() !== 'this')) {
            return false;
        }
        const callee = this.methods.get(signature);
        return !!callee && this.methodClearsToken(callee, token);
    }

    private matchesEventRelease(stmt: Stmt, registration: RegistrationIdentity): boolean {
        if (this.matchesDirectEventRelease(stmt, registration)) return true;
        const invoke = stmt.getInvokeExpr();
        const method = stmt.getCfg()?.getDeclaringMethod();
        if (!invoke || !method) return false;
        const signature = invoke.getMethodSignature().toString();
        const callee = this.methods.get(signature);
        return !!callee &&
            callee.getDeclaringArkClass().getSignature().toString() ===
                method.getDeclaringArkClass().getSignature().toString() &&
            this.methodClearsEvent(callee, registration);
    }

    private matchesDirectEventRelease(stmt: Stmt, registration: RegistrationIdentity): boolean {
        const invoke = stmt.getInvokeExpr();
        if (!invoke) return false;
        const signature = invoke.getMethodSignature().toString();
        if (!this.eventRules.some(rule => rule.releasers.some(releaser =>
            releaser.methodSignature === signature))) return false;
        const event = this.identities.event(invoke.getArgs()[0], stmt);
        if (!event || event !== registration.event) return false;
        const callback = invoke.getArgs()[1];
        if (!callback) return true;
        const callbackIdentity = this.identities.resolve(callback, stmt);
        return !!registration.callback && callbackIdentity !== undefined &&
            callbackIdentity === registration.callback;
    }

    private invalidSuccessor(stmt: ArkIfStmt, token: string): Stmt | undefined {
        return this.invalidSuccessorForTokens(stmt, new Set([token]));
    }

    private invalidSuccessorForTokens(stmt: ArkIfStmt, tokens: ReadonlySet<string>): Stmt | undefined {
        const condition = stmt.getConditionExpr();
        let value: Value = condition.getOp1();
        let sentinel: Value = condition.getOp2();
        let operator = condition.getOperator();
        const reverse: Partial<Record<string, RelationalBinaryOperator>> = {
            '<': RelationalBinaryOperator.GreaterThan,
            '<=': RelationalBinaryOperator.GreaterThanOrEqual,
            '>': RelationalBinaryOperator.LessThan,
            '>=': RelationalBinaryOperator.LessThanOrEqual,
        };
        if (!this.matchesTokens(value, tokens)) {
            if (!this.matchesTokens(sentinel, tokens)) return undefined;
            [value, sentinel] = [sentinel, value];
            operator = reverse[operator] ?? operator;
        }
        let truth: boolean | undefined;
        if (sentinel instanceof NullConstant || sentinel instanceof UndefinedConstant) {
            const equal = operator === RelationalBinaryOperator.Equality ||
                operator === RelationalBinaryOperator.StrictEquality;
            const unequal = operator === RelationalBinaryOperator.InEquality ||
                operator === RelationalBinaryOperator.StrictInequality;
            truth = equal ? true : unequal ? false : undefined;
        } else {
            if (sentinel instanceof Local && /^%\d+$/.test(sentinel.getName())) {
                const declaration = sentinel.getDeclaringStmt();
                if (declaration instanceof ArkAssignStmt) sentinel = declaration.getRightOp();
            }
            const negative = sentinel instanceof ArkUnopExpr && sentinel.getOperator() === UnaryOperator.Neg;
            const literal = negative ? (sentinel as ArkUnopExpr).getOp() : sentinel;
            if (literal instanceof NumberConstant) {
                const number = Number(literal.getValue()) * (negative ? -1 : 1);
                const equal = operator === RelationalBinaryOperator.Equality ||
                    operator === RelationalBinaryOperator.StrictEquality;
                const unequal = operator === RelationalBinaryOperator.InEquality ||
                    operator === RelationalBinaryOperator.StrictInequality;
                if (number === -1) truth = equal ? true : unequal ? false : undefined;
                if (number === 0) {
                    if (operator === RelationalBinaryOperator.LessThan) truth = true;
                    if (operator === RelationalBinaryOperator.GreaterThanOrEqual) truth = false;
                }
            }
        }
        if (truth === undefined) return undefined;
        // ArkAnalyzer emits the true ArkIfStmt successor before the false successor.
        return this.successors(stmt)[truth ? 0 : 1];
    }

    private matchesToken(value: Value | undefined, token: string): boolean {
        return this.matchesTokens(value, new Set([token]));
    }

    private matchesTokens(value: Value | undefined, tokens: ReadonlySet<string>): boolean {
        let current = value;
        const seen = new Set<object>();
        for (let depth = 0; current && depth < 8 && !seen.has(current); depth++) {
            const key = tokenKey(current);
            if (key && tokens.has(key)) return true;
            if (!(current instanceof Local)) return false;
            seen.add(current);
            const declaration = current.getDeclaringStmt();
            current = declaration instanceof ArkAssignStmt ? declaration.getRightOp() : undefined;
        }
        return false;
    }

    private parameterDerived(value: Value): boolean {
        let current: Value | undefined = value;
        const seen = new Set<object>();
        for (let depth = 0; current && depth < 8 && !seen.has(current); depth++) {
            if (!(current instanceof Local)) return false;
            seen.add(current);
            const declaration = current.getDeclaringStmt();
            if (!(declaration instanceof ArkAssignStmt)) return false;
            const right = declaration.getRightOp();
            if (right instanceof ArkParameterRef) return true;
            current = right;
        }
        return false;
    }

    private booleanConstantValue(value: Value): boolean | undefined {
        if (!(value instanceof BooleanConstant)) return undefined;
        const text = String(value.getValue()).toLowerCase();
        return text === 'true' ? true : text === 'false' ? false : undefined;
    }

    private conditionUsesToken(stmt: ArkIfStmt, token: string): boolean {
        const seen = new Set<object>();
        const visit = (value: Value | null): boolean => {
            if (!value || seen.has(value)) return false;
            seen.add(value);
            if (tokenKey(value) === token) return true;
            if (value instanceof Local) {
                const declaration = value.getDeclaringStmt();
                if (declaration instanceof ArkAssignStmt && visit(declaration.getRightOp())) return true;
            }
            return value.getUses().some(visit);
        };
        const condition = stmt.getConditionExpr();
        return visit(condition.getOp1()) || visit(condition.getOp2());
    }

    private reachesWithinMethod(from: Stmt, target: Stmt, method: ArkMethod): boolean {
        const pending = [from];
        const visited = new Set<Stmt>();
        const methodSignature = method.getSignature().toString();
        while (pending.length > 0) {
            const stmt = pending.pop()!;
            if (stmt === target) return true;
            if (visited.has(stmt) ||
                stmt.getCfg()?.getDeclaringMethod().getSignature().toString() !== methodSignature) continue;
            visited.add(stmt);
            pending.push(...this.successors(stmt));
        }
        return false;
    }
}
