import fs from 'node:fs';
import path from 'node:path';
import { ts } from '../adapter/arkanalyzer';

/** Names skipped before ArkAnalyzer scans the project tree. */
export const APPLICATION_IGNORE_FILE_NAMES = [
    '.agents',
    '.codex',
    '.git',
    '.idea',
    '.vscode',
    '.cxx',
    '.preview',
    '.test',
    '.hvigor',
    '.local-generator',
    'node_modules',
    'oh_modules',
    'third_party',
    'vendor',
    'build-tools',
    'hvigorfile.ts',
    'hvigorfile.js',
    'hvigor-wrapper.js',
    'build',
    'ohosTest',
    'test',
    'tests',
    '__tests__',
    'lib',
    'libs',
] as const;

const ignoredNames = new Set<string>(APPLICATION_IGNORE_FILE_NAMES);

/** Return source roots of modules declared by HarmonyOS build profiles. */
export function findHarmonyApplicationSourceRoots(projectPath: string): string[] {
    const roots = new Set<string>();
    walkProjectFiles((filePath, name) => {
        if (name !== 'build-profile.json5') return;
        const parsed = ts.parseConfigFileTextToJson(
            filePath,
            fs.readFileSync(filePath, 'utf8')
        );
        const modules: unknown = parsed.config?.modules;
        if (!Array.isArray(modules)) return;
        for (const module of modules) {
            if (typeof module?.srcPath !== 'string' ||
                !module.srcPath.trim() || /\$\{|\*/.test(module.srcPath)) {
                continue;
            }
            const sourceRoot = path.resolve(path.dirname(filePath), module.srcPath);
            if (fs.existsSync(sourceRoot) && fs.statSync(sourceRoot).isDirectory()) {
                roots.add(sourceRoot);
            }
        }
    }, projectPath);
    if (roots.size > 0) return [...roots];

    // Projects without a build profile can still expose runtime modules through
    // their module.json5 declarations.
    walkProjectFiles((filePath, name) => {
        if (name !== 'module.json5') return;
        const normalized = filePath.replace(/\\/g, '/');
        const marker = '/src/main/module.json5';
        roots.add(normalized.endsWith(marker)
            ? path.resolve(filePath.slice(0, -marker.length))
            : path.dirname(filePath));
    }, projectPath);
    return [...roots];
}

function walkProjectFiles(
    visit: (filePath: string, name: string) => void,
    directory: string,
    depth = 0
): void {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (!ignoredNames.has(entry.name) && !entry.name.startsWith('.')) {
                walkProjectFiles(visit, filePath, depth + 1);
            }
        } else if (entry.isFile()) {
            visit(filePath, entry.name);
        }
    }
}

/** Initial application inputs only; SDK and imported-dependency resolution stay separate. */
export function isApplicationSource(projectPath: string, filePath: string): boolean {
    const relative = path.relative(projectPath, filePath).replace(/\\/g, '/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        return false;
    }
    const segments = relative.split('/');
    if (segments.some(segment => ignoredNames.has(segment))) return false;
    if (/\.(test|spec)\.(ets|ts|js)$/.test(segments.at(-1) ?? '')) return false;
    return !/(^|\/)src\/main\/resources\//.test(relative);
}
