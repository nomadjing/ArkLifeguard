/*
 * Copyright (c) 2024-2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Scene } from '../../adapter/arkanalyzer';
import {
    AliasType,
    FunctionType,
    Local,
    ModifierType,
    NullConstant,
    NullType,
    UndefinedConstant,
    UndefinedType,
    UnionType,
    type Type,
} from '../../adapter/arkanalyzer';
import {
    ArkAssignStmt,
    ArkInstanceInvokeExpr,
    ArkParameterRef,
    Stmt,
} from '../../adapter/arkanalyzer';
import { ArkMethod } from '../../adapter/arkanalyzer';
import {
    createLifecycleModelCreator,
    LifecycleModelStatistics,
} from '../../lifecycle';
import {
    AbilityLifecycleStage,
    AbilityLifecycleMethodStage,
    DEFAULT_LIFECYCLE_CONFIG,
    LifecycleModelConfig,
} from '../../lifecycle';
import { NullnessAccessPath, NullnessFact } from './NullnessFact';
import {
    NullDereferenceDiagnostic,
    NullnessAnalysisConfig,
    NullnessProblem,
    NullnessMetadataCache,
} from './NullnessProblem';
import { findRecursiveMethods } from '../../ifds/CallResolver';
import { NullnessSourceSemantics } from './NullnessSourceSemantics';
import { NullnessSolver } from './NullnessSolver';
import { NullnessLibraryRegistry } from './library/NullnessLibraryRegistry';
import { type IFDSSolverStatistics } from '../../ifds';
import { createNullnessInterproceduralCFG } from './NullnessCallGraph';

export interface NullnessRunnerConfig {
    problem?: NullnessAnalysisConfig;
    lifecycle?: Partial<LifecycleModelConfig>;
    libraryRegistry?: NullnessLibraryRegistry;
    /** Analyze project-file module initializers that can introduce nullish facts. */
    analyzeModuleInitializers?: boolean;
    /** Collect and aggregate IFDS statistics across the lifecycle and supplemental roots. */
    collectSolverStatistics?: boolean;
}

export interface NullnessAnalysisResult {
    success: boolean;
    entryMethod: string;
    diagnostics: readonly NullDereferenceDiagnostic[];
    reachedFacts: Map<Stmt, NullnessFact[]>;
    solverStatistics?: Readonly<IFDSSolverStatistics>;
    solverBreakdown?: NullnessSolverBreakdown;
    lifecycleModelStatistics?: NullnessLifecycleModelStatistics;
    error?: string;
}

export interface NullnessLifecycleModelStatistics {
    abilities: number;
    components: number;
    blocks: number;
    edges: number;
    hierarchy: LifecycleModelStatistics;
    reachedStatements: number;
    reachedFacts: number;
    processedEdges: number | null;
    propagationAttempts: number | null;
    ifdsTimeMs: number | null;
    factsPerStatement: number | null;
    edgesPerStatement: number | null;
}

export interface NullnessSolverBreakdown {
    lifecycle?: Readonly<IFDSSolverStatistics>;
    lifecycleReachedStatements: number;
    lifecycleReachedFacts: number;
    supplemental?: Readonly<IFDSSolverStatistics>;
    supplementalRootCount: number;
}

// Share callback coverage with the lifecycle generator, retaining foreground re-entry.
export const NULLNESS_LIFECYCLE_ORDER: AbilityLifecycleMethodStage[] =
    DEFAULT_LIFECYCLE_CONFIG.lifecycleOrder.flatMap<AbilityLifecycleMethodStage>(stage =>
        stage === AbilityLifecycleStage.BACKGROUND
            ? [stage, AbilityLifecycleStage.FOREGROUND]
            : [stage]
    );

/** Runs nullness analysis from the lifecycle-aware DummyMain entry point. */
export class NullnessAnalysisRunner {
    private readonly mergedFactIndexes = new WeakMap<
        Map<Stmt, NullnessFact[]>,
        Map<Stmt, Map<number, NullnessFact[]>>
    >();

    constructor(
        private readonly scene: Scene,
        private readonly config: NullnessRunnerConfig = {}
    ) {}

    runFromDummyMain(): NullnessAnalysisResult {
        try {
            const creator = createLifecycleModelCreator(
                this.scene,
                {
                    lifecycleOrder: NULLNESS_LIFECYCLE_ORDER,
                    ...this.config.lifecycle,
                } as Partial<LifecycleModelConfig>
            );
            creator.create();
            const dummyMain = creator.getDummyMain();
            const result = this.runWithDummyMain(dummyMain);
            const blocks = [...dummyMain.getCfg()!.getBlocks()];
            const lifecycleStatistics = result.solverBreakdown?.lifecycle;
            const reachedStatements =
                result.solverBreakdown?.lifecycleReachedStatements ?? 0;
            const reachedFacts =
                result.solverBreakdown?.lifecycleReachedFacts ?? 0;
            return {
                ...result,
                lifecycleModelStatistics: {
                    abilities: creator.getAbilities().length,
                    components: creator.getComponents().length,
                    blocks: blocks.length,
                    edges: blocks.reduce(
                        (sum, block) => sum + block.getSuccessors().length,
                        0
                    ),
                    hierarchy: creator.getLifecycleModelStatistics(),
                    reachedStatements,
                    reachedFacts,
                    processedEdges: lifecycleStatistics?.processedEdges ?? null,
                    propagationAttempts:
                        lifecycleStatistics?.propagationAttempts ?? null,
                    ifdsTimeMs: lifecycleStatistics?.solveTimeMs ?? null,
                    factsPerStatement: reachedStatements === 0
                        ? null
                        : reachedFacts / reachedStatements,
                    edgesPerStatement: reachedStatements === 0 ||
                        !lifecycleStatistics
                        ? null
                        : lifecycleStatistics.processedEdges / reachedStatements,
                },
            };
        } catch (error) {
            return this.analysisFailure(error);
        }
    }

    /** Run against a lifecycle model already created by an application entry point. */
    runWithDummyMain(
        dummyMain: ArkMethod,
        onSolved?: (solver: NullnessSolver, root: 'lifecycle' | 'supplemental') => void,
    ): NullnessAnalysisResult {
        try {
            const cfg = dummyMain.getCfg();
            const entryStmt = cfg?.getStartingStmt() ?? cfg?.getStartingBlock()?.getHead();
            if (!cfg || !entryStmt) {
                return this.failure('Lifecycle DummyMain has no CFG entry');
            }

            const libraryRegistry = this.config.libraryRegistry ??
                NullnessLibraryRegistry.createDefault(this.scene);
            const sourceSemantics = new NullnessSourceSemantics();
            const metadata = new NullnessMetadataCache(libraryRegistry, sourceSemantics);
            const problem = new NullnessProblem(
                entryStmt,
                dummyMain,
                this.config.problem,
                libraryRegistry,
                sourceSemantics,
                metadata
            );
            const supplementalRoots = new Set<ArkMethod>();
            for (const method of this.getProjectAsyncBodyRoots(dummyMain)) {
                supplementalRoots.add(method);
            }
            if (this.config.analyzeModuleInitializers !== false) {
                const moduleInitializers = this.getNullishModuleInitializers(
                    dummyMain,
                    libraryRegistry,
                    sourceSemantics
                );
                for (const method of moduleInitializers) {
                    supplementalRoots.add(method);
                }
            }
            // Keep independent roots in independent solver instances. A unified
            // solver retains every contextual PathEdge from every root until the
            // last root finishes, which makes large projects peak at the sum of
            // all root-state spaces. Sequential roots preserve the same union of
            // diagnostics/reached facts while allowing contextual edges to die.
            // The scene is fixed during this run; share SCC membership across independent roots.
            const recursiveMethods = problem.getConfig().recursiveSccWidening
                ? findRecursiveMethods(this.scene)
                : undefined;
            // All roots already belong to this fixed Scene. Reuse its CFG
            // index within this run; call resolution is reset for each root.
            const icfg = createNullnessInterproceduralCFG(this.scene, true);
            const solver = new NullnessSolver(problem, this.scene, {
                collectStatistics: this.config.collectSolverStatistics,
            }, recursiveMethods, icfg);
            solver.solve();
            onSolved?.(solver, 'lifecycle');
            const mainStatistics = solver.getStatistics();
            const supplementalStatistics: IFDSSolverStatistics[] = [];
            let supplementalRootCount = 0;
            const diagnostics = [...problem.getNullDereferences()];
            const reachedFacts = solver.getReachedFacts();
            const lifecycleReachedStatements = reachedFacts.size;
            const lifecycleReachedFacts = [...reachedFacts.values()].reduce(
                (sum, facts) => sum + facts.length,
                0
            );
            // Inspect callback-local code without inventing registration -> synchronous
            // execution, captured state, or event order. Promise fulfillment payloads are
            // seeded only through getPromiseFulfillmentRoots.
            const reachedMethods = new Set<ArkMethod>();
            const reachedStatements = new Set<Stmt>();
            this.recordReached(
                reachedFacts,
                reachedMethods,
                reachedStatements
            );
            const pendingRoots = [...supplementalRoots];
            const queuedRoots = new Set(pendingRoots);
            const initialFactsByRoot = new Map<ArkMethod, NullnessFact[]>();
            const enqueueRoot = (
                method: ArkMethod,
                initialFacts: readonly NullnessFact[] = []
            ): void => {
                if (reachedMethods.has(method)) return;
                if (initialFacts.length > 0) {
                    const merged = initialFactsByRoot.get(method) ?? [];
                    for (const fact of initialFacts) {
                        if (!merged.some(existing => existing.equals(fact))) merged.push(fact);
                    }
                    initialFactsByRoot.set(method, merged);
                }
                if (queuedRoots.has(method)) return;
                queuedRoots.add(method);
                pendingRoots.push(method);
            };
            const enqueuePromiseContinuations = (
                factsByStatement: ReadonlyMap<Stmt, readonly NullnessFact[]>
            ): void => {
                for (const [method, facts] of this.getPromiseFulfillmentRoots(
                    factsByStatement
                )) {
                    enqueueRoot(method, facts);
                }
            };
            enqueuePromiseContinuations(reachedFacts);
            for (const callback of this.getCallbackBodyRoots(
                reachedStatements,
                libraryRegistry,
                sourceSemantics
            )) {
                enqueueRoot(callback);
            }
            for (let index = 0; index < pendingRoots.length; index++) {
                const method = pendingRoots[index];
                if (reachedMethods.has(method)) continue;
                const supplementalCfg = method.getCfg();
                const supplementalEntry = supplementalCfg?.getStartingStmt() ??
                    supplementalCfg?.getStartingBlock()?.getHead();
                if (!supplementalCfg || !supplementalEntry) continue;
                supplementalRootCount++;
                const supplementalProblem = new NullnessProblem(
                    supplementalEntry,
                    method,
                    this.config.problem,
                    libraryRegistry,
                    sourceSemantics,
                    metadata,
                    initialFactsByRoot.get(method) ?? []
                );
                const supplementalSolver = new NullnessSolver(
                    supplementalProblem,
                    this.scene,
                    { collectStatistics: this.config.collectSolverStatistics },
                    recursiveMethods,
                    icfg
                );
                supplementalSolver.solve();
                onSolved?.(supplementalSolver, 'supplemental');
                const rootStatistics = supplementalSolver.getStatistics();
                if (rootStatistics) {
                    supplementalStatistics.push({ ...rootStatistics });
                }
                this.mergeDiagnostics(
                    diagnostics,
                    supplementalProblem.getNullDereferences()
                );
                const rootReachedFacts = supplementalSolver.getReachedFacts();
                const newlyReachedStatements = new Set<Stmt>();
                this.recordReached(
                    rootReachedFacts,
                    reachedMethods,
                    newlyReachedStatements
                );
                enqueuePromiseContinuations(rootReachedFacts);
                for (const callback of this.getCallbackBodyRoots(
                    newlyReachedStatements,
                    libraryRegistry,
                    sourceSemantics
                )) {
                    enqueueRoot(callback);
                }
                this.mergeReachedFacts(
                    reachedFacts,
                    rootReachedFacts
                );
            }
            return {
                success: true,
                entryMethod: dummyMain.getSignature().toString(),
                diagnostics,
                reachedFacts,
                solverStatistics: this.aggregateSolverStatistics([
                    ...(mainStatistics ? [{ ...mainStatistics }] : []),
                    ...supplementalStatistics,
                ]),
                solverBreakdown: {
                    lifecycle: mainStatistics,
                    lifecycleReachedStatements,
                    lifecycleReachedFacts,
                    supplemental: this.aggregateSolverStatistics(
                        supplementalStatistics
                    ),
                    supplementalRootCount,
                },
            };
        } catch (error) {
            return this.analysisFailure(error);
        }
    }

    private analysisFailure(error: unknown): NullnessAnalysisResult {
        const detail = error instanceof Error
            ? error.stack ?? error.message
            : String(error);
        return this.failure(`Nullness lifecycle analysis failed: ${detail}`);
    }

    private failure(error: string): NullnessAnalysisResult {
        return {
            success: false,
            entryMethod: '',
            diagnostics: [],
            reachedFacts: new Map(),
            error,
        };
    }

    private aggregateSolverStatistics(
        statistics: readonly IFDSSolverStatistics[]
    ): IFDSSolverStatistics | undefined {
        if (statistics.length === 0) return undefined;
        const sums: Array<keyof IFDSSolverStatistics> = [
            'solveTimeMs',
            'propagationAttempts',
            'deferredPropagationAttempts',
            'uniqueEdgesEnqueued',
            'duplicateEdgesSkipped',
            'deferredDuplicateEdgesSkipped',
            'deduplicationLookups',
            'deduplicationCandidateChecks',
            'factEqualityChecks',
            'processedEdges',
            'immediateEnqueued',
            'deferredEnqueued',
            'finalLaterEdgesSize',
            'finalPathEdgeCount',
        ];
        const maxima: Array<keyof IFDSSolverStatistics> = [
            'maxDeduplicationCandidates',
            'maxImmediateQueueSize',
            'maxDeferredQueueSize',
            'maxCombinedQueueSize',
            'maxLaterEdgesSize',
        ];
        const result = { ...statistics[0] };
        for (const key of sums) {
            (result[key] as number) = statistics.reduce(
                (total, item) => total + (item[key] as number),
                0
            );
        }
        for (const key of maxima) {
            (result[key] as number) = Math.max(
                ...statistics.map(item => item[key] as number)
            );
        }
        return result;
    }

    /**
     * Project module initializers execute when their modules are loaded, but are
     * not ordinary lifecycle callees. Limit the extra roots to initializers with
     * a concrete literal or library-summary nullish source.
     */
    private getNullishModuleInitializers(
        dummyMain: ArkMethod,
        libraryRegistry: NullnessLibraryRegistry,
        sourceSemantics: NullnessSourceSemantics
    ): ArkMethod[] {
        const zeroFact = NullnessFact.getZeroFact();
        const methods: ArkMethod[] = [];
        for (const file of this.scene.getFiles()) {
            const method = file.getDefaultClass()?.getDefaultArkMethod();
            const cfg = method?.getCfg();
            if (!method || method === dummyMain || !cfg) continue;
            if (this.hasLocalNullishEvidence(
                method,
                libraryRegistry,
                sourceSemantics,
                zeroFact
            )) {
                methods.push(method);
            }
        }
        return methods;
    }

    private getCallbackBodyRoots(
        statements: Iterable<Stmt>,
        libraryRegistry: NullnessLibraryRegistry,
        sourceSemantics: NullnessSourceSemantics
    ): Set<ArkMethod> {
        const roots = new Set<ArkMethod>();
        const zeroFact = NullnessFact.getZeroFact();
        const visit = (type: Type, seen: Set<Type>): void => {
            if (seen.has(type)) return;
            seen.add(type);
            if (type instanceof AliasType) visit(type.getOriginalType(), seen);
            else if (type instanceof UnionType) type.getTypes().forEach(member => visit(member, seen));
            else if (type instanceof FunctionType) {
                const signature = type.getMethodSignature();
                const file = signature.getDeclaringClassSignature().getDeclaringFileSignature();
                if (!this.scene.getFile(file) || this.scene.hasSdkFile(file)) return;
                const method = this.scene.getMethod(signature);
                if (method?.getCfg() &&
                    this.hasLocalNullishEvidence(
                        method,
                        libraryRegistry,
                        sourceSemantics,
                        zeroFact
                    ) &&
                    !method.containsModifier(ModifierType.ASYNC)) {
                    roots.add(method);
                }
            }
        };
        for (const stmt of statements) {
            for (const argument of stmt.getInvokeExpr()?.getArgs() ?? []) {
                visit(argument.getType(), new Set());
            }
        }
        return roots;
    }

    /**
     * Dynamic UI routing and framework callbacks may make an async method
     * relevant without exposing a path from DummyMain. Analyze every project
     * async method as a local candidate root; this does not prove reachability.
     */
    private getProjectAsyncBodyRoots(dummyMain: ArkMethod): ArkMethod[] {
        return this.scene.getMethods().filter(method => {
            if (method === dummyMain || !method.getCfg() ||
                !method.containsModifier(ModifierType.ASYNC)) {
                return false;
            }
            const file = method.getSignature().getDeclaringClassSignature()
                .getDeclaringFileSignature();
            return !!this.scene.getFile(file) && !this.scene.hasSdkFile(file);
        });
    }

    /**
     * Seed built-in Promise fulfillment callbacks from payload facts at their
     * registration site. The callback is still solved as a separate root; this
     * does not establish immediate execution or propagate callback effects back.
     */
    private getPromiseFulfillmentRoots(
        factsByStatement: ReadonlyMap<Stmt, readonly NullnessFact[]>
    ): Map<ArkMethod, NullnessFact[]> {
        const roots = new Map<ArkMethod, NullnessFact[]>();
        for (const [stmt, facts] of factsByStatement) {
            const invoke = stmt.getInvokeExpr();
            if (!(invoke instanceof ArkInstanceInvokeExpr) ||
                !this.isBuiltinPromiseThen(invoke)) {
                continue;
            }
            const callback = this.getFunctionArgumentMethod(invoke, 0);
            if (!callback) continue;
            const parameter = this.getParameterLocal(callback, 0);
            if (!parameter) continue;
            const payloadPath = NullnessAccessPath.fromValue(invoke.getBase())
                .appendPromisePayload();
            const seeded = roots.get(callback) ?? [];
            for (const fact of facts) {
                if (!payloadPath.isPrefixOf(fact.accessPath)) continue;
                const remainingFields = fact.accessPath.remainingFieldsAfter(payloadPath);
                const mapped = fact.deriveWithNewAccessPath(new NullnessAccessPath(
                    parameter,
                    parameter.getType(),
                    remainingFields
                ), stmt);
                if (!seeded.some(existing => existing.equals(mapped))) seeded.push(mapped);
            }
            if (seeded.length > 0) roots.set(callback, seeded);
        }
        return roots;
    }

    private isBuiltinPromiseThen(invoke: ArkInstanceInvokeExpr): boolean {
        const signature = invoke.getMethodSignature();
        const owner = signature.getDeclaringClassSignature();
        const file = owner.getDeclaringFileSignature();
        return owner.getClassName() === 'Promise' &&
            signature.getMethodSubSignature().getMethodName() === 'then' &&
            (file.getProjectName() === 'built-in' ||
                file.getFileName().endsWith('@internal/Promise.d.ts'));
    }

    private getFunctionArgumentMethod(
        invoke: ArkInstanceInvokeExpr,
        index: number
    ): ArkMethod | null {
        const type = invoke.getArgs()[index]?.getType();
        if (!(type instanceof FunctionType)) return null;
        const signature = type.getMethodSignature();
        const file = signature.getDeclaringClassSignature().getDeclaringFileSignature();
        if (!this.scene.getFile(file) || this.scene.hasSdkFile(file)) return null;
        const method = this.scene.getMethod(signature);
        return method?.getCfg() ? method : null;
    }

    private getParameterLocal(method: ArkMethod, index: number): Local | null {
        for (const stmt of method.getCfg()?.getStartingBlock()?.getStmts() ?? []) {
            if (!(stmt instanceof ArkAssignStmt)) continue;
            const parameter = stmt.getRightOp();
            const local = stmt.getLeftOp();
            if (parameter instanceof ArkParameterRef &&
                parameter.getIndex() === index && local instanceof Local) {
                return local;
            }
        }
        return null;
    }

    private hasLocalNullishEvidence(
        method: ArkMethod,
        libraryRegistry: NullnessLibraryRegistry,
        sourceSemantics: NullnessSourceSemantics,
        zeroFact: NullnessFact
    ): boolean {
        for (const stmt of method.getCfg()?.getStmts() ?? []) {
            if (stmt instanceof ArkAssignStmt &&
                (stmt.getRightOp() instanceof NullConstant ||
                    stmt.getRightOp() instanceof UndefinedConstant)) {
                return true;
            }
            if ([...libraryRegistry.getFieldReadFacts(stmt)].some(fact =>
                !fact.isZeroFact()
            )) {
                return true;
            }
            if ([...libraryRegistry.getCallToReturnFacts(stmt, zeroFact)]
                .some(fact => !fact.isZeroFact())) {
                return true;
            }
            if (sourceSemantics.getAccesses(stmt).some(access =>
                access.asserted && access.checkedLater &&
                !access.optional &&
                (access.excluded & access.checkedLater) !== access.checkedLater
            )) {
                return true;
            }
            const invoke = stmt.getInvokeExpr();
            if (invoke && [...libraryRegistry.getNonNullArgumentIndices(stmt)]
                .some(index => this.isPotentiallyNullableType(
                    invoke.getArgs()[index]?.getType()
                ))) {
                return true;
            }
        }
        return false;
    }

    private isPotentiallyNullableType(type: Type | undefined): boolean {
        if (!type) return false;
        if (type instanceof NullType || type instanceof UndefinedType) return true;
        if (type instanceof AliasType) {
            return this.isPotentiallyNullableType(type.getOriginalType());
        }
        return type instanceof UnionType &&
            type.getTypes().some(member =>
                this.isPotentiallyNullableType(member)
            );
    }

    private recordReached(
        factsByStatement: ReadonlyMap<Stmt, readonly NullnessFact[]>,
        reachedMethods: Set<ArkMethod>,
        reachedStatements: Set<Stmt>
    ): void {
        for (const [stmt, facts] of factsByStatement) {
            const method = stmt.getCfg()?.getDeclaringMethod();
            if (method) reachedMethods.add(method);
            if (facts.some(fact => fact.isZeroFact())) {
                reachedStatements.add(stmt);
            }
        }
    }

    private mergeDiagnostics(
        target: NullDereferenceDiagnostic[],
        incoming: readonly NullDereferenceDiagnostic[]
    ): void {
        for (const diagnostic of incoming) {
            if (target.some(existing =>
                existing.dereferenceLocation.filePath === diagnostic.dereferenceLocation.filePath &&
                existing.dereferenceLocation.line === diagnostic.dereferenceLocation.line &&
                existing.dereferenceLocation.col === diagnostic.dereferenceLocation.col &&
                existing.accessPath.equals(diagnostic.accessPath))) {
                continue;
            }
            target.push(diagnostic);
        }
    }

    private mergeReachedFacts(
        target: Map<Stmt, NullnessFact[]>,
        incoming: Map<Stmt, NullnessFact[]>
    ): void {
        let index = this.mergedFactIndexes.get(target);
        if (!index) {
            index = new Map();
            for (const [stmt, facts] of target) {
                const buckets = new Map<number, NullnessFact[]>();
                for (const fact of facts) {
                    const bucket = buckets.get(fact.hashCode());
                    if (bucket) bucket.push(fact);
                    else buckets.set(fact.hashCode(), [fact]);
                }
                index.set(stmt, buckets);
            }
            this.mergedFactIndexes.set(target, index);
        }
        for (const [stmt, facts] of incoming) {
            const merged = target.get(stmt) ?? [];
            const buckets = index.get(stmt) ?? new Map<number, NullnessFact[]>();
            for (const fact of facts) {
                const hash = fact.hashCode();
                const bucket = buckets.get(hash);
                if (bucket?.some(existing => existing.equals(fact))) continue;
                merged.push(fact);
                if (bucket) bucket.push(fact);
                else buckets.set(hash, [fact]);
            }
            target.set(stmt, merged);
            index.set(stmt, buckets);
        }
    }
}
