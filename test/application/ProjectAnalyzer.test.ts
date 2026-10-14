import { describe, expect, it } from 'vitest';
import { ProjectAnalyzer } from '../../src/application';
import { buildResourceScene, fixturePath } from '../helpers/buildScene';

describe('ProjectAnalyzer module orchestration', () => {
    it('keeps standalone and combined retention checks identical on the lifecycle entry', async () => {
        const options = { sdkPaths: [fixturePath('resource', 'platform-sdk')], runNullness: false, runResourceAnalysis: false };
        const project = fixturePath('resource', 'retention-app');
        const closure = await new ProjectAnalyzer({ ...options, runClosureAnalysis: true }).analyze(project);
        const memory = await new ProjectAnalyzer({ ...options, runMemoryAnalysis: true }).analyze(project);
        const combined = await new ProjectAnalyzer({ ...options, runClosureAnalysis: true, runMemoryAnalysis: true, runResourceAnalysis: true }).analyze(project);
        expect(combined.status, combined.errors.join(', ')).toBe('success');
        expect(combined.schemaVersion).toBe(3);
        expect(combined.closureAnalysis?.closureRetentionLeaks).toHaveLength(1);
        expect(combined.memoryAnalysis?.memoryRetentionCandidates).toHaveLength(1);
        expect(closure.closureAnalysis).toEqual(combined.closureAnalysis);
        expect(memory.memoryAnalysis).toEqual(combined.memoryAnalysis);
        expect(closure.memoryAnalysis).toMatchObject({ enabled: false, success: true, memoryRetentionCandidates: [] });
        expect(memory.closureAnalysis).toMatchObject({ enabled: false, success: true, closureRetentionLeaks: [] });
        expect(combined.resourceAnalysis.diagnostics).toEqual([]);
        expect(combined.summary).toMatchObject({ registrationLeaks: 0, closureRetentionLeaks: 1, memoryRetentionCandidates: 1 });
    });
    it('preserves other results when closure configuration fails', async () => {
        const result = await new ProjectAnalyzer({ sdkPaths: [fixturePath('resource', 'platform-sdk')],
            runNullness: false, runResourceAnalysis: false, runClosureAnalysis: true, runMemoryAnalysis: true,
            closureRules: [] }).analyze(fixturePath('resource', 'retention-app'));
        expect(result.status).toBe('failed');
        expect(result.closureAnalysis?.success).toBe(false);
        expect(result.memoryAnalysis?.success).toBe(true);
        expect(result.memoryAnalysis?.memoryRetentionCandidates).toHaveLength(1);
        expect(result.errors).toContain(result.closureAnalysis?.error);
    });
    it('validates retention exploration bounds before building a Scene', () => {
        expect(() => new ProjectAnalyzer({ maxRetentionStates: 0 })).toThrow('maxRetentionStates');
        expect(() => new ProjectAnalyzer({ maxRetentionCallDepth: 0 })).toThrow('maxRetentionCallDepth');
    });
    it('runs the default resource contract alongside nullness on one lifecycle entry', async () => {
        const result = await new ProjectAnalyzer({
            sdkPaths: [fixturePath('sdk')],
            maxAccessPathLength: 4, maxPropagationDepth: 30,
        }).analyze(fixturePath('lifecycle', 'simple'));
        expect(result.status, result.errors.join(', ')).toBe('success');
        expect(result.summary.abilities).toBe(1);
        expect(result.summary.components).toBe(1);
        expect(result.dummyMain.edges).toBeGreaterThan(0);
        expect(result.nullness.success).toBe(true);
        expect(result.resourceAnalysis).toMatchObject({ enabled: true, status: 'success', success: true });
        expect(result.settings.bounds).toEqual({ maxAccessPathLength: 4, maxPropagationDepth: 30 });
        expect(result.settings.resourceBounds).toEqual({ maxCallDepth: 4 });
        expect(result.settings).not.toHaveProperty('resourceEngine');
    });

    it('counts SDK resource diagnostics and retains allocation/boundary evidence', async () => {
        const result = await new ProjectAnalyzer({ sdkPaths: [fixturePath('resource', 'platform-sdk')], runNullness: false,
            collectSolverStatistics: true }).analyze(fixturePath('resource', 'sdk-app'));
        expect(result.status).toBe('success');
        expect(result.resourceAnalysis.diagnostics).toMatchObject([{
            ruleId: 'HttpRequestNotDestroyed', reason: 'unreleased',
            allocation: { filePath: expect.stringContaining('EntryAbility.ets') },
        }]);
        expect(result.summary.resourceLeaks).toBe(result.resourceAnalysis.diagnostics.length);
        expect(result.resourceAnalysis.coverage?.some(rule => rule.reachedAllocatorCalls > 0)).toBe(true);
        expect(result.resourceAnalysis.solverStatistics?.processedEdges).toBeGreaterThan(0);
        expect(result.resourceAnalysis.unsupportedApiFamilies).toContain('Worker/ThreadWorker termination');
        expect(result).not.toHaveProperty('newResourceAnalysis');
        expect(result.resourceAnalysis).not.toHaveProperty('methodLocal');
    });

    it('does not apply SDK obligations to same-named project APIs', async () => {
        const result = await new ProjectAnalyzer({ sdkPaths: [fixturePath('sdk')], runNullness: false })
            .analyze(fixturePath('resource', 'source-sink'));
        expect(result.resourceAnalysis).toMatchObject({ enabled: true, success: true, diagnostics: [] });
        expect(result.resourceAnalysis.coverage?.every(rule => rule.reachedAllocatorCalls === 0)).toBe(true);
    });

    it('reports empty rules as failure while preserving independent module results', async () => {
        const result = await new ProjectAnalyzer({ sdkPaths: [fixturePath('resource', 'platform-sdk')],
            runNullness: false, runResourceAnalysis: true, resourceRules: [], runMemoryAnalysis: true,
        }).analyze(fixturePath('resource', 'retention-app'));
        expect(result.status).toBe('failed');
        expect(result.resourceAnalysis).toMatchObject({ enabled: true, status: 'failed', success: false, diagnostics: [] });
        expect(result.resourceAnalysis.error).toContain('没有可用规则');
        expect(result.errors).toContain(result.resourceAnalysis.error);
        expect(result.memoryAnalysis?.success).toBe(true);
        expect(result.memoryAnalysis?.memoryRetentionCandidates).toHaveLength(1);
    });

    it('uses explicitly injected exact signatures in the sole resource result', async () => {
        const scene = buildResourceScene('source-sink');
        const signature = (name: string) => {
            for (const method of scene.getMethods()) for (const stmt of method.getCfg()?.getStmts() ?? []) {
                const invoked = stmt.getInvokeExpr()?.getMethodSignature();
                if (invoked?.getDeclaringClassSignature().getClassName() === 'AVPlayer' &&
                    invoked.getMethodSubSignature().getMethodName() === name) return invoked.toString();
            }
            throw new Error(`missing AVPlayer.${name}`);
        };
        const result = await new ProjectAnalyzer({ sdkPaths: [fixturePath('sdk')], runNullness: false,
            resourceRules: [{ id: 'InjectedAVPlayer', scope: 'resource',
                allocators: [{ methodSignature: signature('createAVPlayer'), handleLocation: { kind: 'return' } }],
                releasers: [{ methodSignature: signature('release'), handleLocation: { kind: 'base' } }],
            }],
        }).analyze(fixturePath('resource', 'source-sink'));
        expect(result.status).toBe('success');
        expect(result.resourceAnalysis.diagnostics).toMatchObject([{ ruleId: 'InjectedAVPlayer', reason: 'unreleased' }]);
        expect(result.resourceAnalysis.enabled).toBe(true);
    });
});
