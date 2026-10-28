import { beforeAll, describe, expect, it } from 'vitest';
import type { Scene } from '../../src/adapter/arkanalyzer';
import { ResourceRunner, resolveHarmonyResourceRules } from '../../src/analysis/resourceleak';
import { buildResourceScene, fixturePath } from '../helpers/buildScene';

describe('image memory in unified resource obligations', () => {
    let scene: Scene;
    let platform: Scene;
    beforeAll(() => {
        scene = buildResourceScene('memory-obligations', fixturePath('resource', 'platform-sdk'));
        platform = buildResourceScene('platform', fixturePath('resource', 'platform-sdk'));
    });
    const entry = (source: Scene, owner: string, name: string) => {
        const method = source.getMethods().find(method =>
            method.getDeclaringArkClass().getName() === owner && method.getName() === name);
        if (!method) throw new Error(`Missing ${owner}.${name}`);
        return method;
    };
    const run = (name: string) => new ResourceRunner(scene, undefined, true)
        .runWithDummyMain(entry(scene, 'MemoryCases', name));

    it.each([['source', 'ImageSourceNotReleased'], ['pixel', 'PixelMapNotReleased'], ['packer', 'ImagePackerNotReleased']])(
        'finds missing cleanup and accepts matching cleanup for %s', (name, ruleId) => {
            const method = (suffix: string) => entry(platform, 'PlatformCases', `${name}${suffix}`);
            const leak = new ResourceRunner(platform).runWithDummyMain(method('Leak'));
            expect(leak.success, leak.error).toBe(true);
            expect(leak.diagnostics).toMatchObject([{ ruleId, reason: 'unreleased', confidence: 'high' }]);
            expect(leak.diagnostics).toHaveLength(1);
            expect(leak.diagnostics[0].allocation.line).toBeGreaterThan(0);
            expect(new ResourceRunner(platform).runWithDummyMain(method('Release')).diagnostics).toEqual([]);
        });
    it.each(['aliasRelease', 'lifecycleRelease', 'promiseRelease', 'promiseThenRelease',
        'conditionalRelease', 'releaseThrows', 'userApi'])(
        'honors aliases, lifecycle calls and the reachable-release contract: %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.diagnostics).toEqual([]);
            expect(result.solverStatistics?.processedEdges).toBeGreaterThan(0);
            expect(result).not.toHaveProperty('memoryRetentionCandidates');
        });
    it.each(['wrongObject', 'unreachableRelease', 'overwritten', 'clearIsNotRelease', 'lifecycleLeak'])(
        'keeps the original allocation obligation for %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0].ruleId).toBe('PixelMapNotReleased');
        });
    it('reports image and system resources together in a single solve', () => {
        expect(run('mixed').diagnostics.map(item => item.ruleId).sort())
            .toEqual(['HttpRequestNotDestroyed', 'PixelMapNotReleased']);
    });
    it('does not interpret ordinary objects, retained buffers or listener registrations as explicit memory sources', () => {
        const retained = buildResourceScene('retention', fixturePath('resource', 'platform-sdk'));
        for (const name of ['StaticRetained', 'BufferRetained', 'SelfCycle', 'EventLeak']) {
            const result = new ResourceRunner(retained).runWithDummyMain(entry(retained, 'Cases', `${name}Case`));
            expect(result.success, result.error).toBe(true);
            expect(result.diagnostics).toEqual([]);
        }
    });
    it('fails for empty and invalid rules', () => {
        const method = entry(scene, 'MemoryCases', 'mixed');
        expect(new ResourceRunner(scene, []).runWithDummyMain(method).success).toBe(false);
        const rules = resolveHarmonyResourceRules(scene).rules;
        expect(new ResourceRunner(scene, [{ ...rules[0], allocators: [] }]).runWithDummyMain(method).success).toBe(false);
    });
});
