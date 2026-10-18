import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCLI } from '../../src/cli';
import { fixturePath } from '../helpers/buildScene';

describe('ArkLifeguard CLI', () => {
    it('prints its version and exits successfully', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        expect(await runCLI(['node', 'arklifeguard', 'version'])).toBe(0);
        expect(output).toHaveBeenCalledWith('arklifeguard v0.1.0');
        output.mockRestore();
    });

    it('rejects an invalid fact propagation depth before analysis', async () => {
        expect(await runCLI([
            'node',
            'arklifeguard',
            'analyze',
            '/not/analyzed',
            '--max-propagation-depth',
            '0',
        ])).toBe(1);
    });

    it('selects only resource analysis and emits compact JSON results', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const code = await runCLI([
            'node',
            'arklifeguard',
            'analyze',
            fixturePath('resource', 'sdk-app'),
            '--sdk',
            fixturePath('resource', 'platform-sdk'),
            '--checks',
            'resource',
            '--format',
            'json',
        ]);

        expect(code).toBe(0);
        const json = output.mock.calls.map(call => call.join(' '))
            .find(value => value.startsWith('{'));
        expect(json).toBeDefined();
        expect(JSON.parse(json ?? '{}').resourceAnalysis).toMatchObject({
            enabled: true,
            success: true,
        });
        expect(JSON.parse(json ?? '{}').resourceAnalysis.ruleIds).toContain('HttpRequestNotDestroyed');
        expect(JSON.parse(json ?? '{}').summary.resourceLeaks).toBe(1);
        expect(JSON.parse(json ?? '{}').resourceAnalysis.diagnostics).toHaveLength(1);
        expect(JSON.parse(json ?? '{}')).not.toHaveProperty('newResourceAnalysis');
        expect(JSON.parse(json ?? '{}').nullness).toMatchObject({ enabled: false });
        output.mockRestore();
    });

    it.each(['--resource-engine', '--max-abilities-per-flow', '--max-navigation-hops',
        '--max-callback-iterations', '--no-compact-lifecycle-dispatcher'])(
        'rejects the retired option %s instead of silently accepting it', async option => {
            expect(await runCLI(['node', 'arklifeguard', 'analyze', '/not/analyzed', option, 'new'])).toBe(1);
        });

    it.each(['bounded-unroll', 'opt-flat'])(
        'rejects the retired lifecycle model %s', async model => {
            expect(await runCLI(['node', 'arklifeguard', 'analyze', '/not/analyzed',
                '--lifecycle-model', model])).toBe(1);
        });

    it('runs all four checks by default', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const code = await runCLI([
            'node',
            'arklifeguard',
            'analyze',
            fixturePath('resource', 'source-sink'),
            '--sdk',
            fixturePath('sdk'),
            '--format',
            'json',
        ]);

        expect(code).toBe(0);
        const json = output.mock.calls.map(call => call.join(' '))
            .find(value => value.startsWith('{'));
        const report = JSON.parse(json ?? '{}');
        expect(report.nullness.enabled).toBe(true);
        expect(report.resourceAnalysis.enabled).toBe(true);
        expect(report.closureAnalysis.enabled).toBe(true);
        expect(report.memoryAnalysis.enabled).toBe(true);
        output.mockRestore();
    });

    it.each(['closure', 'memory', 'closure,memory'])('selects independent checks with --checks %s', async checks => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            const code = await runCLI(['node', 'arklifeguard', 'analyze', fixturePath('resource', 'retention-app'),
                '--sdk', fixturePath('resource', 'platform-sdk'), '--checks', checks, '--format', 'json']);
            expect(code).toBe(0);
            const json = output.mock.calls.map(call => call.join(' ')).find(value => value.startsWith('{'));
            const report = JSON.parse(json ?? '{}');
            expect(report.schemaVersion).toBe(3);
            expect(report.nullness.enabled).toBe(false);
            expect(report.resourceAnalysis.enabled).toBe(false);
            expect(report.closureAnalysis.enabled).toBe(checks.includes('closure'));
            expect(report.memoryAnalysis.enabled).toBe(checks.includes('memory'));
            if (checks.includes('closure')) expect(report.closureAnalysis.closureRetentionLeaks).toHaveLength(1);
            if (checks.includes('memory')) expect(report.memoryAnalysis.memoryRetentionCandidates).toHaveLength(1);
        } finally { output.mockRestore(); }
    });

    it('writes IFDS statistics only when an output path is requested', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arklifeguard-ifds-stats-'));
        const statisticsPath = path.join(directory, 'solver.json');
        const code = await runCLI([
            'node',
            'arklifeguard',
            'analyze',
            fixturePath('resource', 'source-sink'),
            '--sdk',
            fixturePath('sdk'),
            '--checks',
            'resource',
            '--format',
            'json',
            '--ifds-stats',
            statisticsPath,
        ]);

        expect(code).toBe(0);
        const report = JSON.parse(fs.readFileSync(statisticsPath, 'utf8'));
        expect(report.reportKind).toBe('ifds-solver-statistics');
        expect(report.resourceAnalysis.statistics.scheduling)
            .toBe('two-tier-control-flow');
        expect(report.resourceAnalysis.statistics.processedEdges).toBeGreaterThan(0);
        expect(report.schemaVersion).toBe(2);
        expect(report.resourceAnalysis.status).toBe('success');
        expect(report.resourceAnalysis).not.toHaveProperty('amplification');
        expect(report).not.toHaveProperty('abilities');
        fs.rmSync(directory, { recursive: true, force: true });
        output.mockRestore();
    });

    it('writes lifecycle details to a separate report', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arklifeguard-lifecycle-'));
        const lifecyclePath = path.join(directory, 'lifecycle.json');
        const code = await runCLI([
            'node',
            'arklifeguard',
            'analyze',
            fixturePath('resource', 'source-sink'),
            '--sdk',
            fixturePath('sdk'),
            '--checks',
            'resource',
            '--format',
            'json',
            '--lifecycle-report',
            lifecyclePath,
        ]);

        expect(code).toBe(0);
        const report = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
        expect(report.reportKind).toBe('lifecycle-modeling-details');
        expect(report.settings.lifecycleModel).toBe('flat');
        expect(report.settings.optimizations).toEqual({ pruneUnreachableAbilities: false });
        expect(report.dummyMain.methodSignature).toContain('@extendedDummyMain');
        expect(report.dummyMain.edges).toBeGreaterThan(0);
        expect(report.lifecycleStatistics.abilities.collected).toBeGreaterThan(0);
        expect(report).not.toHaveProperty('resourceAnalysis');
        fs.rmSync(directory, { recursive: true, force: true });
        output.mockRestore();
    });

    it('rejects an unknown check name', async () => {
        expect(await runCLI([
            'node',
            'arklifeguard',
            'analyze',
            '/not/analyzed',
            '--checks',
            'nullness,unknown',
        ])).toBe(1);
    });
});
