#!/usr/bin/env -S npx vite-node

/**
 * Scope-propagation profiler for the hierarchical lifecycle model.
 *
 * Runs the main DummyMain nullness IFDS solve and reports, per lifecycle scope,
 * how many distinct dataflow facts reach each scope head (experiment 1: scope
 * loop churn) and how many facts flow into the cross-scope fallback region or
 * into a Page scope owned by a different Page (experiment 2: cross-scope flow).
 *
 * Read-only instrumentation: it never changes the scene, CFG, flow functions,
 * or solver scheduling, so the diagnostics are identical to a normal run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sdk } from 'arkanalyzer/lib/Config';
import { Scene, SceneConfig } from '../src/adapter/arkanalyzer';
import type { Stmt } from '../src/adapter/arkanalyzer';
import {
    createLifecycleModelCreator,
    type ScopeModelInfo,
} from '../src/lifecycle';
import { NULLNESS_LIFECYCLE_ORDER } from '../src/analysis/nullness/NullnessAnalysisRunner';
import { NullnessFact } from '../src/analysis/nullness/NullnessFact';
import { NullnessProblem } from '../src/analysis/nullness/NullnessProblem';
import { NullnessSolver } from '../src/analysis/nullness/NullnessSolver';
import { NullnessLibraryRegistry } from '../src/analysis/nullness/library/NullnessLibraryRegistry';

interface Options {
    projectPath: string;
    sdkRoot?: string;
    sdkPaths: string[];
    output?: string;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const defaultSdkRoot = path.join(projectRoot, 'sdk/default');
const FALLBACK_OWNER = '<fallback>';

function value(args: string[], index: number, option: string): string {
    const result = args[index + 1];
    if (!result || result.startsWith('--')) throw new Error(`${option} requires a value`);
    return result;
}

function parseArgs(args: string[]): Options {
    let projectPath: string | undefined;
    let sdkRoot: string | undefined;
    const sdkPaths: string[] = [];
    let output: string | undefined;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--sdk-root') { sdkRoot = value(args, index, arg); index++; continue; }
        if (arg === '--sdk') { sdkPaths.push(value(args, index, arg)); index++; continue; }
        if (arg === '--output') { output = value(args, index, arg); index++; continue; }
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        if (projectPath) throw new Error(`Unexpected positional argument: ${arg}`);
        projectPath = arg;
    }
    if (!projectPath) throw new Error('Missing project path.');
    if (!path.isAbsolute(projectPath)) throw new Error(`Project path must be absolute: ${projectPath}`);
    return { projectPath, sdkRoot, sdkPaths, output };
}

function discoverSdks(options: Options): Sdk[] {
    const sdkRoot = options.sdkRoot ? path.resolve(options.sdkRoot)
        : options.sdkPaths.length === 0 ? defaultSdkRoot : undefined;
    const candidates = sdkRoot
        ? ([['ohosSdk', path.join(sdkRoot, 'openharmony/ets')], ['hmsSdk', path.join(sdkRoot, 'hms/ets')]] as const)
        : options.sdkPaths.map((sdk, index) => [`sdk${index + 1}`, path.resolve(sdk)] as const);
    const result: Sdk[] = [];
    for (const [name, candidate] of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            result.push({ name, path: candidate, moduleName: '' });
        }
    }
    if (result.length === 0) throw new Error(`No ETS SDK found under ${sdkRoot ?? options.sdkPaths.join(',')}`);
    return result;
}

interface HeadReport {
    distinctFacts: number;
    /** Facts whose synthetic-instance owner is a *different* Page scope. */
    foreignFacts: number;
    /** owner -> fact count. owner is a pageId, '<fallback>', or '<other>'. */
    owners: Record<string, number>;
}

function buildScene(options: Options): Scene {
    const sdks = discoverSdks(options);
    const config = new SceneConfig();
    config.buildConfig(path.basename(options.projectPath), options.projectPath, sdks);
    const scene = new Scene();
    scene.buildSceneFromProjectDir(config);
    scene.inferTypes();
    return scene;
}

function ownerNameOf(fact: NullnessFact, ownerByInstance: Map<string, string>): string | null {
    const base = fact.accessPath.base;
    if (!base) return null;
    const name = base.getName();
    return ownerByInstance.get(name) ?? '<other>';
}

function analyzeHead(
    facts: NullnessFact[],
    scopePageId: string | undefined,
    ownerByInstance: Map<string, string>,
): HeadReport {
    const owners: Record<string, number> = {};
    let foreignFacts = 0;
    for (const fact of facts) {
        const owner = ownerNameOf(fact, ownerByInstance) ?? '<other>';
        owners[owner] = (owners[owner] ?? 0) + 1;
        if (scopePageId !== undefined && owner !== '<other>' && owner !== FALLBACK_OWNER && owner !== scopePageId) {
            foreignFacts++;
        }
    }
    return { distinctFacts: facts.length, foreignFacts, owners };
}

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    const scene = buildScene(options);
    const creator = createLifecycleModelCreator(scene, 'hierarchical', {
        lifecycleOrder: NULLNESS_LIFECYCLE_ORDER,
    });
    creator.create();
    const dummyMain = creator.getDummyMain();
    const scopeInfo = creator.getScopeModelInfo();
    if (!scopeInfo) throw new Error('hierarchical model did not expose scope info');

    const cfg = dummyMain.getCfg();
    const entryStmt = cfg?.getStartingStmt() ?? cfg?.getStartingBlock()?.getHead();
    if (!cfg || !entryStmt) throw new Error('DummyMain has no CFG entry');
    const libraryRegistry = NullnessLibraryRegistry.createDefault(scene);
    const problem = new NullnessProblem(entryStmt, dummyMain, {
        maxAccessPathLength: 5,
        maxPropagationDepth: 40,
    }, libraryRegistry);
    const solver = new NullnessSolver(problem, scene, [], { collectStatistics: true });
    solver.solve();
    const reached = solver.getReachedFacts();
    const solverStatistics = solver.getStatistics();

    // Map synthetic-instance Local name -> owning Page scope (or fallback).
    const ownerByInstance = new Map<string, string>();
    for (const scope of scopeInfo.pageScopes) {
        for (const name of scope.instanceNames) ownerByInstance.set(name, scope.pageId);
    }
    for (const name of scopeInfo.fallbackInstanceNames) ownerByInstance.set(name, FALLBACK_OWNER);

    const factsAt = (stmt: Stmt | undefined): NullnessFact[] =>
        (stmt ? reached.get(stmt) ?? [] : []).filter(fact => !fact.isZeroFact());

    let totalNonZeroFacts = 0;
    let dummyMainStmtsWithFacts = 0;
    for (const [stmt, facts] of reached.entries()) {
        if (stmt.getCfg()?.getDeclaringMethod() !== dummyMain) continue;
        const nonZero = facts.filter(fact => !fact.isZeroFact());
        if (nonZero.length > 0) dummyMainStmtsWithFacts++;
        totalNonZeroFacts += nonZero.length;
    }

    const pageScopes = scopeInfo.pageScopes.map(scope => {
        const headFacts = factsAt(scope.head);
        const eventHeadFacts = factsAt(scope.eventHead);
        const union = [...headFacts];
        for (const fact of eventHeadFacts) {
            if (!union.some(existing => existing.equals(fact))) union.push(fact);
        }
        return {
            pageId: scope.pageId,
            head: analyzeHead(headFacts, scope.pageId, ownerByInstance),
            eventHead: analyzeHead(eventHeadFacts, scope.pageId, ownerByInstance),
            unionDistinctFacts: union.length,
            foreignUnionFacts: union.filter(fact => {
                const owner = ownerNameOf(fact, ownerByInstance);
                return owner !== null && owner !== '<other>' && owner !== FALLBACK_OWNER && owner !== scope.pageId;
            }).length,
        };
    });

    const fallbackHeadFacts = factsAt(scopeInfo.fallbackHead);
    const fallbackHeadReport = analyzeHead(fallbackHeadFacts, undefined, ownerByInstance);
    const factsAtFallbackOwnedByPage = fallbackHeadFacts.filter(fact => {
        const owner = ownerNameOf(fact, ownerByInstance);
        return owner !== null && owner !== '<other>' && owner !== FALLBACK_OWNER;
    }).length;

    const totalDistinctAtPageHeads = pageScopes.reduce((sum, scope) => sum + scope.unionDistinctFacts, 0);
    const totalForeignAtPageHeads = pageScopes.reduce((sum, scope) => sum + scope.foreignUnionFacts, 0);

    const report = {
        project: options.projectPath,
        model: 'hierarchical',
        totals: {
            nonZeroFactsInDummyMain: totalNonZeroFacts,
            dummyMainStmtsWithFacts,
        },
        solverStatistics: solverStatistics ? {
            processedEdges: solverStatistics.processedEdges,
            propagationAttempts: solverStatistics.propagationAttempts,
            finalPathEdgeCount: solverStatistics.finalPathEdgeCount,
            solveTimeMs: solverStatistics.solveTimeMs,
        } : null,
        abilityHead: analyzeHead(factsAt(scopeInfo.abilityHead), undefined, ownerByInstance),
        pageScopes,
        fallback: {
            head: fallbackHeadReport,
            returnHead: analyzeHead(factsAt(scopeInfo.fallbackReturnHead), undefined, ownerByInstance),
            factsAtFallbackHeadOwnedByPage: factsAtFallbackOwnedByPage,
        },
        crossScope: {
            totalDistinctFactsAtPageHeads: totalDistinctAtPageHeads,
            totalForeignFactsAtPageHeads: totalForeignAtPageHeads,
            factsAtFallbackHeadOwnedByPage: factsAtFallbackOwnedByPage,
            foreignShareOfPageHeadFacts: totalDistinctAtPageHeads === 0
                ? 0 : totalForeignAtPageHeads / totalDistinctAtPageHeads,
            fallbackOwnedShareOfAllFacts: totalNonZeroFacts === 0
                ? 0 : fallbackHeadReport.distinctFacts / totalNonZeroFacts,
        },
    };

    const json = JSON.stringify(report, null, 2);
    if (options.output) {
        fs.mkdirSync(path.dirname(options.output), { recursive: true });
        fs.writeFileSync(options.output, `${json}\n`);
        console.log(`Wrote ${options.output}`);
    } else {
        console.log(json);
    }
}

try {
    main();
} catch (error) {
    console.error(`profile-scope-propagation: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
