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
import { resolveHarmonyResourceRules } from './rules/HarmonyResourceRules';

class ResourceSolver extends DataflowSolver<ResourceFact> {}

interface ExitFact {
    readonly fact: ResourceFact;
    readonly exit: Stmt;
}

/** Independent resource-leak engine with SDK defaults or explicitly injected rules. */
export class ResourceRunner {
    private readonly rules: readonly ResourceRule[];
    private readonly unresolvedRuleIds: readonly string[];
    constructor(
        private readonly scene: Scene,
        rules?: readonly ResourceRule[],
        private readonly collectStatistics = false,
    ) {
        const resolved = rules === undefined ? resolveHarmonyResourceRules(scene) : undefined;
        this.rules = rules ?? resolved!.rules;
        this.unresolvedRuleIds = resolved?.unresolvedRuleIds ?? [];
    }

    runWithDummyMain(dummyMain: ArkMethod): ResourceAnalysisResult {
        const entryMethod = dummyMain.getSignature().toString();
        if (this.rules.length === 0) {
            return {
                status: 'not-implemented',
                success: false,
                entryMethod,
                ruleIds: [],
                diagnostics: [],
                unresolvedRuleIds: this.unresolvedRuleIds,
                error: '新资源分析尚未配置规则；请选择 legacy 引擎。',
            };
        }
        try {
            const cfg = dummyMain.getCfg();
            const entry = cfg?.getStartingStmt() ?? cfg?.getStartingBlock()?.getHead();
            if (!entry) throw new Error('资源分析入口没有 CFG 语句');
            const problem = new ResourceProblem(entry, dummyMain, this.rules);
            const solver = new ResourceSolver(problem, this.scene, { collectStatistics: this.collectStatistics });
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
                unresolvedRuleIds: this.unresolvedRuleIds,
                solverStatistics: solver.getStatistics(),
                coverage: this.rules.map(rule => {
                    const allocators = new Set(rule.allocators.map(api => api.methodSignature));
                    const releasers = new Set(rule.releasers.map(api => api.methodSignature));
                    const allocations = [];
                    let releaserCalls = 0;
                    let reachedReleaserCalls = 0;
                    for (const method of this.scene.getMethods()) {
                        for (const stmt of method.getCfg()?.getStmts() ?? []) {
                            const signature = stmt.getInvokeExpr()?.getMethodSignature().toString();
                            if (!signature) continue;
                            if (allocators.has(signature)) allocations.push({
                                ...this.location(stmt), reached: byStatement.has(stmt),
                            });
                            if (releasers.has(signature)) {
                                releaserCalls++;
                                if (byStatement.has(stmt)) reachedReleaserCalls++;
                            }
                        }
                    }
                    return { ruleId: rule.id, allocatorCalls: allocations.length,
                        reachedAllocatorCalls: allocations.filter(site => site.reached).length,
                        releaserCalls, reachedReleaserCalls, allocations };
                }),
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
                // Multiple lifecycle exits are evidence for one allocation, not independent leaks.
                const key = `${fact.ruleId}|${siteId(fact.allocationSite)}`;
                const group = groups.get(key) ?? [];
                group.push({ fact, exit });
                groups.set(key, group);
            }
        }
        const diagnostics: ResourceDiagnostic[] = [];
        for (const group of groups.values()) {
            const leaks = group.filter(item => item.fact.state === 'allocated');
            const unknowns = group.filter(item => item.fact.state === 'unknown' || item.fact.state === 'pending');
            if (leaks.length === 0 && unknowns.length === 0) continue;
            // Prefer the allocating method's exit over a distant lifecycle continuation.
            const preferred = (items: ExitFact[]): ExitFact | undefined => items.find(item =>
                item.exit.getCfg()?.getDeclaringMethod() ===
                item.fact.allocationSite?.getCfg()?.getDeclaringMethod()) ?? items[0];
            const chosen = (preferred(leaks) ?? preferred(unknowns))!;
            const { fact, exit } = chosen;
            const partiallyReleased = leaks.length > 0 &&
                group.some(item => item.fact.state === 'released');
            const reason: ResourceLeakReason = partiallyReleased
                ? 'partially-released'
                : fact.state === 'unknown' || fact.state === 'pending'
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
            filePath: method?.getDeclaringArkFile()?.getFilePath() ||
                `[synthetic] ${method?.getSignature().toString() ?? 'unknown'}`,
            line: position?.getLineNo() && position.getLineNo() > 0
                ? position.getLineNo() : fallback?.getLineNo() ?? 0,
            col: position?.getColNo() && position.getColNo() > 0
                ? position.getColNo() : fallback?.getColNo() ?? 0,
        };
    }
}
