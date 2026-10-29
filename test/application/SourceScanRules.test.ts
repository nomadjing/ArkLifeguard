import { describe, expect, it } from 'vitest';
import { isApplicationSource } from '../../src/application/SourceScanRules';

describe('application source scan boundaries', () => {
    it.each(['entry/src/test/Case.ets', 'entry/src/ohosTest/Case.ets', 'tests/input.ts',
        'entry/src/main/ets/Case.test.ets', 'entry/src/main/resources/rawfile/mermaid/main.js'])(
        'excludes test or resource input: %s', file => {
            expect(isApplicationSource('/project', `/project/${file}`)).toBe(false);
        });
    it.each(['markdown/src/main/ets/lib/Index.ets', 'oh_modules/library/Index.ets',
        'entry/src/main/ets/resource/ResourceManager.ets', 'entry/src/main/ets/Latest.ets',
        'entry/src/main/ets/api.d.ts', 'entry/src/main/ets/utils/helper.js'])(
        'preserves production and dependency input: %s', file => {
            expect(isApplicationSource('/project', `/project/${file}`)).toBe(true);
        });
});
