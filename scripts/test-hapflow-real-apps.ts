#!/usr/bin/env -S npx vite-node

/**
 * Run HapFlow taint analysis over the HarmonyRealApps project set.
 *
 * This is a driver only: the actual analysis runs in the HapFlow artifact
 * (../hapflow_artifact/hapflow) via tests/ArkLifeguardRunner.ts, one project
 * per child process with a hard timeout, using this repository's SDK.
 *
 * Usage:
 *   npm run test:hapflow:real-apps -- [--project <name>]... [--limit <n>] \
 *     [--output <file>] [--timeout-ms <n>] [--sdk-root <path>] [--pta] [--list]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ProjectMetadata {
    name: string;
    path: string;
}

interface Options {
    realAppsRoot: string;
    hapflowRoot: string;
    sdkRoot: string;
    outputPath?: string;
    timeoutMs: number;
    usePta: boolean;
    projects: string[];
    limit?: number;
    listOnly: boolean;
}

interface FlowEndpoint {
    text: string;
    line: number;
    col: number;
}

interface RunnerFlow {
    source: FlowEndpoint | null;
    sink: FlowEndpoint | null;
    pathLength: number;
}

interface RunnerResult {
    status: 'success' | 'failed' | 'no-entry' | 'timeout';
    error?: string;
    durationMs?: number;
    codeLines?: number;
    edgeNum?: number;
    sourceNum?: number;
    sourceRuleCount?: number;
    sinkRuleCount?: number;
    outcomeCount?: number;
    entryMethods?: string[];
    rssEndMb?: number;
    flows?: RunnerFlow[];
}

interface ProjectRecord extends RunnerResult {
    name: string;
    path: string;
    timeoutMs: number;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '..');
const defaultRealAppsRoot = path.join(repositoryRoot, 'HarmonyRealApps');
const defaultHapflowRoot = path.resolve(repositoryRoot, '..', 'hapflow_artifact', 'hapflow');
const defaultSdkRoot = path.join(repositoryRoot, 'sdk', 'default');

function help(): void {
    console.log([
        'Usage: npm run test:hapflow:real-apps -- [options]',
        '',
        'Runs HapFlow taint analysis on HarmonyRealApps projects.',
        '',
        '  --project <name>          Analyze one metadata project; repeatable',
        '  --limit <n>               Analyze only the first n selected projects',
        '  --output <file>           Write incremental JSON report to this path',
        '  --real-apps-root <path>   HarmonyRealApps dir; default: ./HarmonyRealApps',
        '  --hapflow-root <path>     HapFlow dir; default: ../hapflow_artifact/hapflow',
        '  --sdk-root <path>         SDK root; default: ./sdk/default',
        '  --timeout-ms <n>          Per-project timeout; default: 600000',
        '  --pta                     Enable HapFlow pointer analysis (slow, can crash)',
        '  --list                    List projects from meta.json without analyzing',
        '  -h, --help                Show this help',
    ].join('\n'));
}

function requireValue(args: string[], index: number, option: string): string {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
}

function parsePositiveInteger(value: string, option: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer: ${value}`);
    return parsed;
}

function parseArgs(args: string[]): Options {
    let realAppsRoot = defaultRealAppsRoot;
    let hapflowRoot = defaultHapflowRoot;
    let sdkRoot = defaultSdkRoot;
    let outputPath: string | undefined;
    let timeoutMs = 600000;
    let usePta = false;
    const projects: string[] = [];
    let limit: number | undefined;
    let listOnly = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-h' || arg === '--help') { help(); process.exit(0); }
        if (arg === '--project') { projects.push(requireValue(args, index, arg)); index++; continue; }
        if (arg.startsWith('--project=')) { projects.push(arg.slice('--project='.length)); continue; }
        if (arg === '--limit') { limit = parsePositiveInteger(requireValue(args, index, arg), '--limit'); index++; continue; }
        if (arg.startsWith('--limit=')) { limit = parsePositiveInteger(arg.slice('--limit='.length), '--limit'); continue; }
        if (arg === '--output') { outputPath = path.resolve(requireValue(args, index, arg)); index++; continue; }
        if (arg.startsWith('--output=')) { outputPath = path.resolve(arg.slice('--output='.length)); continue; }
        if (arg === '--real-apps-root') { realAppsRoot = path.resolve(requireValue(args, index, arg)); index++; continue; }
        if (arg.startsWith('--real-apps-root=')) { realAppsRoot = path.resolve(arg.slice('--real-apps-root='.length)); continue; }
        if (arg === '--hapflow-root') { hapflowRoot = path.resolve(requireValue(args, index, arg)); index++; continue; }
        if (arg.startsWith('--hapflow-root=')) { hapflowRoot = path.resolve(arg.slice('--hapflow-root='.length)); continue; }
        if (arg === '--sdk-root') { sdkRoot = path.resolve(requireValue(args, index, arg)); index++; continue; }
        if (arg.startsWith('--sdk-root=')) { sdkRoot = path.resolve(arg.slice('--sdk-root='.length)); continue; }
        if (arg === '--timeout-ms') { timeoutMs = parsePositiveInteger(requireValue(args, index, arg), '--timeout-ms'); index++; continue; }
        if (arg.startsWith('--timeout-ms=')) { timeoutMs = parsePositiveInteger(arg.slice('--timeout-ms='.length), '--timeout-ms'); continue; }
        if (arg === '--pta') { usePta = true; continue; }
        if (arg === '--list') { listOnly = true; continue; }
        throw new Error(`Unknown option: ${arg}`);
    }
    return { realAppsRoot, hapflowRoot, sdkRoot, outputPath, timeoutMs, usePta, projects, limit, listOnly };
}

function loadMetadata(realAppsRoot: string): ProjectMetadata[] {
    const metadataPath = path.join(realAppsRoot, 'meta.json');
    if (!fs.existsSync(metadataPath)) throw new Error(`HarmonyRealApps metadata not found: ${metadataPath}`);
    const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { projects?: ProjectMetadata[] };
    if (!Array.isArray(parsed.projects)) throw new Error(`Invalid HarmonyRealApps metadata: ${metadataPath}`);
    return parsed.projects;
}

function selectProjects(metadata: ProjectMetadata[], options: Options): ProjectMetadata[] {
    let selected = metadata;
    if (options.projects.length > 0) {
        const byName = new Map(metadata.map(item => [item.name, item]));
        const unknown = options.projects.filter(name => !byName.has(name));
        if (unknown.length > 0) throw new Error(`Unknown project(s): ${unknown.join(', ')}. Use --list.`);
        selected = options.projects.map(name => byName.get(name)!);
    }
    if (options.limit !== undefined) selected = selected.slice(0, options.limit);
    return selected;
}

function writeJsonAtomic(outputPath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const tempPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tempPath, outputPath);
}

function createReport(options: Options, selected: ProjectMetadata[]) {
    return {
        kind: 'hapflow-real-apps',
        createdAt: new Date().toISOString(),
        completed: false,
        options: {
            realAppsRoot: options.realAppsRoot,
            hapflowRoot: options.hapflowRoot,
            sdkRoot: options.sdkRoot,
            timeoutMs: options.timeoutMs,
            pta: options.usePta,
        },
        summary: {
            totalProjects: selected.length,
            completedProjects: 0,
            successfulProjects: 0,
            failedProjects: 0,
            timedOutProjects: 0,
            noEntryProjects: 0,
            projectsWithFlows: 0,
            totalTaintFlows: 0,
            totalDurationMs: 0,
        },
        projects: [] as ProjectRecord[],
    };
}

type Report = ReturnType<typeof createReport>;

function updateSummary(report: Report): void {
    const summary = report.summary;
    summary.completedProjects = report.projects.length;
    summary.successfulProjects = report.projects.filter(p => p.status === 'success').length;
    summary.failedProjects = report.projects.filter(p => p.status === 'failed').length;
    summary.timedOutProjects = report.projects.filter(p => p.status === 'timeout').length;
    summary.noEntryProjects = report.projects.filter(p => p.status === 'no-entry').length;
    summary.projectsWithFlows = report.projects.filter(p => (p.outcomeCount ?? 0) > 0).length;
    summary.totalTaintFlows = report.projects.reduce((sum, p) => sum + (p.outcomeCount ?? 0), 0);
    summary.totalDurationMs = report.projects.reduce((sum, p) => sum + (p.durationMs ?? p.timeoutMs), 0);
}

function runOne(options: Options, tsNodeBin: string, runnerPath: string, metadata: ProjectMetadata, index: number): ProjectRecord {
    const projectPath = path.join(options.realAppsRoot, metadata.path);
    const resultPath = path.join(os.tmpdir(), `ark-hapflow-${process.pid}-${Date.now()}-${index}.json`);
    const child = spawnSync(
        process.execPath,
        [
            tsNodeBin,
            '-r', 'tsconfig-paths/register',
            runnerPath,
            '--project', projectPath,
            '--sdk-root', options.sdkRoot,
            '--output', resultPath,
            ...(options.usePta ? ['--pta'] : []),
        ],
        {
            cwd: options.hapflowRoot,
            encoding: 'utf8',
            timeout: options.timeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: 16 * 1024 * 1024,
            env: {
                ...process.env,
                TS_NODE_PROJECT: path.join(options.hapflowRoot, 'tsconfig.json'),
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim(),
            },
        }
    );

    let result: RunnerResult;
    if (fs.existsSync(resultPath)) {
        result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as RunnerResult;
    } else if ((child.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
        result = { status: 'timeout', error: `Timed out after ${options.timeoutMs}ms`, durationMs: options.timeoutMs };
    } else {
        const detail = child.stderr?.trim() || child.error?.message || `exit status ${child.status ?? 'signal'}`;
        result = { status: 'failed', error: detail.split(/\r?\n/).slice(0, 5).join('\n'), durationMs: 0 };
    }
    fs.rmSync(resultPath, { force: true });
    return { name: metadata.name, path: metadata.path, timeoutMs: options.timeoutMs, ...result };
}

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    const metadata = loadMetadata(options.realAppsRoot);
    if (options.listOnly) {
        for (const item of metadata) console.log(item.name);
        return;
    }
    const runnerPath = path.join(options.hapflowRoot, 'tests', 'ArkLifeguardRunner.ts');
    const tsNodeBin = path.join(options.hapflowRoot, 'node_modules', '.bin', 'ts-node-transpile-only');
    if (!fs.existsSync(runnerPath)) throw new Error(`HapFlow runner not found: ${runnerPath}`);
    if (!fs.existsSync(tsNodeBin)) throw new Error(`ts-node not found: ${tsNodeBin}`);
    const selected = selectProjects(metadata, options);
    if (selected.length === 0) throw new Error('No HarmonyRealApps projects selected');

    const report = createReport(options, selected);
    console.log(
        `HapFlow real-app taint analysis: projects=${selected.length}, ` +
        `sdk=${options.sdkRoot}, pta=${options.usePta}, timeout=${options.timeoutMs}ms`
    );
    selected.forEach((metadataItem, index) => {
        console.log(`[${index + 1}/${selected.length}] ${metadataItem.name}`);
        const record = runOne(options, tsNodeBin, runnerPath, metadataItem, index);
        report.projects.push(record);
        updateSummary(report);
        if (options.outputPath) writeJsonAtomic(options.outputPath, report);
        console.log(
            `  ${record.status.toUpperCase()} flows=${record.outcomeCount ?? 'n/a'} ` +
            `sources=${record.sourceNum ?? 'n/a'} edges=${record.edgeNum ?? 'n/a'} ` +
            `time=${record.durationMs ?? 'n/a'}ms rss=${record.rssEndMb?.toFixed(0) ?? 'n/a'}MB`
        );
        if (record.error) console.log(`  error: ${record.error.split(/\r?\n/)[0]}`);
    });

    report.completed = true;
    updateSummary(report);
    if (options.outputPath) {
        writeJsonAtomic(options.outputPath, report);
        console.log(`Report written to: ${options.outputPath}`);
    }
    console.log('HapFlow real-app summary:');
    console.log(JSON.stringify(report.summary, null, 2));
    if (report.summary.failedProjects > 0 || report.summary.timedOutProjects > 0) {
        process.exitCode = 1;
    }
}

try {
    main();
} catch (error) {
    console.error(`test-hapflow-real-apps: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
