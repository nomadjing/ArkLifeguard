import {
    ArkAwaitExpr,
    ArkCastExpr,
    ArkInstanceFieldRef,
    ArkMethod,
    ArkReturnStmt,
    ArkReturnVoidStmt,
    ArkThrowStmt,
    Scene,
    Stmt,
} from '../../adapter/arkanalyzer';
import { DataflowSolver } from '../../ifds/DataflowSolver';
import { ArkInterproceduralCFG } from '../../ifds/icfg/ArkInterproceduralCFG';
import type { InterproceduralCFG } from '../../ifds/icfg/InterproceduralCFG';
import { ResourceFact, hasResourceHandle } from './ResourceFact';
import { ResourceProblem } from './ResourceProblem';
import type {
    ResourceAnalysisResult,
    ResourceDiagnostic,
    ResourceLeakReason,
    ResourceLocation,
} from './ResourceResult';
import type { ResourceRule } from './rules/ResourceRule';
import { UNSUPPORTED_RESOURCE_API_FAMILIES } from './rules/ResourceCapabilities';
import { resolveHarmonyResourceRules } from './rules/HarmonyResourceRules';

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
                enabled: true,
                status: 'failed',
                success: false,
                entryMethod,
                unsupportedApiFamilies: UNSUPPORTED_RESOURCE_API_FAMILIES,
                ruleIds: [],
                diagnostics: [],
                unresolvedRuleIds: this.unresolvedRuleIds,
                error: '资源分析没有可用规则；请检查 SDK 解析或提供有效的 resourceRules。',
            };
        }
        try {
            const cfg = dummyMain.getCfg();
            // Match CfgIndex.getStartPointOf: incoming summaries use the first
            // statement after parameter bindings as the method entry identity.
            const entry = cfg?.getStartingBlock()?.getStmts()[dummyMain.getParameters().length]
                ?? cfg?.getStartingStmt() ?? cfg?.getStartingBlock()?.getHead();
            if (!entry) throw new Error('资源分析入口没有 CFG 语句');
            const icfg = new ArkInterproceduralCFG(this.scene);
            const problem = new ResourceProblem(entry, dummyMain, this.rules,
                stmt => icfg.getNormalSuccessors(stmt));
            const solver = new DataflowSolver(problem, this.scene, { collectStatistics: this.collectStatistics }, icfg);
            solver.solve();
            const byStatement = new Map<Stmt, ResourceFact[]>();
            for (const edge of solver.getPathEdgeSet()) {
                const statement = edge.edgeEnd.node;
                const facts = byStatement.get(statement) ?? [];
                facts.push(edge.edgeEnd.fact);
                byStatement.set(statement, facts);
            }
            return {
                enabled: true,
                status: 'success',
                success: true,
                entryMethod,
                unsupportedApiFamilies: UNSUPPORTED_RESOURCE_API_FAMILIES,
                ruleIds: this.rules.map(rule => rule.id),
                diagnostics: this.collectDiagnostics(byStatement, dummyMain, icfg),
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
                enabled: true,
                status: 'failed',
                success: false,
                entryMethod,
                unsupportedApiFamilies: UNSUPPORTED_RESOURCE_API_FAMILIES,
                ruleIds: this.rules.map(rule => rule.id),
                diagnostics: [],
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private collectDiagnostics(
        byStatement: ReadonlyMap<Stmt, readonly ResourceFact[]>,
        entryMethod: ArkMethod,
        icfg: InterproceduralCFG,
    ): ResourceDiagnostic[] {
        const groups = new Map<string, ExitFact[]>();
        const seenOverwrites = new Set<string>();
        const ids = new Map<Stmt, number>();
        const siteId = (site: Stmt): number => {
            let id = ids.get(site);
            if (!id) {
                id = ids.size + 1;
                ids.set(site, id);
            }
            return id;
        };
        const obligationKey = (fact: ResourceFact): string =>
            `${fact.ruleId}|${siteId(fact.allocationSite!)}|${fact.acquisitionContext.map(siteId).join(',')}`;
        const released = new Set<string>();
        for (const facts of byStatement.values()) {
            for (const fact of facts) {
                if (fact.state === 'released' && fact.allocationSite) released.add(obligationKey(fact));
            }
        }
        for (const [exit, facts] of byStatement) {
            const atExit = (exit instanceof ArkReturnStmt || exit instanceof ArkReturnVoidStmt ||
                exit instanceof ArkThrowStmt) && icfg.isExitStatement(exit);
            const method = exit.getCfg()?.getDeclaringMethod();
            if (!method) continue;
            for (const fact of facts) {
                if (fact.isZero() || !fact.allocationSite || fact.frames.length > 0) continue;
                const lost = fact.hasLostHandles();
                if (!lost && !atExit) continue;
                // The contract asks for a reachable matching release, not cleanup
                // on every path. Losing the last handle is separate evidence:
                // releasing its replacement cannot discharge the old obligation.
                if (!lost && released.has(obligationKey(fact))) continue;
                if (!lost && this.transferredAtExit(exit, fact, method !== entryMethod)) continue;
                // Multiple lifecycle exits are evidence for one allocation, not independent leaks.
                const key = `${fact.ruleId}|${siteId(fact.allocationSite)}`;
                if (lost) {
                    const overwriteKey = `${key}|${siteId(fact.eventSite!)}|${fact.state}`;
                    if (seenOverwrites.has(overwriteKey)) continue;
                    seenOverwrites.add(overwriteKey);
                }
                const group = groups.get(key) ?? [];
                group.push({ fact, exit: lost ? fact.eventSite! : exit });
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
            const lost = group.filter(item => item.fact.hasLostHandles());
            const chosen = (preferred(lost.filter(item => item.fact.state === 'allocated')) ??
                preferred(lost) ?? preferred(leaks) ?? preferred(unknowns))!;
            const { fact, exit } = chosen;
            const reason: ResourceLeakReason = fact.hasLostHandles() ? 'overwritten'
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
                confidence: fact.state === 'unknown' || fact.state === 'pending' ? 'low' : 'high',
                evidence,
            });
        }
        return diagnostics.sort((left, right) =>
            `${left.ruleId}:${left.allocation.filePath}:${left.allocation.line}`.localeCompare(
                `${right.ruleId}:${right.allocation.filePath}:${right.allocation.line}`));
    }

    private transferredAtExit(exit: Stmt, fact: ResourceFact, nonRoot: boolean): boolean {
        if (exit instanceof ArkReturnStmt) {
            let returned = exit.getOp();
            while (returned instanceof ArkAwaitExpr || returned instanceof ArkCastExpr) {
                returned = returned instanceof ArkAwaitExpr ? returned.getPromise() : returned.getOp();
            }
            if (hasResourceHandle(fact.handles, returned)) return true;
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
