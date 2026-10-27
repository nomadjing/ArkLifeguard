/** Local, fixture-only comparison. No solver or real-app benchmark is run. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { ArkMethod } from '../src/adapter/arkanalyzer';
import { createLifecycleModelCreator } from '../src/lifecycle/LifecycleModelEntry';

const root = path.resolve(__dirname, '..');
const ownRequire = createRequire(path.join(root, 'package.json'));
const homeflowRoot = path.resolve(process.argv[2] ?? path.join(root, '../homeflow'));
const homeRequire = createRequire(path.join(homeflowRoot, 'package.json'));
type Analyzer = typeof import('arkanalyzer');
// Each implementation builds its own Scene: never mix IR objects across versions.
const own: Analyzer = ownRequire('arkanalyzer');
const home: Analyzer = homeRequire('arkanalyzer');

function build(api: Analyzer, fixture: string) {
    const project = path.join(root, 'test/fixtures/lifecycle', fixture);
    const config = new api.SceneConfig();
    config.buildConfig(project, project, [{
        name: 'test-sdk', path: path.join(root, 'test/fixtures/sdk'), moduleName: '',
    }]);
    config.buildFromProjectDir(project);
    const scene = new api.Scene();
    scene.buildSceneFromProjectDir(config);
    scene.inferTypes(2);
    return scene;
}

function summarize(main: ArkMethod) {
    const cfg = main.getCfg()!;
    const blocks = [...cfg.getBlocks()];
    const methods = new Set<string>();
    for (const stmt of cfg.getStmts()) {
        const signature = stmt.getInvokeExpr()?.getMethodSignature();
        if (!signature) continue;
        const name = signature.getMethodSubSignature().getMethodName();
        if (['constructor', '%statInit', '%instInit'].includes(name)) continue;
        methods.add(`${signature.getDeclaringClassSignature().getClassName()}.${name}`);
    }
    return {
        blocks: blocks.length,
        edges: blocks.reduce((count, block) => count + block.getSuccessors().length, 0),
        directMethods: [...methods].sort(),
    };
}

function compare(fixture: string) {
    const foreign = new home.DummyMainCreater(build(home, fixture), undefined, undefined, true);
    foreign.createDummyMain();
    const homeflow = summarize(foreign.getDummyMain());
    const creator = createLifecycleModelCreator(build(own, fixture));
    creator.create();
    const summary = summarize(creator.getDummyMain());
    return { homeflow, flat: {
        ...summary,
        uiRegistrations: creator.getComponents().reduce((count, component) => count + component.uiCallbacks.length, 0),
        onlyCurrent: summary.directMethods.filter(method => !homeflow.directMethods.includes(method)),
        onlyHomeflow: homeflow.directMethods.filter(method => !summary.directMethods.includes(method)),
    } };
}

const log = console.log;
let result;
try {
    console.log = () => {};
    result = {
        versions: {
            current: ownRequire('arkanalyzer/package.json').version as string,
            homeflow: homeRequire('arkanalyzer/package.json').version as string,
        },
        // These fixtures have no overloads; class + method name identifies a target.
        fixtures: Object.fromEntries([
            'lifecycle-coverage', 'simple', 'complex-ui', 'ability-scope-nesting', 'callback-shapes',
        ].map(fixture => [fixture, compare(fixture)])),
    };
} finally {
    console.log = log;
}
const json = JSON.stringify(result, null, 2);
if (process.argv[3]) fs.writeFileSync(process.argv[3], `${json}\n`);
else console.log(json);
