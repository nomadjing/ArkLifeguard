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
    schemaVersion: 1,
    analysisKind: 'lifecycle-nullness',
    status: 'success',
    project: { path: '/project', name: 'project', analyzedAt: '2026-08-24T00:00:00.000Z' },
    settings: {
        sdkPaths: ['/sdk/openharmony/ets'],
        inferTypes: true,
        extractUICallbacks: true,
        analyzeNavigation: true,
        runNullness: true,
        runResourceAnalysis: true,
        resourceEngine: 'legacy',
        lifecycleModel: 'flat',
        lifecycleOptimizations: {
            compactDispatcher: true,
            pruneUnreachableAbilities: true,
        },
        bounds: {
            maxCallbackIterations: 1,
            maxAbilitiesPerFlow: 3,
            maxNavigationHops: 5,
            maxAccessPathLength: 5,
            maxPropagationDepth: 40,
        },
        boundEnforcement: {
            maxCallbackIterations: 'inactive-with-cyclic-model',
            maxAbilitiesPerFlow: 'enforced',
            maxNavigationHops: 'enforced',
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
        taintLeaks: 0,
        sources: 1,
        sinks: 1,
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
        enabled: true,
        engine: 'legacy',
        success: true,
        entryMethod: 'DummyMain.main()',
        resourceLeaks: [{
            sourceId: 'fs.open',
            resourceType: 'File',
            expectedSink: 'fs.close',
            description: '文件资源未释放',
            source: { filePath: '/project/Index.ets', relativePath: 'Index.ets', line: 20, col: 5 },
        }],
        taintLeaks: [],
        reachedStatements: 8,
        reachedFacts: 10,
        sources: [{
            resourceType: 'File',
            methodPattern: 'fs.open',
            methodSignature: 'fs.open()',
            location: { filePath: '/project/Index.ets', relativePath: 'Index.ets', line: 20, col: 5 },
        }],
        sinks: [{
            resourceType: 'File',
            methodPattern: 'fs.close',
            methodSignature: 'fs.close()',
            location: { filePath: '/project/Index.ets', relativePath: 'Index.ets', line: 24, col: 5 },
        }],
        analyzedMethods: 3,
        amplification: {
            reachedFacts: 10,
            reachedStatements: 8,
            processedEdges: null,
            propagationAttempts: null,
            ifdsTimeMs: null,
            factsPerStatement: 1.25,
            edgesPerStatement: null,
        },
        methodLocal: {
            leaks: [],
            analyzedMethods: 8,
            sourceCount: 1,
            sinkCount: 1,
        },
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
            .toBe('lifecycle-nullness');
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
            methodLocalResourceLeaks: 0,
        });
        expect(report.nullness.diagnostics).toHaveLength(1);
        expect(report.resourceAnalysis.resourceLeaks).toHaveLength(1);
        expect(report.resourceAnalysis.engine).toBe('legacy');
        expect(report.duration).toEqual({ total: 155 });
        expect(report).not.toHaveProperty('settings');
        expect(report).not.toHaveProperty('abilities');
        expect(report).not.toHaveProperty('components');
        expect(report).not.toHaveProperty('navigations');
        expect(report).not.toHaveProperty('dummyMain');
    });

    it.each(['json', 'text', 'markdown', 'html'] as const)(
        'shows a failed new resource engine in %s instead of a clean result', format => {
            const failed: ProjectAnalysisResult = {
                ...result,
                status: 'failed',
                settings: { ...result.settings, resourceEngine: 'new' },
                summary: { ...result.summary, resourceLeaks: 0 },
                resourceAnalysis: {
                    ...result.resourceAnalysis,
                    enabled: false,
                    resourceLeaks: [],
                    methodLocal: { leaks: [], analyzedMethods: 0, sourceCount: 0, sinkCount: 0 },
                },
                newResourceAnalysis: {
                    status: 'not-implemented', success: false,
                    entryMethod: 'DummyMain.main()', diagnostics: [],
                    error: '新资源分析尚未实现',
                },
                errors: ['新资源分析尚未实现'],
            };
            const report = new ReportGenerator().generate(failed, { format });
            expect(report).toContain('新资源分析尚未实现');
            if (format === 'json') {
                expect(JSON.parse(report).newResourceAnalysis).toMatchObject({
                    status: 'not-implemented', success: false, error: '新资源分析尚未实现',
                });
            } else {
                expect(report).toContain('失败');
                expect(report).not.toContain('未检出资源泄漏候选问题');
            }
        }
    );

    it.each(['json', 'text', 'markdown', 'html'] as const)(
        'renders new resource diagnostics in %s', format => {
            const withNew: ProjectAnalysisResult = {
                ...result,
                settings: { ...result.settings, resourceEngine: 'new' },
                resourceAnalysis: { ...result.resourceAnalysis, enabled: false, resourceLeaks: [] },
                newResourceAnalysis: {
                    status: 'success', success: true, entryMethod: 'DummyMain.main()',
                    diagnostics: [{
                        ruleId: 'HandleNotReleased', reason: 'unreleased', confidence: 'high',
                        allocation: { filePath: '/project/Index.ets', line: 20, col: 5 },
                        boundary: { filePath: '/project/Index.ets', line: 30, col: 1 },
                        evidence: [],
                    }],
                },
            };
            const report = new ReportGenerator().generate(withNew, { format });
            expect(report).toContain('HandleNotReleased');
            expect(report).toContain('unreleased');
            expect(report).toContain('/project/Index.ets');
        }
    );

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
