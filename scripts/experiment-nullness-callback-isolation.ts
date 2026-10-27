/** One project/mode per process. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Scene, SceneConfig } from 'arkanalyzer';
import { createLifecycleModelCreator } from '../src/lifecycle';
import { NullnessAnalysisRunner, NULLNESS_LIFECYCLE_ORDER } from '../src/analysis/nullness/NullnessAnalysisRunner';
import { isolateCallbackDispatch } from './lib/isolate-callback-dispatch';

const [name, mode, output, ...flags] = process.argv.slice(2);
if (!name || !['baseline', 'single-callback', 'callback-isolated'].includes(mode) || !output ||
    flags.some(flag => !['--lifecycle-only'].includes(flag))) {
    throw new Error('Usage: vite-node scripts/experiment-nullness-callback-isolation.ts <project> <baseline|single-callback|callback-isolated> <output> [--lifecycle-only]');
}
const lifecycleOnly = flags.includes('--lifecycle-only');
const root = process.cwd();
const project = JSON.parse(fs.readFileSync('HarmonyRealApps/meta.json', 'utf8')).projects
    .find((p: { name: string }) => p.name === name);
if (!project) throw new Error(`Unknown project ${name}`);
const projectPath = path.resolve('HarmonyRealApps', project.path);
function snapshot(directory: string): string {
    const hash = createHash('sha256');
    function walk(dir: string): void {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (['.git', 'node_modules', '.hvigor', 'build'].includes(entry.name)) continue;
            const filename = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(filename);
            else if (/\.(ts|ets|json|json5)$/.test(entry.name)) {
                hash.update(path.relative(directory, filename)).update('\0').update(fs.readFileSync(filename)).update('\0');
            }
        }
    }
    walk(directory);
    return hash.digest('hex');
}
const sdkRoot = path.resolve('sdk/default');
const provenance = { sourceSha256: snapshot(projectPath), implementationSha256: snapshot(path.join(root, 'src')),
    sdkSha256: snapshot(sdkRoot), scriptsSha256: createHash('sha256')
        .update(fs.readFileSync('scripts/experiment-nullness-callback-isolation.ts'))
        .update(fs.readFileSync('scripts/lib/isolate-callback-dispatch.ts')).digest('hex'),
    node: process.version, metadataCommit: project.resolvedCommit };
const start = performance.now();
const config = new SceneConfig();
config.buildConfig(projectPath, projectPath, [
    { name: 'ohosSdk', path: path.join(sdkRoot, 'openharmony/ets'), moduleName: '' },
    { name: 'hmsSdk', path: path.join(sdkRoot, 'hms/ets'), moduleName: '' },
]);
config.buildFromProjectDir(projectPath);
const scene = new Scene();
scene.buildSceneFromProjectDir(config);
scene.inferTypes();
const sceneTimeMs = performance.now() - start;
const modelStart = performance.now();
const creator = createLifecycleModelCreator(scene, { lifecycleOrder: NULLNESS_LIFECYCLE_ORDER });
creator.create();
const main = creator.getDummyMain();
const calls = () => main.getCfg()!.getStmts().flatMap(stmt => {
    const target = stmt.getInvokeExpr()?.getMethodSignature().toString();
    return target ? [target] : [];
}).sort();
const beforeCalls = calls();
const events = new Set([
    ...creator.getAbilities().flatMap(a => [...a.lifecycleMethods.values()]),
    ...creator.getComponents().flatMap(c => [...c.lifecycleMethods.values(), ...c.uiCallbacks.map(x => x.callbackMethod)]),
].map(method => method.getSignature().toString()));
const isolatedBranches = mode !== 'baseline' ? isolateCallbackDispatch(main, events, mode !== 'single-callback') : null;
if (JSON.stringify(beforeCalls) !== JSON.stringify(calls())) throw new Error('Direct-call coverage changed');
const modelTimeMs = performance.now() - modelStart;
const regionCounts: Record<string, { dummyZero: number; dummyNonzero: number; methodZero: number; methodNonzero: number }> = {};
let inspectionTimeMs = 0;
const analyzeStart = performance.now();
const result = new NullnessAnalysisRunner(scene, {
    collectSolverStatistics: true,
    analyzeModuleInitializers: !lifecycleOnly,
    analyzeFrameworkSinkMethods: !lifecycleOnly,
}).runWithDummyMain(main,
    (solver, kind) => {
        const inspectStart = performance.now();
        const counts = regionCounts[kind] ??= { dummyZero: 0, dummyNonzero: 0, methodZero: 0, methodNonzero: 0 };
        for (const edge of solver.getPathEdgeSet()) {
            const dummy = edge.edgeEnd.node.getCfg() === main.getCfg();
            const zero = edge.edgeEnd.fact.isZeroFact();
            counts[dummy ? zero ? 'dummyZero' : 'dummyNonzero' : zero ? 'methodZero' : 'methodNonzero']++;
        }
        inspectionTimeMs += performance.now() - inspectStart;
    });
const analysisTimeMs = performance.now() - analyzeStart - inspectionTimeMs;
const totalTimeMs = performance.now() - start - inspectionTimeMs;
const diagnostics = result.diagnostics.map(d => ({
    kind: d.kind, nullness: d.nullness, accessPath: d.accessPath.toString(),
    sourceLocation: d.sourceLocation, dereferenceLocation: d.dereferenceLocation,
    sourceText: d.sourceStmt.getOriginalText() ?? d.sourceStmt.toString(),
    dereferenceText: d.dereferenceStmt.getOriginalText() ?? d.dereferenceStmt.toString(),
    description: d.description, confidence: d.confidence,
}));
const blocks = [...main.getCfg()!.getBlocks()];
const ids = new Map(blocks.map((b, i) => [b, i]));
const record = { name, mode, lifecycleModel: 'flat', lifecycleOnly, success: result.success, error: result.error, provenance,
    timing: { sceneTimeMs, modelTimeMs, analysisTimeMs, totalTimeMs, excludedInspectionTimeMs: inspectionTimeMs,
        excluded: ['process startup', 'input hashes', 'solver-region inspection', 'serialization'] },
    solverStatistics: result.solverStatistics, solverBreakdown: result.solverBreakdown, regionCounts,
    diagnostics, reachedStatements: result.reachedFacts.size,
    reachedFacts: [...result.reachedFacts.values()].reduce((n, facts) => n + facts.length, 0),
    graph: { blocks: blocks.map((b, id) => ({ id, successors: b.getSuccessors().map(x => ids.get(x)),
        statements: b.getStmts().map(s => s.toString()) })), isolatedBranches,
        directCallCoveragePreserved: true },
    limitations: ['Aggressive event underapproximation: legal cross-event behavior is excluded.',
        'Initialization, teardown, method bodies and static-field side-channel diagnostics are retained.',
        lifecycleOnly ? 'Supplemental roots are disabled in all compared modes.' : 'Supplemental roots are retained.'],
};
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
if (!result.success) process.exitCode = 1;
