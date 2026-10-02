import {
    ArkInstanceFieldRef,
    ArkMethod,
    ArkReturnStmt,
    ArkReturnVoidStmt,
    ArkThrowStmt,
    Scene,
    Stmt,
} from '../../adapter/arkanalyzer';
import { DataflowSolver } from '../../ifds/DataflowSolver';
import { ResourceFact, hasResourceHandle } from './ResourceFact';
import { ResourceProblem } from './ResourceProblem';
import type {
    ResourceAnalysisResult,
    ResourceDiagnostic,
    ResourceLeakReason,
    ResourceLocation,
} from './ResourceResult';
import type { ResourceRule } from './rules/ResourceRule';

class ResourceSolver extends DataflowSolver<ResourceFact> {}

interface ExitFact {
    readonly fact: ResourceFact;
    readonly exit: Stmt;
}

/** Independent resource-leak engine; rules are injected until the HomeFlow rule matrix lands. */
export class ResourceRunner {
    constructor(
        private readonly scene: Scene,
        private readonly rules: readonly ResourceRule[] = [],
    ) {}

    runWithDummyMain(dummyMain: ArkMethod): ResourceAnalysisResult {
        const entryMethod = dummyMain.getSignature().toString();
        if (this.rules.length === 0) {
            return {
                status: 'not-implemented',
                success: false,
                entryMethod,
                ruleIds: [],
                diagnostics: [],
                error: '新资源分析尚未配置规则；请选择 legacy 引擎。',
            };
        }
        try {
            const cfg = dummyMain.getCfg();
            const entry = cfg?.getStartingStmt() ?? cfg?.getStartingBlock()?.getHead();
            if (!entry) throw new Error('资源分析入口没有 CFG 语句');
            const problem = new ResourceProblem(entry, dummyMain, this.rules);
            const solver = new ResourceSolver(problem, this.scene);
            solver.solve();
            const byStatement = new Map<Stmt, ResourceFact[]>();
            for (const edge of solver.getPathEdgeSet()) {
                const statement = edge.edgeEnd.node;
                const facts = byStatement.get(statement) ?? [];
                facts.push(edge.edgeEnd.fact);
                byStatement.set(statement, facts);
            }
            return {
                status: 'success',
                success: true,
                entryMethod,
                ruleIds: this.rules.map(rule => rule.id),
                diagnostics: this.collectDiagnostics(byStatement, dummyMain),
                reachedStatements: byStatement.size,
                reachedFacts: [...byStatement.values()].reduce((sum, facts) => sum + facts.length, 0),
            };
        } catch (error) {
            return {
                status: 'failed',
                success: false,
                entryMethod,
                ruleIds: this.rules.map(rule => rule.id),
                diagnostics: [],
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private collectDiagnostics(
        byStatement: ReadonlyMap<Stmt, readonly ResourceFact[]>,
        entryMethod: ArkMethod,
    ): ResourceDiagnostic[] {
        const groups = new Map<string, ExitFact[]>();
        const ids = new Map<Stmt, number>();
        const siteId = (site: Stmt): number => {
            let id = ids.get(site);
            if (!id) {
                id = ids.size + 1;
                ids.set(site, id);
            }
            return id;
        };
        for (const [exit, facts] of byStatement) {
            if (!(exit instanceof ArkReturnStmt || exit instanceof ArkReturnVoidStmt ||
                exit instanceof ArkThrowStmt)) continue;
            const method = exit.getCfg()?.getDeclaringMethod();
            if (!method) continue;
            for (const fact of facts) {
                if (fact.isZero() || !fact.allocationSite || fact.frames.length > 0) continue;
                if (this.transferredAtExit(exit, fact, method !== entryMethod)) continue;
                const key = `${fact.ruleId}|${siteId(fact.allocationSite)}|${method.getSignature()}`;
                const group = groups.get(key) ?? [];
                group.push({ fact, exit });
                groups.set(key, group);
            }
        }
        const diagnostics: ResourceDiagnostic[] = [];
        for (const group of groups.values()) {
            const leaks = group.filter(item => item.fact.state === 'allocated');
            const unknowns = group.filter(item => item.fact.state === 'unknown');
            if (leaks.length === 0 && unknowns.length === 0) continue;
            const chosen = leaks[0] ?? unknowns[0];
            const { fact, exit } = chosen;
            const partiallyReleased = leaks.length > 0 &&
                group.some(item => item.fact.state === 'released');
            const reason: ResourceLeakReason = partiallyReleased
                ? 'partially-released'
                : fact.state === 'unknown'
                    ? 'unknown-ownership'
                    : fact.event === 'overwritten'
                        ? 'overwritten'
                        : fact.event === 'wrong-release'
                            ? 'wrong-release'
                            : 'unreleased';
            const allocation = this.location(fact.allocationSite!);
            const boundary = this.location(exit);
            const evidence = [allocation];
            if (fact.eventSite) evidence.push(this.location(fact.eventSite));
            evidence.push(boundary);
            diagnostics.push({
                ruleId: fact.ruleId,
                allocation,
                boundary,
                reason,
                confidence: reason === 'unknown-ownership' ? 'low' : 'high',
                evidence,
            });
        }
        return diagnostics.sort((left, right) =>
            `${left.ruleId}:${left.allocation.filePath}:${left.allocation.line}`.localeCompare(
                `${right.ruleId}:${right.allocation.filePath}:${right.allocation.line}`));
    }

    private transferredAtExit(exit: Stmt, fact: ResourceFact, nonRoot: boolean): boolean {
        if (exit instanceof ArkReturnStmt && hasResourceHandle(fact.handles, exit.getOp())) {
            return true;
        }
        // A receiver field stays owned by the containing object. The caller's
        // continuation will decide whether it is eventually released.
        return nonRoot && fact.handles.some(handle => handle instanceof ArkInstanceFieldRef &&
            handle.getBase().toString() === 'this');
    }

    private location(stmt: Stmt): ResourceLocation {
        const method = stmt.getCfg()?.getDeclaringMethod();
        const position = stmt.getOriginPositionInfo();
        const fallback = method?.getCfg()?.getStmts().filter(candidate =>
            candidate.getOriginPositionInfo()?.getLineNo() > 0).at(-1)
            ?.getOriginPositionInfo();
        return {
            filePath: method?.getDeclaringArkFile()?.getFilePath() ?? 'unknown',
            line: position?.getLineNo() && position.getLineNo() > 0
                ? position.getLineNo() : fallback?.getLineNo() ?? 0,
            col: position?.getColNo() && position.getColNo() > 0
                ? position.getColNo() : fallback?.getColNo() ?? 0,
        };
    }
}
