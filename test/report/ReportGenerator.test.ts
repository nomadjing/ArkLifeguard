import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectAnalysisResult } from '../../src/application';
import {
    LifecycleReportGenerator,
    ReportGenerator,
    SolverStatisticsReportGenerator,
} from '../../src/report';

const result: ProjectAnalysisResult = {
    schemaVersion: 3,
    analysisKind: 'arklifeguard',
    status: 'success',
    project: { path: '/project', name: 'project', analyzedAt: '2026-08-24T00:00:00.000Z' },
    settings: {
        sdkPaths: ['/sdk/openharmony/ets'],
        inferTypes: true,
        extractUICallbacks: true,
        analyzeNavigation: true,
        runNullness: true,
        runResourceAnalysis: true,
        lifecycleModel: 'flat',
        lifecycleOptimizations: {
            compactDispatcher: true,
            pruneUnreachableAbilities: true,
        },
        bounds: {
            maxCallbackIterations: 1,
            maxAccessPathLength: 5,
            maxPropagationDepth: 40,
        },
        resourceBounds: { maxCallDepth: 4 },
        boundEnforcement: {
            maxCallbackIterations: 'inactive-with-cyclic-model',
            maxAccessPathLength: 'enforced',
            maxPropagationDepth: 'enforced',
        },
        reportUnresolvedReturns: false,
        collectSolverStatistics: false,
    },
    summary: {
        projectFiles: 3,
        sceneFiles: 5,
        classes: 2,
        methods: 8,
        abilities: 1,
        components: 1,
        lifecycleMethods: 4,
        uiCallbacks: 1,
        navigations: 1,
        nullDereferences: 1,
        resourceLeaks: 1,
        reachedStatements: 10,
        reachedFacts: 12,
    },
    abilities: [{
        name: 'EntryAbility', className: 'EntryAbility', isEntry: true,
        lifecycleMethods: ['onCreate'], filePath: '/project/EntryAbility.ets',
    }],
    components: [{
        name: 'Index', className: 'Index', isEntry: true,
        lifecycleMethods: ['build'],
        uiCallbacks: [{ eventType: 'onClick', methodName: 'click', componentType: 'Button' }],
        filePath: '/project/Index.ets',
    }],
    navigations: [{ source: 'EntryAbility', target: 'pages/Index', type: 'loadContent', method: 'onWindowStageCreate' }],
    dummyMain: {
        methodSignature: 'DummyMain.main()', blocks: 4, edges: 5, statements: 9,
        lifecycleCalls: 2, uiCallbackCalls: 1,
    },
    lifecycleStatistics: {
        abilities: { collected: 1, reachable: 1, pruned: 0 },
        pages: { owned: 1, unknown: 0 },
        components: { owned: 1, reachable: 1, fallback: 0 },
        callbacks: { bound: 1, fallback: 0 },
        ownership: {
            directPageRoots: 1,
            viewTreeComponentEdges: 0,
            navigationPageEdges: 0,
            viewTreeFailures: 0,
        },
        transitions: {
            candidateCallbackTransitions: 1,
            retainedCallbackTransitions: 1,
            prunedCrossAbilityTransitions: 0,
            conservativeFallbackTransitions: 0,
        },
        pageTransitions: {
            discoveredPages: 1,
            boundCallbacks: 1,
            fallbackCallbacks: 0,
            candidateCallbackTransitions: 1,
            retainedCallbackTransitions: 1,
            prunedCrossPageTransitions: 0,
            conservativeFallbackTransitions: 0,
            legalNavigationTransitions: 0,
        },
    },
    nullness: {
        enabled: true,
        success: true,
        entryMethod: 'DummyMain.main()',
        diagnostics: [{
            nullness: 'Null',
            accessPath: 'value',
            description: 'Definite null dereference',
            confidence: 'high',
            source: { filePath: '/project/Index.ets', relativePath: 'Index.ets', line: 10, col: 5 },
            dereference: { filePath: '/project/Index.ets', relativePath: 'Index.ets', line: 12, col: 7 },
        }],
        reachedStatements: 10,
        reachedFacts: 12,
    },
    resourceAnalysis: {
        enabled: true, status: 'success', success: true, entryMethod: 'DummyMain.main()',
        diagnostics: [{ ruleId: 'FileNotClosed', reason: 'unreleased', confidence: 'high',
            allocation: { filePath: '/project/Index.ets', line: 20, col: 5 },
            boundary: { filePath: '/project/Index.ets', line: 30, col: 1 }, evidence: [],
        }], reachedStatements: 8, reachedFacts: 10,
        unresolvedRuleIds: ['AudioRendererNotReleased'], unsupportedApiFamilies: ['Worker/ThreadWorker termination'],
    },
    duration: {
        sceneBuilding: 100,
        lifecycleModeling: 20,
        navigationAnalysis: 5,
        nullnessAnalysis: 30,
        resourceAnalysis: 25,
        total: 155,
    },
    warnings: [],
    errors: [],
};

describe('ReportGenerator', () => {
    it.each(['json', 'text', 'markdown', 'html'] as const)('renders independent retention evidence and failure in %s', format => {
        const location = { filePath: '/project/Index.ets', line: 10, col: 1 };
        const withRetention: ProjectAnalysisResult = { ...result, status: 'failed',
            closureAnalysis: { enabled: true, success: true, registrationLeaks: [],
                closureRetentionLeaks: [{ registrationId: 'registration:1', ruleId: 'EmitterRegistration',
                    registration: location, boundary: location, lifecycleEnd: location, reason: 'unregistered',
                    confidence: 'high', registrars: ['system:emitter'], events: ['1'], callbacks: ['callback:1'],
                    capturedObject: 'owner:1', root: 'registration-root:1',
                    retentionPath: [{ from: 'callback:1', to: 'owner:1', via: 'capture:<script>', location }] }],
                unresolvedRuleIds: ['WindowRegistration'], unsupportedApiFamilies: ['sensor.on'], limitations: [] },
            memoryAnalysis: { enabled: true, success: false, memoryRetentionCandidates: [],
                registrationRetentions: [], limitations: ['state-budget-exceeded'], error: 'Memory budget exceeded' } };
        const report = new ReportGenerator().generate(withRetention, { format });
        expect(report).toContain('EmitterRegistration');
        expect(report).toContain('Memory budget exceeded');
        expect(report).toContain('sensor.on');
        if (format === 'json') {
            const json = JSON.parse(report);
            expect(json.closureAnalysis.closureRetentionLeaks[0].retentionPath).toHaveLength(1);
            expect(json.memoryAnalysis.success).toBe(false);
            expect(json.summary).toMatchObject({ closureRetentionLeaks: 1, memoryRetentionCandidates: 0 });
        } else {
            expect(report).toContain('分析未完成');
            expect(report).toContain('/project/Index.ets:10:1');
            expect(report).toContain('callback:1');
        }
        if (format === 'html') {
            expect(report).toContain('&lt;script&gt;');
            expect(report).not.toContain('capture:<script>');
        }
    });
    it.each(['text', 'markdown', 'html'] as const)('marks disabled retention checks in %s', format => {
        const disabled: ProjectAnalysisResult = { ...result,
            closureAnalysis: { enabled: false, success: true, registrationLeaks: [], closureRetentionLeaks: [], unresolvedRuleIds: [], limitations: [] },
            memoryAnalysis: { enabled: false, success: true, memoryRetentionCandidates: [], registrationRetentions: [], limitations: [] } };
        const report = new ReportGenerator().generate(disabled, { format });
        expect(report).toContain('未启用。');
        expect(report).toContain('内存保留检测');
        expect(report).toContain('闭包与注册检测');
    });
    it.each(['json', 'text', 'markdown', 'html'] as const)('generates %s reports', format => {
        const report = new ReportGenerator().generate(result, { format });
        expect(report).toContain('project');
        expect(report).not.toContain('maxPropagationDepth');
        expect(report).not.toContain('EntryAbility');
    });

    it('writes the report to the requested path', () => {
        const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arklifeguard-report-')), 'report.json');
        new ReportGenerator().generate(result, { format: 'json', outputPath });
        expect(JSON.parse(fs.readFileSync(outputPath, 'utf8')).analysisKind)
            .toBe('arklifeguard');
    });

    it('writes solver statistics as a separate developer report', () => {
        const withStatistics: ProjectAnalysisResult = {
            ...result,
            settings: { ...result.settings, collectSolverStatistics: true },
            resourceAnalysis: {
                ...result.resourceAnalysis,
                solverStatistics: {
                    scheduling: 'later-edge-worklist',
                    solveTimeMs: 12,
                    propagationAttempts: 8,
                    deferredPropagationAttempts: 6,
                    uniqueEdgesEnqueued: 6,
                    duplicateEdgesSkipped: 2,
                    deferredDuplicateEdgesSkipped: 2,
                    deduplicationLookups: 7,
                    deduplicationCandidateChecks: 21,
                    maxDeduplicationCandidates: 6,
                    factEqualityChecks: 28,
                    processedEdges: 6,
                    immediateEnqueued: 2,
                    deferredEnqueued: 4,
                    maxImmediateQueueSize: 1,
                    maxDeferredQueueSize: 3,
                    maxCombinedQueueSize: 4,
                    maxLaterEdgesSize: 5,
                    finalLaterEdgesSize: 2,
                    finalPathEdgeCount: 6,
                },
            },
        };
        const report = JSON.parse(new SolverStatisticsReportGenerator().generate(withStatistics));
        expect(report.reportKind).toBe('ifds-solver-statistics');
        expect(report.resourceAnalysis.statistics.duplicateEdgesSkipped).toBe(2);
        expect(report).not.toHaveProperty('abilities');
        expect(report).not.toHaveProperty('components');

        const userReport = JSON.parse(new ReportGenerator().generate(withStatistics, {
            format: 'json',
        }));
        expect(userReport.resourceAnalysis).not.toHaveProperty('solverStatistics');
    });

    it('keeps the default JSON report focused on diagnostics', () => {
        const report = JSON.parse(new ReportGenerator().generate(result, { format: 'json' }));
        expect(report.summary).toEqual({
            nullDereferences: 1,
            resourceLeaks: 1,
        });
        expect(report.nullness.diagnostics).toHaveLength(1);
        expect(report.resourceAnalysis.diagnostics).toHaveLength(1);
        expect(report.resourceAnalysis.status).toBe('success');
        expect(report.schemaVersion).toBe(3);
        expect(report).not.toHaveProperty('newResourceAnalysis');
        expect(report.resourceAnalysis).not.toHaveProperty('methodLocal');
        expect(report.duration).toEqual({ total: 155 });
        expect(report).not.toHaveProperty('settings');
        expect(report).not.toHaveProperty('abilities');
        expect(report).not.toHaveProperty('components');
        expect(report).not.toHaveProperty('navigations');
        expect(report).not.toHaveProperty('dummyMain');
    });

    it.each(['json', 'text', 'markdown', 'html'] as const)(
        'shows a failed resource module in %s without claiming a clean result', format => {
            const failed: ProjectAnalysisResult = { ...result, status: 'failed',
                summary: { ...result.summary, resourceLeaks: 0 },
                resourceAnalysis: { enabled: true, status: 'failed', success: false,
                    entryMethod: 'DummyMain.main()', diagnostics: [], error: '没有可用资源规则' },
                errors: ['没有可用资源规则'],
            };
            const report = new ReportGenerator().generate(failed, { format });
            expect(report).toContain('没有可用资源规则');
            if (format === 'json') expect(JSON.parse(report).resourceAnalysis).toMatchObject({
                enabled: true, status: 'failed', success: false, diagnostics: [],
            });
            else {
                expect(report).toContain('失败');
                expect(report).not.toContain('未检出资源泄漏候选问题');
            }
        });

    it.each(['json', 'text', 'markdown', 'html'] as const)('renders sole resource evidence in %s', format => {
        const report = new ReportGenerator().generate(result, { format });
        expect(report).toContain('FileNotClosed');
        expect(report).toContain('unreleased');
        expect(report).toContain('/project/Index.ets');
        expect(report).toContain('AudioRendererNotReleased');
        expect(report).toContain('Worker/ThreadWorker termination');
        expect(report).not.toContain('方法内资源');
    });

    it.each(['text', 'markdown', 'html'] as const)('distinguishes a disabled resource module in %s', format => {
        const disabled: ProjectAnalysisResult = { ...result, resourceAnalysis: {
            enabled: false, status: 'disabled', success: true, entryMethod: '', diagnostics: [] } };
        const report = new ReportGenerator().generate(disabled, { format });
        expect(report).toContain('未启用资源泄漏分析');
        expect(report).not.toContain('未检出资源泄漏候选问题');
    });

    it('writes lifecycle modeling details as a separate report', () => {
        const report = JSON.parse(new LifecycleReportGenerator().generate(result));
        expect(report.reportKind).toBe('lifecycle-modeling-details');
        expect(report.settings.lifecycleModel).toBe('flat');
        expect(report.settings.maxCallbackIterations).toBeNull();
        expect(report.abilities).toHaveLength(1);
        expect(report.components).toHaveLength(1);
        expect(report.navigations).toHaveLength(1);
        expect(report.dummyMain.methodSignature).toBe('DummyMain.main()');
        expect(report).not.toHaveProperty('nullness');
        expect(report).not.toHaveProperty('resourceAnalysis');
    });
});
