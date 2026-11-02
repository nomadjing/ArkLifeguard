import path from 'node:path';

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
