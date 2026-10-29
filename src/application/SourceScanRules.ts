import path from 'node:path';

/** Initial application inputs only; SDK and imported-dependency resolution stay separate. */
export function isApplicationSource(projectPath: string, filePath: string): boolean {
    const relative = path.relative(projectPath, filePath).replace(/\\/g, '/');
    const segments = relative.split('/');
    if (segments.slice(0, -1).some(segment => ['test', 'tests', 'ohosTest', '__tests__'].includes(segment))) return false;
    if (/\.(test|spec)\.(ets|ts|js)$/.test(relative)) return false;
    return !/(^|\/)src\/main\/resources\//.test(relative);
}
