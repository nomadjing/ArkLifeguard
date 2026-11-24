import fs from 'node:fs';
import path from 'node:path';
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
import { ResourceFact, hasResourceHandle, resourceValueKey } from './ResourceFact';
import { ResourceProblem } from './ResourceProblem';
import { OwnerBoundaryProblem, type ReleaseOwner } from './OwnerBoundaryProblem';
import { ListenerCleanupSummary } from './ListenerCleanupSummary';
import type { ResourceAnalysisResult, ResourceDiagnostic, ResourceLeakReason, ResourceLocation } from './ResourceResult';
import type { ResourceRule } from './rules/ResourceRule';

interface ExitFact {
    readonly fact: ResourceFact;
    readonly exit: Stmt;
    readonly partialRelease: boolean;
}

function listenerHandleIdentity(value: ResourceFact['handles'][number]): string {
    if (value instanceof ArkInstanceFieldRef && value.getBase().getName() === 'this') {
        return `this-field:${value.getFieldSignature().toString()}`;
    }
    return resourceValueKey(value);
}

/** Shared Source–Sink solver for explicit release obligations; no GC heap exploration. */
export class ReleaseObligationRunner {
    constructor(
        private readonly scene: Scene,
        private readonly rules: readonly ResourceRule[],
        private readonly collectStatistics = false,
        private readonly metadata: {
            readonly label: string;
            readonly scope: 'resource' | 'listener';
            readonly unresolvedRuleIds: readonly string[];
            readonly unsupportedApiFamilies: readonly string[];
        } = { label: '释放义务', scope: 'resource', unresolvedRuleIds: [], unsupportedApiFamilies: [] },
        private readonly owners: readonly ReleaseOwner[] = [],
        private readonly progressPath?: string,
    ) {}

    runWithDummyMain(dummyMain: ArkMethod, onSolved?: (solver: DataflowSolver<ResourceFact>) => void): ResourceAnalysisResult {
        const entryMethod = dummyMain.getSignature().toString();
        if (this.rules.length === 0) {
            return {
                enabled: true,
                status: 'failed',
                success: false,
                entryMethod,
                unsupportedApiFamilies: this.metadata.unsupportedApiFamilies,
                ruleIds: [],
                diagnostics: [],
                unresolvedRuleIds: this.metadata.unresolvedRuleIds,
                error: `${this.metadata.label}分析没有可用规则；请检查 SDK 解析或提供有效规则。`,
            };
        }
        try {
            if (this.rules.some(rule => rule.scope !== this.metadata.scope && !(this.metadata.scope === 'resource' && rule.scope === 'compatibility'))) {
                throw new Error(`${this.metadata.label}规则类别不匹配`);
            }
            const cfg = dummyMain.getCfg();
            // Match CfgIndex.getStartPointOf: incoming summaries use the first
            // statement after parameter bindings as the method entry identity.
            const entry = cfg?.getStartingBlock()?.getStmts()[dummyMain.getParameters().length] ?? cfg?.getStartingStmt() ?? cfg?.getStartingBlock()?.getHead();
            if (!entry) throw new Error(`${this.metadata.label}分析入口没有 CFG 语句`);
            const icfg = new ArkInterproceduralCFG(this.scene);
            const problem = this.createProblem(entry, dummyMain, this.rules, stmt => icfg.getNormalSuccessors(stmt));
            const solver = new DataflowSolver(new OwnerBoundaryProblem(problem, dummyMain, this.owners),
                this.scene, { collectStatistics: this.collectStatistics,
                    onProgress: this.progressPath ? snapshot => {
                        fs.mkdirSync(path.dirname(this.progressPath!), { recursive: true });
                        const temporary = `${this.progressPath}.${process.pid}.tmp`;
                        fs.writeFileSync(temporary, JSON.stringify({ scope: this.metadata.scope, ...snapshot,
                            propagation: problem.getPropagationStatistics() }));
                        fs.renameSync(temporary, this.progressPath!);
                    } : undefined,
                }, icfg);
            solver.solve();
            onSolved?.(solver);
            const byStatement = new Map<Stmt, ResourceFact[]>();
            const exceptionalExits = new Map<Stmt, Set<ResourceFact>>();
            for (const edge of solver.getPathEdgeSet()) {
                if (this.metadata.scope === 'resource' && edge.edgeStart === edge.edgeEnd) {
                    for (const { node, fact } of solver.getExceptionalEndSummaries(edge.edgeStart)) {
                        // An implicit SDK failure can leave a method without a throw statement in its IR.
                        if (fact.state !== 'allocated' || fact.failureSite !== node ||
                            node.getCfg() !== edge.edgeStart.node.getCfg() || node.getCfg() !== fact.allocationSite?.getCfg()) continue;
                        const exits = exceptionalExits.get(node) ?? new Set<ResourceFact>();
                        exits.add(fact);
                        exceptionalExits.set(node, exits);
                    }
                }
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
                unsupportedApiFamilies: this.metadata.unsupportedApiFamilies,
                ruleIds: this.rules.map(rule => rule.id),
                diagnostics: this.collectDiagnostics(byStatement, dummyMain, icfg, exceptionalExits),
                reachedStatements: byStatement.size,
                reachedFacts: [...byStatement.values()].reduce((sum, facts) => sum + facts.length, 0),
                unresolvedRuleIds: this.metadata.unresolvedRuleIds,
                solverStatistics: solver.getStatistics(),
                propagationStatistics: this.collectStatistics ? problem.getPropagationStatistics() : undefined,
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
                            if (allocators.has(signature))
                                allocations.push({
                                    ...this.location(stmt),
                                    reached: byStatement.has(stmt),
                                });
                            if (releasers.has(signature)) {
                                releaserCalls++;
                                if (byStatement.has(stmt)) reachedReleaserCalls++;
                            }
                        }
                    }
                    return {
                        ruleId: rule.id,
                        allocatorCalls: allocations.length,
                        reachedAllocatorCalls: allocations.filter(site => site.reached).length,
                        releaserCalls,
                        reachedReleaserCalls,
                        allocations,
                    };
                }),
            };
        } catch (error) {
            return {
                enabled: true,
                status: 'failed',
                success: false,
                entryMethod,
                unsupportedApiFamilies: this.metadata.unsupportedApiFamilies,
                ruleIds: this.rules.map(rule => rule.id),
                diagnostics: [],
                unresolvedRuleIds: this.metadata.unresolvedRuleIds,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    protected createProblem(entry: Stmt, method: ArkMethod, rules: readonly ResourceRule[], successors: (stmt: Stmt) => readonly Stmt[]): ResourceProblem {
        return new ResourceProblem(entry, method, rules, successors);
    }

    private collectDiagnostics(
        byStatement: ReadonlyMap<Stmt, readonly ResourceFact[]>,
        entryMethod: ArkMethod,
        icfg: InterproceduralCFG,
        exceptionalExits: ReadonlyMap<Stmt, ReadonlySet<ResourceFact>>
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
        const keyOf = (fact: ResourceFact) => `${fact.ruleId}|${siteId(fact.allocationSite!)}|${fact.acquisitionContext.map(siteId).join(',')}|${fact.owner ?? ''}`;
        const released = new Set<string>();
        const releasedAtReturn = new Set<string>();
        const releasedAfterFailure = new Set<string>();
        const releasedStatements = new Map<string, Set<Stmt>>();
        const releasedTimerHandles = new Map<string, Set<string>>();
        const releasedListenerCallbacks = new Map<string, Map<string, {
            callbacks: Set<string>; removeAll: boolean;
        }>>();
        const releasedTimerTokens = new Map<string, Set<string>>();
        const cleanupSummary = this.metadata.scope === 'listener'
            ? new ListenerCleanupSummary(this.scene, this.rules, this.owners,
                stmt => icfg.getNormalSuccessors(stmt))
            : undefined;
        for (const [statement, facts] of byStatement) for (const fact of facts) {
            if (fact.state !== 'released' || !fact.allocationSite) continue;
            const key = keyOf(fact);
            released.add(key);
            if (statement.getCfg() === fact.allocationSite.getCfg() &&
                (statement instanceof ArkReturnStmt || statement instanceof ArkReturnVoidStmt)) {
                releasedAtReturn.add(key);
            }
            if (fact.failureSite) releasedAfterFailure.add(`${key}|${siteId(fact.failureSite)}`);
            const statements = releasedStatements.get(key) ?? new Set<Stmt>();
            statements.add(statement);
            releasedStatements.set(key, statements);
            const registration = fact.registration;
            if (!registration?.registrar || !registration.event) continue;
            const identityKey = `${fact.ruleId}|${siteId(fact.allocationSite)}|${fact.owner ?? ''}`;
            const registrationKey = `${registration.registrar}|${registration.event}`;
            const listenerIdentityKey = `${fact.ruleId}|${siteId(fact.allocationSite)}`;
            const callbackEntries: Map<string, {
                callbacks: Set<string>; removeAll: boolean;
            }> = releasedListenerCallbacks.get(listenerIdentityKey) ?? new Map();
            const callbackIdentity = callbackEntries.get(registrationKey) ?? { callbacks: new Set<string>(), removeAll: false };
            if (registration.callback) callbackIdentity.callbacks.add(registration.callback);
            callbackIdentity.removeAll ||= registration.removeAll === true;
            callbackEntries.set(registrationKey, callbackIdentity);
            releasedListenerCallbacks.set(listenerIdentityKey, callbackEntries);
            if (fact.registration?.event === 'timer') {
                const handles = releasedTimerHandles.get(key) ?? new Set<string>();
                for (const handle of fact.handles) handles.add(resourceValueKey(handle));
                releasedTimerHandles.set(key, handles);
                const tokens = releasedTimerTokens.get(identityKey) ?? new Set<string>();
                for (const handle of fact.handles) tokens.add(listenerHandleIdentity(handle));
                releasedTimerTokens.set(identityKey, tokens);
            }
        }
        for (const exits of [byStatement, exceptionalExits]) for (const [exit, facts] of exits) {
            const atExit = exits === exceptionalExits ||
                (exit instanceof ArkReturnStmt || exit instanceof ArkReturnVoidStmt || exit instanceof ArkThrowStmt) && icfg.isExitStatement(exit);
            const method = exit.getCfg()?.getDeclaringMethod();
            if (!method) continue;
            for (const fact of facts) {
                if (fact.isZero() || !fact.allocationSite || fact.frames.length > 0) continue;
                const allocationSite = fact.allocationSite;
                if (!fact.boundary && fact.registration && (method !== entryMethod || !atExit)) continue;
                if (!fact.boundary && fact.owner && method !== entryMethod) continue;
                const lost = fact.hasLostHandles();
                if (!lost && !atExit && !fact.boundary) continue;
                // Match releases by resource or registration identity.
                const matchingRelease = fact.registration?.event === 'timer'
                    ? (() => {
                        const releasedTokens = releasedTimerTokens.get(
                            `${fact.ruleId}|${siteId(allocationSite)}|${fact.owner ?? ''}`
                        );
                        return (fact.handles.length === 0 && (releasedTokens?.size ?? 0) > 0) ||
                            fact.handles.some(handle =>
                                releasedTimerHandles.get(keyOf(fact))?.has(resourceValueKey(handle)) ||
                                releasedTokens?.has(listenerHandleIdentity(handle)));
                    })()
                    : released.has(keyOf(fact)) || (() => {
                        const registration = fact.registration;
                        if (!registration?.registrar || !registration.event) return false;
                        const releases = releasedListenerCallbacks.get(
                            `${fact.ruleId}|${siteId(allocationSite)}`
                        )?.get(`${registration.registrar}|${registration.event}`);
                        return releases?.removeAll === true ||
                            (!!registration.callback && releases?.callbacks.has(registration.callback) === true);
                    })();
                const ownerCleanup = !lost && fact.registration?.event === 'timer' &&
                    cleanupSummary?.clearsAtOwnerEnd(allocationSite, fact.handles) === true;
                const ownerEventCleanup = !lost && fact.registration &&
                    fact.registration.event !== 'timer' &&
                    cleanupSummary?.clearsEventAtOwnerEnd(allocationSite, fact.registration) === true;
                const pureForwardingWrapper = !lost && fact.registration &&
                    fact.registration.event !== 'timer' &&
                    cleanupSummary?.isPureForwardingRegistration(allocationSite) === true;
                const cleanupBeforeRegistration = lost && fact.registration?.event === 'timer' &&
                    cleanupSummary?.clearsBeforeAllocation(allocationSite, fact.handles) === true;
                const guardedReentry = lost && fact.registration?.event === 'timer' &&
                    cleanupSummary?.isGuardedReentry(allocationSite) === true;
                // A release elsewhere does not discharge this local return or an observed failure path.
                const localExit = atExit && this.metadata.scope === 'resource' &&
                    method === allocationSite.getCfg()?.getDeclaringMethod();
                const separateReturn = localExit && fact.state === 'allocated' &&
                    releasedAtReturn.has(keyOf(fact)) && !releasedStatements.get(keyOf(fact))?.has(exit);
                const failedLocally = localExit && fact.state === 'allocated' && fact.failureSite &&
                    !releasedAfterFailure.has(`${keyOf(fact)}|${siteId(fact.failureSite)}`);
                const partialRelease = !lost && matchingRelease && !failedLocally && !separateReturn;
                if (!lost && ((partialRelease && (!localExit || fact.state !== 'allocated')) ||
                    ownerCleanup || ownerEventCleanup || pureForwardingWrapper)) continue;
                if (cleanupBeforeRegistration || guardedReentry) continue;
                if (lost && this.releasedBeforeReentry(fact, icfg, releasedStatements.get(keyOf(fact)))) continue;
                if (!fact.boundary && !fact.registration && !lost && this.transferredAtExit(exit, fact, method !== entryMethod)) continue;
                // Multiple lifecycle exits are evidence for one allocation, not independent leaks.
                const key = `${fact.ruleId}|${siteId(fact.allocationSite)}|${fact.owner ?? ''}|${fact.boundary ? siteId(fact.boundary) : 0}`;
                if (lost) {
                    const overwriteKey = `${key}|${siteId(fact.eventSite!)}|${fact.state}`;
                    if (seenOverwrites.has(overwriteKey)) continue;
                    seenOverwrites.add(overwriteKey);
                }
                const group = groups.get(key) ?? [];
                group.push({ fact, exit: lost ? fact.eventSite! : fact.boundary ?? exit, partialRelease });
                groups.set(key, group);
            }
        }
        const diagnostics: ResourceDiagnostic[] = [];
        for (const group of groups.values()) {
            const leaks = group.filter(item => item.fact.state === 'allocated');
            const unknowns = group.filter(item => item.fact.state === 'unknown' || item.fact.state === 'pending');
            if (leaks.length === 0 && unknowns.length === 0) continue;
            // Prefer the allocating method's exit over a distant lifecycle continuation.
            const preferred = (items: ExitFact[]): ExitFact | undefined =>
                items.find(item => item.exit.getCfg()?.getDeclaringMethod() === item.fact.allocationSite?.getCfg()?.getDeclaringMethod()) ?? items[0];
            const lost = group.filter(item => item.fact.hasLostHandles());
            const chosen = (preferred(lost.filter(item => item.fact.state === 'allocated')) ?? preferred(lost) ??
                preferred(leaks.filter(item => !item.partialRelease)) ?? preferred(leaks) ?? preferred(unknowns))!;
            const { fact, exit, partialRelease } = chosen;
            const reason: ResourceLeakReason = fact.hasLostHandles()
                ? 'overwritten'
                : fact.state === 'unknown' || fact.state === 'pending'
                  ? 'unknown-ownership'
                  : fact.event === 'overwritten'
                    ? 'overwritten'
                    : fact.event === 'wrong-release'
                      ? 'wrong-release'
                      : partialRelease ? 'partially-released' : 'unreleased';
            const allocation = this.location(fact.allocationSite!);
            const boundary = this.location(exit);
            const evidence = [allocation];
            if (fact.failureSite && fact.failureSite !== exit) evidence.push(this.location(fact.failureSite));
            if (fact.eventSite) evidence.push(this.location(fact.eventSite));
            evidence.push(boundary);
            diagnostics.push({
                ruleId: fact.ruleId,
                allocation,
                boundary,
                reason,
                evidence,
            });
        }
        const seen = new Set<string>();
        return diagnostics.filter(item => {
            const key = JSON.stringify([item.ruleId, item.allocation, item.boundary, item.reason, item.evidence]);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).sort((left, right) =>
            `${left.ruleId}:${left.allocation.filePath}:${left.allocation.line}:${left.allocation.col}`.localeCompare(
                `${right.ruleId}:${right.allocation.filePath}:${right.allocation.line}:${right.allocation.col}`
            )
        );
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
        return nonRoot && fact.handles.some(handle => handle instanceof ArkInstanceFieldRef && handle.getBase().toString() === 'this');
    }

    private releasedBeforeReentry(
        fact: ResourceFact,
        icfg: InterproceduralCFG,
        releasedStatements: ReadonlySet<Stmt> | undefined,
    ): boolean {
        const call = fact.acquisitionContext.at(-1);
        if (!call || !releasedStatements?.size) return false;
        const caller = call.getCfg()?.getDeclaringMethod();
        if (!caller) return false;
        const pending: { stmt: Stmt; released: boolean }[] = [];
        for (const successor of icfg.getNormalSuccessors(call)) pending.push({ stmt: successor, released: false });
        const visited = new Map<Stmt, Set<boolean>>();
        let reentered = false;
        while (pending.length > 0) {
            const { stmt, released } = pending.pop()!;
            if (stmt === call) {
                if (!released) return false;
                reentered = true;
                continue;
            }
            if (stmt.getCfg()?.getDeclaringMethod() !== caller) continue;
            const states = visited.get(stmt) ?? new Set<boolean>();
            if (states.has(released)) continue;
            states.add(released);
            visited.set(stmt, states);
            const nextReleased = released || releasedStatements.has(stmt);
            for (const successor of icfg.getNormalSuccessors(stmt)) {
                pending.push({ stmt: successor, released: nextReleased });
            }
        }
        return reentered;
    }

    private location(stmt: Stmt): ResourceLocation {
        const method = stmt.getCfg()?.getDeclaringMethod();
        const position = stmt.getOriginPositionInfo();
        const fallback = method
            ?.getCfg()
            ?.getStmts()
            .filter(candidate => candidate.getOriginPositionInfo()?.getLineNo() > 0)
            .at(-1)
            ?.getOriginPositionInfo();
        return {
            filePath: method?.getDeclaringArkFile()?.getFilePath() || `[synthetic] ${method?.getSignature().toString() ?? 'unknown'}`,
            line: position?.getLineNo() && position.getLineNo() > 0 ? position.getLineNo() : (fallback?.getLineNo() ?? 0),
            col: position?.getColNo() && position.getColNo() > 0 ? position.getColNo() : (fallback?.getColNo() ?? 0),
        };
    }
}
