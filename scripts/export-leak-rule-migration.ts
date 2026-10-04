import fs from 'node:fs';
import path from 'node:path';
import { HARMONYOS_SOURCES, HARMONYOS_SINKS } from '../src/analysis/resource/SourceSinkManager';
import { legacyRuleMigration } from '../src/analysis/shared/RuleOwnership';

// Source inventory only; support statuses do not assert a real-app TP/FP/FN oracle.
const migration = legacyRuleMigration(HARMONYOS_SOURCES);
const rules = migration.map(item => {
    const source = HARMONYOS_SOURCES.find(source => source.id === item.legacyId)!;
    const sink = HARMONYOS_SINKS.find(sink => sink.id === source.pairedSinkId);
    return { ...item, methodPattern: source.methodPattern, resourceType: source.resourceType,
        legacyFactSource: source.returnTainted ? 'return' : source.taintedParamIndices.length ? 'params' : 'none',
        taintedParamIndices: source.taintedParamIndices, pairedSinkId: source.pairedSinkId ?? null,
        sinkPattern: sink?.methodPattern ?? null,
        lifetimeBoundary: item.domain === 'closure' ? 'explicit owner lifecycle end'
            : item.domain === 'resource' ? 'resource-engine-specific' : 'no active leak rule' };
});
const outputPath = path.resolve(process.argv[2] ?? 'artifacts/validation/leak-rule-migration.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({ schemaVersion: 2,
    supportNote: 'legacy-resource retains heuristic resource rules; modeled-registration still requires SDK resolution; unsupported rules produce no invented leak diagnostics',
    counts: Object.fromEntries(['legacy-resource', 'modeled-registration', 'unsupported-registration', 'removed']
        .map(status => [status, rules.filter(rule => rule.status === status).length])), rules }, null, 2) + '\n');
console.log(`Wrote ${rules.length} rules to ${outputPath}`);
