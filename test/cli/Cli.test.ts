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
            fixturePath('resource', 'source-sink'),
            '--sdk',
            fixturePath('sdk'),
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
            engine: 'legacy',
            success: true,
        });
        expect(JSON.parse(json ?? '{}').nullness).toMatchObject({ enabled: false });
        output.mockRestore();
    });

    it('runs SDK defaults for the new resource engine without mixing legacy results', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            const code = await runCLI([
                'node', 'arklifeguard', 'analyze', fixturePath('resource', 'source-sink'),
                '--sdk', fixturePath('sdk'), '--checks', 'resource',
                '--resource-engine', 'new', '--format', 'json',
            ]);
            expect(code).toBe(0);
            const json = output.mock.calls.map(call => call.join(' '))
                .find(value => value.startsWith('{'));
            const report = JSON.parse(json ?? '{}');
            expect(report.status).toBe('success');
            expect(report.resourceAnalysis).toMatchObject({
                engine: 'legacy', enabled: false, resourceLeaks: [],
            });
            expect(report.newResourceAnalysis).toMatchObject({
                status: 'success', success: true,
            });
            expect(report.newResourceAnalysis.ruleIds).toContain('AVPlayerNotReleased');
            expect(report.newResourceAnalysis.coverage).toBeDefined();
        } finally {
            output.mockRestore();
        }
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
            expect(report.schemaVersion).toBe(2);
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
        expect(report.resourceAnalysis.amplification.edgesPerStatement)
            .toBeGreaterThan(0);
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
