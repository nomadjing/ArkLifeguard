import { beforeAll, describe, expect, it } from 'vitest';
import type { Scene } from '../../src/adapter/arkanalyzer';
import { MemoryRunner } from '../../src/analysis/memory';
import type { HeapFlowOptions } from '../../src/analysis/shared/HeapFlow';
import { buildResourceScene, fixturePath } from '../helpers/buildScene';

describe('managed-memory retention at owner lifecycle boundaries', () => {
    let scene: Scene;
    let options: HeapFlowOptions;
    beforeAll(() => {
        scene = buildResourceScene('retention', fixturePath('resource', 'platform-sdk'));
        options = { lifetimes: scene.getClasses().flatMap(cls => {
            const end = cls.getMethods().find(method => method.getName() === 'onDestroy');
            return end ? [{ classSignature: cls.getSignature().toString(), endMethodSignatures: [end.getSignature().toString()] }] : [];
        }) };
    });
    const run = (name: string, override: HeapFlowOptions = {}) => {
        const entry = scene.getMethods().find(method => method.getDeclaringArkClass().getName() === 'Cases' && method.getName() === `${name}Case`);
        if (!entry) throw new Error(`Missing ${name}`);
        return new MemoryRunner(scene, { ...options, ...override }).runWithDummyMain(entry);
    };
    it.each(['StaticRetained', 'BufferRetained', 'ContainerRetained', 'MapRetained', 'PartialClear'])(
        'finds an explicit root and strong retention chain for %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.memoryRetentionCandidates).toHaveLength(1);
            expect(result.memoryRetentionCandidates[0].root).toMatch(/^static:/);
            expect(result.memoryRetentionCandidates[0].retentionPath.length).toBeGreaterThan(0);
            expect(result.memoryRetentionCandidates[0].lifecycleEnd.line).toBeGreaterThan(0);
        });
    it.each(['StaticCleared', 'BufferLocal', 'SelfCycle', 'ContainerCleared', 'MapDeleted', 'WeakRetained'])(
        'does not report allocation, unrooted cycles, weak references or detached objects for %s', name => {
            const result = run(name);
            expect(result.success, result.error).toBe(true);
            expect(result.memoryRetentionCandidates).toEqual([]);
        });
    it('does not invent expected lifetime from method names without an explicit contract', () => {
        const result = run('StaticRetained', { lifetimes: [] });
        expect(result.memoryRetentionCandidates).toEqual([]);
    });
    it('fails clearly when the exploration budget is exhausted', () => {
        const result = run('StaticRetained', { maxStates: 1 });
        expect(result.success).toBe(false);
        expect(result.limitations).toContain('state-budget-exceeded');
    });
});
