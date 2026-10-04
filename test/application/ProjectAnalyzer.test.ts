import { describe, expect, it } from 'vitest';
import { ProjectAnalyzer } from '../../src/application';
import { buildResourceScene, fixturePath } from '../helpers/buildScene';

describe('ProjectAnalyzer end-to-end application service', () => {
    it('keeps standalone and combined retention checks identical on the lifecycle entry', async () => {
        const options = { sdkPaths: [fixturePath('resource', 'platform-sdk')], runNullness: false, runResourceAnalysis: false };
        const project = fixturePath('resource', 'retention-app');
        const closure = await new ProjectAnalyzer({ ...options, runClosureAnalysis: true }).analyze(project);
        const memory = await new ProjectAnalyzer({ ...options, runMemoryAnalysis: true }).analyze(project);
        const combined = await new ProjectAnalyzer({ ...options, runClosureAnalysis: true, runMemoryAnalysis: true, runResourceAnalysis: true }).analyze(project);
        expect(combined.status, combined.errors.join(', ')).toBe('success');
        expect(combined.schemaVersion).toBe(2);
        expect(combined.closureAnalysis?.closureRetentionLeaks).toHaveLength(1);
        expect(combined.memoryAnalysis?.memoryRetentionCandidates).toHaveLength(1);
        expect(closure.closureAnalysis).toEqual(combined.closureAnalysis);
        expect(memory.memoryAnalysis).toEqual(combined.memoryAnalysis);
        expect(closure.memoryAnalysis).toMatchObject({ enabled: false, success: true, memoryRetentionCandidates: [] });
        expect(memory.closureAnalysis).toMatchObject({ enabled: false, success: true, closureRetentionLeaks: [] });
        expect(combined.resourceAnalysis.resourceLeaks).toEqual([]);
        expect(combined.resourceAnalysis.methodLocal.leaks).toEqual([]);
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
    it('runs Scene, bounded lifecycle, resource analysis, nullness and result assembly in one chain', async () => {
        const result = await new ProjectAnalyzer({
            sdkPaths: [fixturePath('sdk')],
            maxCallbackIterations: 2,
            maxAbilitiesPerFlow: 4,
            maxNavigationHops: 6,
            maxAccessPathLength: 4,
            maxPropagationDepth: 30,
        }).analyze(fixturePath('lifecycle', 'simple'));

        expect(result.status).toBe('success');
        expect(result.summary.abilities).toBe(1);
        expect(result.summary.components).toBe(1);
        expect(result.dummyMain.blocks).toBeGreaterThan(0);
        expect(result.dummyMain.edges).toBeGreaterThan(0);
        expect(result.dummyMain.statements).toBeGreaterThan(0);
        expect(result.nullness.success).toBe(true);
        expect(result.resourceAnalysis.success).toBe(true);
        expect(result.resourceAnalysis.engine).toBe('legacy');
        expect(result.resourceAnalysis.analyzedMethods).toBeGreaterThan(0);
        expect(result.resourceAnalysis.amplification.reachedStatements)
            .toBe(result.resourceAnalysis.reachedStatements);
        expect(result.resourceAnalysis.amplification.factsPerStatement)
            .toBeGreaterThanOrEqual(0);
        expect(result.lifecycleStatistics.abilities.collected).toBe(1);
        expect(result.settings.lifecycleModel).toBe('flat');
        expect(result.settings.boundEnforcement.maxCallbackIterations)
            .toBe('inactive-with-cyclic-model');
        expect(result.settings.boundEnforcement.maxAbilitiesPerFlow).toBe('enforced');
        expect(result.settings.bounds).toEqual({
            maxCallbackIterations: 2,
            maxAbilitiesPerFlow: 4,
            maxNavigationHops: 6,
            maxAccessPathLength: 4,
            maxPropagationDepth: 30,
        });
    });

    it('serializes resource leaks and their source locations', async () => {
        const result = await new ProjectAnalyzer({
            sdkPaths: [fixturePath('sdk')],
            runNullness: false,
        }).analyze(fixturePath('resource', 'source-sink'));

        expect(result.status).toBe('success');
        expect(result.resourceAnalysis.enabled).toBe(true);
        expect(result.settings.bounds.maxAbilitiesPerFlow).toBe(0);
        expect(result.settings.bounds.maxNavigationHops).toBe(0);
        expect(result.settings.boundEnforcement.maxAbilitiesPerFlow).toBe('disabled');
        expect(result.settings.boundEnforcement.maxNavigationHops).toBe('disabled');
        expect(result.summary.resourceLeaks).toBe(1);
        expect(result.summary.sources).toBeGreaterThanOrEqual(3);
        expect(result.summary.sinks).toBeGreaterThanOrEqual(1);
        expect(result.resourceAnalysis.methodLocal.leaks.some(
            leak => leak.resourceType === 'AVPlayer' && leak.methodName === 'onCreate'
        )).toBe(true);
        expect(result.resourceAnalysis.resourceLeaks[0]).toMatchObject({
            resourceType: 'AVPlayer',
            source: { relativePath: 'EntryAbility.ets' },
        });
    });

    it('keeps the new engine separate and fails for an explicitly empty rule set', async () => {
        const result = await new ProjectAnalyzer({
            sdkPaths: [fixturePath('sdk')],
            runNullness: false,
            resourceEngine: 'new',
            resourceRules: [],
        }).analyze(fixturePath('resource', 'source-sink'));

        expect(result.status).toBe('failed');
        expect(result.settings.resourceEngine).toBe('new');
        expect(result.resourceAnalysis).toMatchObject({
            enabled: false,
            engine: 'legacy',
            success: true,
            resourceLeaks: [],
            taintLeaks: [],
        });
        expect(result.newResourceAnalysis).toMatchObject({
            status: 'not-implemented', success: false, diagnostics: [],
        });
        expect(result.newResourceAnalysis?.error).toContain('尚未配置规则');
        expect(result.resourceAnalysis.methodLocal.leaks).toEqual([]);
        expect(result.summary.resourceLeaks).toBe(0);
        expect(result.errors).toContain(result.newResourceAnalysis?.error);
    });

    it('runs injected new-engine rules without adding legacy diagnostics', async () => {
        const scene = buildResourceScene('source-sink');
        const signature = (name: string) => {
            for (const method of scene.getMethods()) {
                for (const stmt of method.getCfg()?.getStmts() ?? []) {
                    const invoked = stmt.getInvokeExpr()?.getMethodSignature();
                    if (invoked?.getDeclaringClassSignature().getClassName() === 'AVPlayer' &&
                        invoked.getMethodSubSignature().getMethodName() === name) {
                        return invoked.toString();
                    }
                }
            }
            throw new Error(`missing AVPlayer.${name}`);
        };
        const result = await new ProjectAnalyzer({
            sdkPaths: [fixturePath('sdk')],
            runNullness: false,
            resourceEngine: 'new',
            resourceRules: [{
                id: 'AVPlayerNotReleased', scope: 'resource',
                allocators: [{ methodSignature: signature('createAVPlayer'),
                    handleLocation: { kind: 'return' } }],
                releasers: [{ methodSignature: signature('release'),
                    handleLocation: { kind: 'base' } }],
            }],
        }).analyze(fixturePath('resource', 'source-sink'));

        expect(result.status).toBe('success');
        expect(result.resourceAnalysis.enabled).toBe(false);
        expect(result.resourceAnalysis.resourceLeaks).toEqual([]);
        expect(result.newResourceAnalysis?.success).toBe(true);
        expect(result.newResourceAnalysis?.diagnostics).toMatchObject([{
            ruleId: 'AVPlayerNotReleased', reason: 'unreleased',
        }]);
    });
});
