/** Performance experiment: excludes repeated and cross-event dispatch paths. */
import fs from 'node:fs';
import { isolateNativeDispatch } from './lib/isolate-native-dispatch';
import { DummyMainCreater } from 'arkanalyzer';
import path from 'node:path';
import { Scene, SceneConfig } from '../src/adapter/arkanalyzer';
import { createLifecycleModelCreator } from '../src/lifecycle';
import { NULLNESS_LIFECYCLE_ORDER } from '../src/analysis/nullness/NullnessAnalysisRunner';
import { ResourceRunner } from '../src/analysis/resourceleak/ResourceRunner';
import { ListenerRunner } from '../src/analysis/resourceleak/ListenerRunner';
const [name, mode, output] = process.argv.slice(2);
if (!name || !['baseline', 'single-callback', 'native', 'native-single-callback'].includes(mode) || !output) {
    throw new Error('Usage: <project-name> <baseline|single-callback|native|native-single-callback> <output.json>');
}
const project = JSON.parse(fs.readFileSync('HarmonyRealApps/meta.json', 'utf8')).projects
    .find((p: { name: string }) => p.name === name);
if (!project) throw new Error(`Unknown project: ${name}`);
const started = Date.now();
const duration: Record<string, number> = {};
function timed<T>(stage: string, action: () => T): T {
    const start = Date.now();
    console.error(JSON.stringify({ stage, event: 'start', elapsedMs: start - started, memory: process.memoryUsage() }));
    const result = action();
    duration[stage] = Date.now() - start;
    console.error(JSON.stringify({ stage, event: 'end', durationMs: duration[stage], memory: process.memoryUsage() }));
    return result;
}
const scene = timed('scene', () => {
    const config = new SceneConfig();
    config.buildConfig(name, path.resolve('HarmonyRealApps', project.path), [
        { name: 'ohosSdk', path: path.resolve('sdk/default/openharmony/ets'), moduleName: '' },
        { name: 'hmsSdk', path: path.resolve('sdk/default/hms/ets'), moduleName: '' },
    ]);
    config.buildFromProjectDir(path.resolve('HarmonyRealApps', project.path));
    const scene = new Scene();
    scene.buildSceneFromProjectDir(config);
    scene.inferTypes();
    return scene;
});
const creator = timed('lifecycle', () => {
    if (mode === 'native' || mode === 'native-single-callback') {
        const creator = new DummyMainCreater(scene, undefined, undefined, true);
        creator.createDummyMain();
        if (mode === 'native-single-callback') isolateNativeDispatch(creator.getDummyMain());
        return creator;
    }
    const creator = createLifecycleModelCreator(scene, {
        lifecycleOrder: NULLNESS_LIFECYCLE_ORDER, singleCallback: mode === 'single-callback',
    });
    creator.create();
    return creator;
});
const main = creator.getDummyMain();
fs.mkdirSync(path.dirname(output), { recursive: true });
const cfg = main.getCfg()!;
const dummyMain = { blocks: cfg.getBlocks().size, statements: cfg.getStmts().length,
    directCalls: cfg.getStmts().flatMap(stmt => {
        const signature = stmt.getInvokeExpr()?.getMethodSignature().toString();
        return signature ? [signature] : [];
    }) };
const resource = timed('resource', () => new ResourceRunner(scene, undefined, true).runWithDummyMain(main));
fs.writeFileSync(output + '.partial.json', JSON.stringify({ name, mode, completed: false, duration, dummyMain, resource }, null, 2));
const listener = timed('listener', () => new ListenerRunner(scene, undefined, true).runWithDummyMain(main));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ name, mode, success: resource.success && listener.success,
    sdkRoot: path.resolve('sdk/default'), duration, dummyMain, peakRssMiB: process.resourceUsage().maxRSS / 1024, totalMs: Date.now() - started,
    resource, listener }, null, 2));

fs.unlinkSync(output + '.partial.json');
