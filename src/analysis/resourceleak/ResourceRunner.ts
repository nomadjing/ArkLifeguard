import type { Scene } from '../../adapter/arkanalyzer';
import { ReleaseObligationRunner } from './ReleaseObligationRunner';
import { resolveHarmonyResourceRules } from './rules/HarmonyResourceRules';
import { UNSUPPORTED_RESOURCE_API_FAMILIES } from './rules/ResourceCapabilities';
import type { ResourceRule } from './rules/ResourceRule';

/** Explicit release obligations, including image memory and system resource handles. */
export class ResourceRunner extends ReleaseObligationRunner {
    constructor(scene: Scene, rules?: readonly ResourceRule[], collectStatistics = false) {
        const resolved = rules === undefined ? resolveHarmonyResourceRules(scene) : undefined;
        super(scene, rules ?? resolved!.rules, collectStatistics, {
            label: '资源',
            scope: 'resource',
            unresolvedRuleIds: resolved?.unresolvedRuleIds ?? [],
            unsupportedApiFamilies: UNSUPPORTED_RESOURCE_API_FAMILIES,
        });
    }
}
