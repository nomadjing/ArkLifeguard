import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplicationSceneConfig } from '../../src/application/ApplicationScene';
import {
    findHarmonyApplicationSourceRoots,
    isApplicationSource,
} from '../../src/application/SourceScanRules';

describe('application source scan boundaries', () => {
    it.each(['entry/src/test/Case.ets', 'entry/src/ohosTest/Case.ets', 'tests/input.ts',
        '.agents/skills/templates/demo/entry/src/main/ets/Index.ets', '.codex/examples/Index.ts',
        '.git/samples/example.js', '.vscode/samples/demo.ts', '.hvigor/cache/Index.ts',
        '.local-generator/app/entry/src/main/ets/Index.ets', 'node_modules/pkg/Index.ts',
        'oh_modules/pkg/Index.ts', 'third_party/td/example.js', 'vendor/pkg/Index.ts',
        'build-tools/Index.ts', 'build/Index.ts',
        'lib/Index.ets', 'libs/Index.ets', 'hvigorfile.ts', 'hvigor-wrapper.js',
        'entry/src/main/ets/Case.test.ets', 'entry/src/main/resources/rawfile/mermaid/main.js'])(
        'excludes test or resource input: %s', file => {
            expect(isApplicationSource('/project', `/project/${file}`)).toBe(false);
        });
    it.each(['markdown/src/main/ets/library/Index.ets',
        'entry/src/main/ets/resource/ResourceManager.ets', 'entry/src/main/ets/Latest.ets',
        'entry/src/main/ets/api.d.ts', 'entry/src/main/ets/utils/helper.js'])(
        'preserves production input: %s', file => {
            expect(isApplicationSource('/project', `/project/${file}`)).toBe(true);
        });
    it('removes non-application files before Scene construction', () => {
        const project = fs.mkdtempSync(path.join(os.tmpdir(), 'arklifeguard-source-filter-'));
        try {
            for (const file of [
                'entry/src/main/ets/Index.ets',
                'entry/src/main/ets/Keep.js',
                'entry/src/test/Case.ets',
                'entry/src/ohosTest/Case.ets',
                'node_modules/pkg/Index.ts',
                'oh_modules/pkg/Index.ts',
                'third_party/td/example.js',
                'vendor/pkg/Index.ts',
                'lib/Index.ets',
                'libs/Index.ets',
                'build/Index.ets',
                'hvigorfile.ts',
            ]) {
                const filename = path.join(project, file);
                fs.mkdirSync(path.dirname(filename), { recursive: true });
                fs.writeFileSync(filename, '');
            }

            const config = createApplicationSceneConfig('fixture', project, []);
            const files = config.getProjectFiles()
                .map(file => path.relative(project, file).replace(/\\/g, '/'))
                .sort();

            expect(files).toEqual([
                'entry/src/main/ets/Index.ets',
                'entry/src/main/ets/Keep.js',
            ]);
        } finally {
            fs.rmSync(project, { recursive: true, force: true });
        }
    });
    it('limits inputs to HarmonyOS build-profile module roots', () => {
        const project = fs.mkdtempSync(path.join(os.tmpdir(), 'arklifeguard-module-filter-'));
        try {
            const write = (file: string, content = ''): void => {
                const filename = path.join(project, file);
                fs.mkdirSync(path.dirname(filename), { recursive: true });
                fs.writeFileSync(filename, content);
            };
            write('build-profile.json5', JSON.stringify({
                app: { products: [{ runtimeOS: 'HarmonyOS' }] },
                modules: [{ name: 'entry', srcPath: './HarmonyApp' }],
            }));
            write('HarmonyApp/entry/src/main/module.json5', '{"module":{"name":"entry"}}');
            write('HarmonyApp/entry/src/main/ets/Index.ets');
            write('tools/true-chain-harness/generated/Duplicate.ets');
            write('extensions/aira-sync/src/Extension.ets');

            const roots = findHarmonyApplicationSourceRoots(project)
                .map(root => path.relative(project, root).replace(/\\/g, '/'));
            expect(roots).toEqual(['HarmonyApp']);

            const config = createApplicationSceneConfig('fixture', project, []);
            const files = config.getProjectFiles()
                .map(file => path.relative(project, file).replace(/\\/g, '/'))
                .sort();
            expect(files).toEqual(['HarmonyApp/entry/src/main/ets/Index.ets']);
        } finally {
            fs.rmSync(project, { recursive: true, force: true });
        }
    });
});
