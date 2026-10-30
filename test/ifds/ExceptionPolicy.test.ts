import { describe, expect, it, vi } from 'vitest';
import type { ArkFile, ArkMethod, Scene, Stmt } from '../../src/adapter/arkanalyzer';
import { ExceptionPolicy } from '../../src/ifds/icfg/ExceptionPolicy';

function fixture(prefix: string, indent = '') {
    const code = `${prefix}${indent}function api(): void;`;
    const file = { getCode: vi.fn(() => code) } as unknown as ArkFile;
    const position = { getFirstLine: () => prefix.split('\n').length,
        getFirstCol: () => indent.length + 1 };
    const method = { getDeclaringArkFile: () => file, getImplOriginFullPosition: () => undefined,
        getDeclareOriginFullPositions: () => [position] } as unknown as ArkMethod;
    const getMethod = vi.fn(() => method);
    const scene = { getMethod } as unknown as Scene;
    const stmt = { getInvokeExpr: () => ({ getMethodSignature: () => ({}) }),
        getExprs: () => [] } as unknown as Stmt;
    return { policy: new ExceptionPolicy(scene), stmt, getMethod, file };
}

describe('exception contract lookup', () => {
    it.each([
        ['/**\n * @throws {Error} failure\n */\n', true],
        ['/** @exception failure */\n', true],
        ['/** @throws failure */\n/** @since 12 */\n\n', true],
        ['/** @throws failure */\n/* ordinary comment */\n', true],
        ['/** @throws failure */\nconst unrelated = 1;\n', false],
        ['/** mentions @throws in prose */\n', false],
        ['/** @since 12 */\n', false],
        ['', false],
    ])('reads only adjacent contract blocks in %s', (prefix, expected) => {
        const { policy, stmt } = fixture(prefix, '  ');
        expect(policy.mayThrow(stmt)).toBe(expected);
    });

    it('caches both successful and absent contracts per statement', () => {
        for (const prefix of ['', '/** @throws failure */\n']) {
            const { policy, stmt, getMethod, file } = fixture(prefix);
            const first = policy.mayThrow(stmt);
            expect(policy.mayThrow(stmt)).toBe(first);
            expect(getMethod).toHaveBeenCalledTimes(1);
            expect(file.getCode).toHaveBeenCalledTimes(1);
        }
    });
});
