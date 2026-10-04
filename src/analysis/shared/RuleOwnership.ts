import type { SourceDefinition } from '../resource/TaintFact';

/** Migrate mechanisms, not old category labels. Keep this audit separate from active rules. */
export function legacyRuleOwnership(source: SourceDefinition): {
    domain: 'resource' | 'closure' | 'removed'; reason: string;
} {
    if (source.id === 'ArrayBuffer.new') return { domain: 'removed', reason: 'Allocation alone is not retention evidence' };
    if (source.id === 'image.createPixelMap.memory') return { domain: 'removed', reason: 'Duplicate explicit PixelMap resource obligation' };
    if (source.id === 'distributedDataObject.create') return { domain: 'removed', reason: 'Creating a DataObject is not an on/off registration' };
    if (['new.Worker', 'worker.ThreadWorker'].includes(source.id)) return { domain: 'resource', reason: 'Explicit terminate obligation' };
    if (!source.pairedSinkId) return { domain: 'removed', reason: 'No declared release obligation; acquisition alone is not a leak' };
    if (source.category === 'closure' || /(?:Listener|Subscription|Callback|Timer)/.test(source.resourceType) ||
        /\.(?:off|unsubscribe)$/.test(source.pairedSinkId ?? '')) {
        return { domain: 'closure', reason: 'Registration and callback identity require the independent registration model' };
    }
    return { domain: 'resource', reason: 'Explicit acquire/release obligation' };
}

export const LEGACY_REGISTRATION_RULES: Readonly<Record<string, string>> = {
    setInterval: 'IntervalRegistration', setTimeout: 'TimeoutRegistration',
    'emitter.on': 'EmitterRegistration', 'EventHub.on': 'EventHubRegistration',
    'WindowStage.on': 'WindowStageRegistration', 'window.on': 'WindowRegistration',
    'DataObject.on': 'DataObjectRegistration', 'display.on': 'DisplayRegistration',
};

export function legacyRuleMigration(sources: readonly SourceDefinition[]) {
    return sources.map(source => {
        const ownership = legacyRuleOwnership(source);
        const replacement = LEGACY_REGISTRATION_RULES[source.id];
        return { legacyId: source.id, legacyCategory: source.category, ...ownership,
            status: ownership.domain === 'removed' ? 'removed' : ownership.domain === 'resource'
                ? 'legacy-resource' : replacement ? 'modeled-registration' : 'unsupported-registration',
            ...(replacement ? { replacement } : {}) };
    });
}
