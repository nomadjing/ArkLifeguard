import {
    addCfg2Stmt,
    ArkAssignStmt,
    ArkAliasTypeDefineStmt,
    ArkCaughtExceptionRef,
    ArkIfStmt,
    ArkInvokeStmt,
    ArkMethod,
    ArkReturnStmt,
    ArkReturnVoidStmt,
    ArkThrowStmt,
    BasicBlock,
    Local,
    Scene,
    Stmt,
} from '../../adapter/arkanalyzer';
import { ExceptionPolicy } from './ExceptionPolicy';

interface StmtSuccessors {
    normal: Set<Stmt>;
    exceptional: Set<Stmt>;
}

interface FinallyRegion {
    handler: Stmt;
    blocks: Set<BasicBlock>;
    protectedBlocks: Set<BasicBlock>;
    rethrow: Stmt;
}

/** Builds and queries a statement-level view of ArkAnalyzer CFGs. */
export class CfgIndex {
    private readonly stmtSuccessors = new Map<Stmt, StmtSuccessors>();
    private readonly exceptionPolicy: ExceptionPolicy;

    constructor(private readonly scene: Scene) {
        this.exceptionPolicy = new ExceptionPolicy(scene);
    }

    initialize(entryMethod: ArkMethod): void {
        this.stmtSuccessors.clear();
        this.attachCfgToStatements();

        // Scene.getMethods() may expose the Scene's backing array. Mutating it
        // would make later solvers observe repeated synthetic entries.
        const methods = new Set([...this.scene.getMethods(), entryMethod]);
        for (const method of methods) {
            const blocks = Array.from(method.getCfg()?.getBlocks() ?? []);
            for (const block of blocks) {
                this.indexBlock(block);
            }
            this.repairFinallyAndCopiedHandlerEdges(method, blocks);
        }
    }

    getNormalSuccessors(stmt: Stmt): readonly Stmt[] {
        return Array.from(this.stmtSuccessors.get(stmt)?.normal ?? []);
    }

    getExceptionalSuccessors(stmt: Stmt): readonly Stmt[] {
        return this.mayThrow(stmt) ? this.getExceptionHandlers(stmt) : [];
    }

    getHandlerContinuation(handler: Stmt): Stmt {
        if (handler.getUses().some(value => value instanceof ArkCaughtExceptionRef)) {
            return this.getNormalSuccessors(handler)[0] ?? handler;
        }
        return handler;
    }

    mayThrow(stmt: Stmt): boolean {
        return this.exceptionPolicy.mayThrow(stmt);
    }

    isExitStatement(stmt: Stmt): boolean {
        if (stmt instanceof ArkThrowStmt) {
            return this.getExceptionalSuccessors(stmt).length === 0;
        }
        if (stmt instanceof ArkReturnStmt || stmt instanceof ArkReturnVoidStmt) {
            return this.getNormalSuccessors(stmt).length === 0;
        }
        return false;
    }

    getReturnSiteOfCall(call: Stmt): Stmt | null {
        return this.getNormalSuccessors(call)[0] ?? null;
    }

    getExceptionalReturnSitesOfCall(call: Stmt): readonly Stmt[] {
        // A real callee throw must still find the caller's catch even when the
        // call itself has no declared pre-entry failure.
        return this.getExceptionHandlers(call);
    }

    private getExceptionHandlers(stmt: Stmt): readonly Stmt[] {
        return Array.from(this.stmtSuccessors.get(stmt)?.exceptional ?? []);
    }

    getStartPointOf(method: ArkMethod): Stmt | null {
        return method.getCfg()?.getStartingBlock()?.getStmts()[method.getParameters().length] ?? null;
    }

    getStartPointOfCaller(call: Stmt): Stmt | null {
        const method = call.getCfg()?.getDeclaringMethod();
        return method ? this.getStartPointOf(method) : null;
    }

    private attachCfgToStatements(): void {
        for (const cls of this.scene.getClasses()) {
            for (const method of cls.getMethods(true)) {
                addCfg2Stmt(method);
            }
        }
    }

    private indexBlock(block: BasicBlock): void {
        const stmts = block.getStmts();
        const normalBlockSuccessors = this.collectSuccessorHeads(block.getSuccessors());
        const exceptionalBlockSuccessors = this.collectSuccessorHeads(
            block.getExceptionalSuccessorBlocks() ?? []
        );

        for (let stmtIndex = 0; stmtIndex < stmts.length; stmtIndex++) {
            const stmt = stmts[stmtIndex];
            if (!stmt) continue;

            const normal = new Set<Stmt>();
            const exceptional = new Set<Stmt>();
            if (stmt instanceof ArkThrowStmt) {
                for (const successor of exceptionalBlockSuccessors) exceptional.add(successor);
            } else if (stmt instanceof ArkReturnStmt || stmt instanceof ArkReturnVoidStmt) {
                // ArkAnalyzer may leave a synthetic rethrow after a return in
                // finally. The return overrides that exceptional completion.
            } else if (stmtIndex !== stmts.length - 1) {
                const nextStmt = stmts[stmtIndex + 1];
                if (nextStmt) normal.add(nextStmt);
            } else {
                for (const successor of normalBlockSuccessors) normal.add(successor);
            }
            if (this.mayThrow(stmt) || stmt.getInvokeExpr()) {
                for (const successor of exceptionalBlockSuccessors) exceptional.add(successor);
            }
            this.stmtSuccessors.set(stmt, { normal, exceptional });
        }
    }

    private collectSuccessorHeads(blocks: readonly BasicBlock[]): Set<Stmt> {
        const result = new Set<Stmt>();
        for (const block of blocks) {
            for (const head of this.getFirstStatements(block)) result.add(head);
        }
        return result;
    }

    private getFirstStatements(block: BasicBlock, visited = new Set<BasicBlock>()): Set<Stmt> {
        if (visited.has(block)) return new Set();
        visited.add(block);
        const head = block.getHead();
        if (head) return new Set([head]);
        const result = new Set<Stmt>();
        for (const successor of block.getSuccessors()) {
            for (const stmt of this.getFirstStatements(successor, visited)) result.add(stmt);
        }
        return result;
    }

    /** Recover lowered finally paths without turning pending returns into void returns. */
    private repairFinallyAndCopiedHandlerEdges(method: ArkMethod, blocks: BasicBlock[]): void {
        const traps = method.getBody()?.getTraps() ?? [];
        if (traps.length === 0) return;

        const sourceCopies = new Map<string, Stmt[]>();
        for (const block of blocks) {
            for (const stmt of block.getStmts()) {
                const key = this.getSourceStatementKey(stmt);
                if (!key) continue;
                const copies = sourceCopies.get(key) ?? [];
                copies.push(stmt);
                sourceCopies.set(key, copies);
            }
        }

        // Block edges may omit explicit throws or include several enclosing
        // handlers. A completion must enter the nearest handler first.
        for (const block of blocks) {
            const trap = traps.find(candidate => candidate.getTryBlocks().includes(block));
            const handler = trap?.getCatchBlocks()[0]?.getHead();
            if (!handler) continue;
            for (const stmt of block.getStmts()) {
                if (this.mayThrow(stmt) || stmt.getInvokeExpr()) this.stmtSuccessors.get(stmt)!.exceptional = new Set([handler]);
            }
        }
        // Lowered finally copies are not always listed in an outer trap's try
        // range. Exceptions in them still continue to that enclosing handler.
        traps.forEach((trap, index) => {
            const outer = traps.slice(index + 1).find(candidate =>
                candidate.getTryBlocks().some(block => trap.getTryBlocks().includes(block)));
            const handler = outer?.getCatchBlocks()[0]?.getHead();
            if (!handler) return;
            for (const block of trap.getCatchBlocks()) {
                for (const stmt of block.getStmts()) {
                    if ((this.mayThrow(stmt) || stmt.getInvokeExpr()) && this.getExceptionHandlers(stmt).length === 0) {
                        this.stmtSuccessors.get(stmt)!.exceptional.add(handler);
                    }
                }
            }
        });

        // A copied exceptional-finally statement inherits handlers available on
        // its source-backed counterpart.
        for (const copies of sourceCopies.values()) {
            const inherited = new Set<Stmt>();
            const sourceBacked = copies.filter(stmt => stmt.getOriginalText() !== undefined);
            const syntheticCopies = copies.filter(stmt => stmt.getOriginalText() === undefined);
            if (sourceBacked.length === 0 || syntheticCopies.length === 0) continue;
            for (const stmt of sourceBacked) {
                for (const target of this.getExceptionHandlers(stmt)) inherited.add(target);
            }
            if (inherited.size === 0) continue;
            for (const stmt of syntheticCopies) {
                if (!this.mayThrow(stmt) && !stmt.getInvokeExpr()) continue;
                const successors = this.stmtSuccessors.get(stmt);
                if (!successors) continue;
                for (const target of inherited) successors.exceptional.add(target);
            }
        }

        const regions: FinallyRegion[] = [];
        for (const trap of traps) {
            const handler = trap.getCatchBlocks()[0]?.getHead();
            if (!handler?.getUses().some(value => value instanceof ArkCaughtExceptionRef)) continue;
            const caught = handler.getDef();
            const rethrow = trap.getCatchBlocks().flatMap(block => block.getStmts()).find(stmt =>
                stmt instanceof ArkThrowStmt && stmt.getOp() === caught && stmt.getOriginalText() === undefined);
            if (!rethrow) continue;
            const protectedBlocks = new Set(trap.getTryBlocks());
            // try/catch/finally lowers to a finally trap covering the catch,
            // plus an inner trap whose protected returns also require finally.
            let changed = true;
            while (changed) {
                changed = false;
                for (const inner of traps) {
                    if (!inner.getCatchBlocks().some(block => protectedBlocks.has(block))) continue;
                    for (const block of inner.getTryBlocks()) {
                        if (protectedBlocks.has(block)) continue;
                        protectedBlocks.add(block);
                        changed = true;
                    }
                }
            }
            regions.push({ handler, blocks: new Set(trap.getCatchBlocks()), protectedBlocks, rethrow });
        }

        let temporary = 0;
        const completion = (source: ArkReturnStmt | ArkReturnVoidStmt, pending: FinallyRegion[]): Stmt => {
            // Evaluate the return operand before finally can reassign its local.
            const terminal = source instanceof ArkReturnStmt
                ? new ArkReturnStmt(source.getOp()) : new ArkReturnVoidStmt();
            this.copyPosition(source, terminal);
            this.stmtSuccessors.set(terminal, { normal: new Set(), exceptional: new Set() });
            let snapshot: ArkAssignStmt | undefined;
            if (terminal instanceof ArkReturnStmt) {
                const value = new Local(`%finallyReturn${temporary++}`, terminal.getOp().getType());
                snapshot = new ArkAssignStmt(value, terminal.getOp());
                this.copyPosition(source, snapshot);
                value.setDeclaringStmt(snapshot);
                terminal.setReturnValue(value);
            }
            let next: Stmt = terminal;
            // Clone each finally for this completion so different returns never
            // share a dispatcher that could resume the wrong value/exit kind.
            for (let i = pending.length - 1; i >= 0; i--) {
                const region = pending[i];
                const copies = new Map<Stmt, Stmt>([[region.rethrow, next]]);
                for (const block of region.blocks) {
                    for (const stmt of block.getStmts()) {
                        if (stmt === region.handler || stmt === region.rethrow) continue;
                        const copy = this.copyFinallyStatement(stmt);
                        copies.set(stmt, copy);
                        this.stmtSuccessors.set(copy, { normal: new Set(), exceptional: new Set() });
                    }
                }
                for (const [stmt, copy] of copies) {
                    if (stmt === region.rethrow) continue;
                    const successors = this.stmtSuccessors.get(copy)!;
                    if (stmt instanceof ArkReturnStmt || stmt instanceof ArkReturnVoidStmt) {
                        // A return in finally replaces the pending completion,
                        // but still executes any enclosing finally regions.
                        successors.normal.add(completion(stmt, pending.slice(i + 1)));
                    } else {
                        for (const target of this.getNormalSuccessors(stmt)) {
                            successors.normal.add(copies.get(target) ?? target);
                        }
                    }
                    for (const target of this.getExceptionHandlers(stmt)) {
                        successors.exceptional.add(copies.get(target) ?? target);
                    }
                }
                const entry = this.getHandlerContinuation(region.handler);
                next = copies.get(entry) ?? next;
            }
            if (!snapshot) return next;
            this.stmtSuccessors.set(snapshot, { normal: new Set([next]), exceptional: new Set() });
            return snapshot;
        };

        for (const block of blocks) {
            const tail = block.getTail();
            if (!(tail instanceof ArkReturnStmt) && !(tail instanceof ArkReturnVoidStmt)) continue;
            const pending = regions.filter(region => region.protectedBlocks.has(block));
            if (!pending.length) continue;
            this.stmtSuccessors.set(tail, {
                normal: new Set([completion(tail, pending)]), exceptional: new Set(),
            });
        }
    }

    private copyFinallyStatement(stmt: Stmt): Stmt {
        let copy: Stmt;
        if (stmt instanceof ArkAssignStmt) copy = new ArkAssignStmt(stmt.getLeftOp(), stmt.getRightOp());
        else if (stmt instanceof ArkInvokeStmt) copy = new ArkInvokeStmt(stmt.getInvokeExpr());
        else if (stmt instanceof ArkIfStmt) copy = new ArkIfStmt(stmt.getConditionExpr());
        else if (stmt instanceof ArkReturnStmt) copy = new ArkReturnStmt(stmt.getOp());
        else if (stmt instanceof ArkReturnVoidStmt) copy = new ArkReturnVoidStmt();
        else if (stmt instanceof ArkThrowStmt) copy = new ArkThrowStmt(stmt.getOp());
        else if (stmt instanceof ArkAliasTypeDefineStmt) copy = new ArkAliasTypeDefineStmt(stmt.getAliasType(), stmt.getAliasTypeExpr());
        else throw new Error(`Unsupported finally statement: ${stmt.constructor.name}`);
        this.copyPosition(stmt, copy);
        return copy;
    }

    private copyPosition(source: Stmt, target: Stmt): void {
        target.setCfg(source.getCfg());
        const position = source.getOriginFullPosition();
        if (position) target.setOriginFullPosition(position);
    }

    private getSourceStatementKey(stmt: Stmt): string | null {
        if (stmt.getUses().some(value => value instanceof ArkCaughtExceptionRef)) return null;
        return `${stmt.constructor.name}:${stmt.toString()}`;
    }
}
