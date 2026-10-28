import { describe, expect, it } from 'vitest';
import { ProjectAnalyzer } from '../../src/application';
import { buildResourceScene, fixturePath } from '../helpers/buildScene';

describe('ProjectAnalyzer module orchestration', () => {
    it('runs resource and listener obligations independently or together', async () => {
        const options = { sdkPaths: [fixturePath('resource', 'platform-sdk')], runNullness: false };
        const project = fixturePath('resource', 'retention-app');
        const resource = await new ProjectAnalyzer(options).analyze(project);
        const listener = await new ProjectAnalyzer({ ...options, runResourceAnalysis: false, runListenerAnalysis: true }).analyze(project);
        const combined = await new ProjectAnalyzer({ ...options, runListenerAnalysis: true }).analyze(project);
        expect(combined.status, combined.errors.join(', ')).toBe('success');
        expect(combined.schemaVersion).toBe(5);
        expect(combined.listenerAnalysis?.diagnostics).toHaveLength(1);
        expect(combined.resourceAnalysis.diagnostics).toHaveLength(1);
        expect(combined.resourceAnalysis.diagnostics[0].ruleId).toBe('PixelMapNotReleased');
        expect(resource.resourceAnalysis).toEqual(combined.resourceAnalysis);
        expect(listener.listenerAnalysis).toEqual(combined.listenerAnalysis);
        expect(resource.listenerAnalysis?.enabled).toBe(false);
        expect(listener.resourceAnalysis.enabled).toBe(false);
        expect(combined.summary).toMatchObject({ resourceLeaks: 1, listenerLeaks: 1 });
        expect(combined).not.toHaveProperty('memoryAnalysis');
        expect(combined).not.toHaveProperty('closureAnalysis');
    });
    it('isolates listener configuration failures from resource results', async () => {
        const result = await new ProjectAnalyzer({ sdkPaths: [fixturePath('resource', 'platform-sdk')],
            runNullness: false, runListenerAnalysis: true, listenerRules: [] })
            .analyze(fixturePath('resource', 'retention-app'));
        expect(result.status).toBe('failed');
        expect(result.listenerAnalysis?.success).toBe(false);
        expect(result.resourceAnalysis.success).toBe(true);
        expect(result.resourceAnalysis.diagnostics).toHaveLength(1);
        expect(result.errors).toContain(result.listenerAnalysis?.error);
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
            runNullness: false, runResourceAnalysis: true, resourceRules: [], runListenerAnalysis: true,
        }).analyze(fixturePath('resource', 'retention-app'));
        expect(result.status).toBe('failed');
        expect(result.resourceAnalysis).toMatchObject({ enabled: true, status: 'failed', success: false, diagnostics: [] });
        expect(result.resourceAnalysis.error).toContain('没有可用规则');
        expect(result.errors).toContain(result.resourceAnalysis.error);
        expect(result.listenerAnalysis?.success).toBe(true);
        expect(result.listenerAnalysis?.diagnostics).toHaveLength(1);
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
