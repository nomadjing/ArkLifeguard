import { beforeAll, describe, expect, it } from 'vitest';
import type { Scene } from '../../src/adapter/arkanalyzer';
import { ResourceRunner, resolveHarmonyResourceRules } from '../../src/analysis/resourceleak';
import { buildResourceScene, fixturePath } from '../helpers/buildScene';

describe('HarmonyOS SDK resource rules', () => {
    let scene: Scene;
    beforeAll(() => {
        scene = buildResourceScene('platform', fixturePath('resource', 'platform-sdk'));
    });
    const run = (name: string) => {
        const method = scene.getMethods().find(method =>
            method.getDeclaringArkClass().getName() === 'PlatformCases' && method.getName() === name);
        if (!method) throw new Error(`Missing fixture ${name}`);
        return new ResourceRunner(scene, undefined, true).runWithDummyMain(method);
    };

    it('resolves all ten resource families against SDK declarations', () => {
        const resolved = resolveHarmonyResourceRules(scene);
        expect(resolved.unresolvedRuleIds).toEqual([]);
        expect(resolved.rules).toHaveLength(10);
    });

    it.each([
        ['http', 'HttpRequestNotDestroyed'], ['file', 'FileNotClosed'],
        ['fileio', 'FileIONotClosed'], ['source', 'ImageSourceNotReleased'],
        ['pixel', 'PixelMapNotReleased'], ['packer', 'ImagePackerNotReleased'],
        ['player', 'AVPlayerNotReleased'], ['renderer', 'AudioRendererNotReleased'],
        ['capturer', 'AudioCapturerNotReleased'], ['result', 'ResultSetNotClosed'],
    ])('detects a missing release and accepts the matching release for %s', (name, ruleId) => {
        const leaking = run(`${name}Leak`);
        expect(leaking.status).toBe('success');
        expect(leaking.diagnostics).toMatchObject([{ ruleId, reason: 'unreleased', confidence: 'high' }]);
        expect(leaking.diagnostics).toHaveLength(1);
        expect(run(`${name}Release`).diagnostics).toEqual([]);
    });

    it('pairs only the correct file handle, including fd aliases', () => {
        expect(run('fileDescriptorAlias').diagnostics).toEqual([]);
        expect(run('fileWrongObject').diagnostics).toMatchObject([{ ruleId: 'FileNotClosed' }]);
        expect(run('fileWrongObject').diagnostics).toHaveLength(1);
    });

    it('propagates fulfilled handles without calling the Promise itself a resource', () => {
        expect(run('fileAwaitRelease').diagnostics).toEqual([]);
        expect(run('pixelAwaitRelease').diagnostics).toEqual([]);
        expect(run('pendingPlayer').diagnostics).toMatchObject([{
            reason: 'unknown-ownership', confidence: 'low',
        }]);
        expect(run('callbackPlayer').diagnostics).toMatchObject([{
            reason: 'unknown-ownership', confidence: 'low',
        }]);
    });

    it('excludes user APIs with the same names and reports coverage separately from leaks', () => {
        const result = run('userApi');
        expect(result.diagnostics).toEqual([]);
        expect(result.solverStatistics?.processedEdges).toBeGreaterThan(0);
        const http = result.coverage?.find(item => item.ruleId === 'HttpRequestNotDestroyed');
        expect(http?.allocatorCalls).toBe(2);
        expect(http?.reachedAllocatorCalls).toBe(0);
    });
});
