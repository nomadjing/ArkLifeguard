import type { ArkMethod, Scene, Stmt } from '../../adapter/arkanalyzer';
import { HeapFlow, type HeapFlowOptions } from '../shared/HeapFlow';
import { retentionLocation } from '../shared/AnalysisLocation';
import { RegistrationModel } from './RegistrationModel';
import { RegistrationState, type Registration } from './RegistrationState';
import { resolveRegistrationRules, type RegistrationRule } from './RegistrationRules';
import type { ClosureAnalysisResult, ClosureRetentionDiagnostic, RegistrationDiagnostic } from './ClosureResult';
import { UNSUPPORTED_REGISTRATION_API_FAMILIES } from './RegistrationCapabilities';

export class ClosureRunner {
    constructor(private readonly scene: Scene, private readonly rules?: readonly RegistrationRule[],
        private readonly options: HeapFlowOptions = {}) {}
    runWithDummyMain(entry: ArkMethod): ClosureAnalysisResult {
        const base = { enabled: true, registrationLeaks: [], closureRetentionLeaks: [],
            unresolvedRuleIds: [] as readonly string[], limitations: [] as readonly string[],
            unsupportedApiFamilies: UNSUPPORTED_REGISTRATION_API_FAMILIES };
        try {
            const resolution = this.rules === undefined ? resolveRegistrationRules(this.scene)
                : { rules: this.rules, unresolvedRuleIds: [] };
            base.unresolvedRuleIds = resolution.unresolvedRuleIds;
            if (!resolution.rules.length && this.rules !== undefined) throw new Error('No configured registration rules');
            const model = new RegistrationModel(resolution.rules);
            const observed = new Map<string, { registration: Registration; exit: Stmt; active: boolean;
                inactive: boolean; uncertain: boolean; closure?: ClosureRetentionDiagnostic }>();
            const flow = new HeapFlow<RegistrationState>(this.scene, {
                invoke: (stmt, state, ctx, engine) => model.invoke(stmt, state, ctx, engine),
                boundary: (exit, state, ctx) => {
                    for (const registration of state.registrations.values()) {
                        if (!registration.owner || !ctx.receiver.includes(registration.owner)) continue;
                        const key = `${registration.id}:${registration.owner}`;
                        const previous = observed.get(key);
                        const uncertain = registration.repeated || registration.rule.selfExpiring ||
                            state.uncertainties.size > 0 || registration.callbacks.length !== 1 ||
                            registration.registrars.length !== 1 ||
                            (registration.rule.kind === 'event' && registration.events.length !== 1);
                        const diagnostic: RegistrationDiagnostic = {
                            registrationId: registration.id, ruleId: registration.rule.id,
                            registration: retentionLocation(registration.site), boundary: retentionLocation(exit),
                            registrars: registration.registrars, events: registration.events, callbacks: registration.callbacks,
                            timerId: registration.token,
                            reason: uncertain ? 'unknown-registration' : 'unregistered', confidence: uncertain ? 'low' : 'high',
                        };
                        const retained = registration.active && registration.callbacks.length ? [...state.objects.values()]
                            .filter(object => object.kind === 'object' && (object.id === registration.owner || object.lifetimeOwner === registration.owner))
                            .map(object => ({ object, path: state.pathTo(object.id, () => true, registration.callbacks, registration.rootSlots) }))
                            .find(item => item.path) : undefined;
                        const path = retained?.path;
                        const closure = path ? { ...diagnostic,
                            confidence: retained!.object.id === registration.owner ? diagnostic.confidence : 'low' as const,
                            capturedObject: retained!.object.id, root: path.root,
                                lifecycleEnd: retentionLocation(exit), retentionPath: path.edges.map(edge => ({
                                    ...edge, location: edge.location ? retentionLocation(edge.location) : undefined,
                                })) } : undefined;
                        observed.set(key, { registration, exit, active: previous?.active === true || registration.active,
                            inactive: previous?.inactive === true || !registration.active,
                            uncertain: previous?.uncertain === true || !!uncertain,
                            closure: previous?.closure ?? closure });
                    }
                },
            }, this.options);
            const statistics = flow.run(entry, new RegistrationState());
            const registrationLeaks: RegistrationDiagnostic[] = [];
            const closureRetentionLeaks: ClosureRetentionDiagnostic[] = [];
            for (const item of observed.values()) {
                if (!item.active) continue;
                const registration = item.registration;
                const uncertain = item.uncertain;
                const diagnostic: RegistrationDiagnostic = { registrationId: registration.id, ruleId: registration.rule.id,
                    registration: retentionLocation(registration.site), boundary: retentionLocation(item.exit),
                    registrars: registration.registrars, events: registration.events, callbacks: registration.callbacks,
                    timerId: registration.token,
                    reason: item.inactive ? 'partially-unregistered' : uncertain ? 'unknown-registration' : 'unregistered',
                    confidence: uncertain || item.inactive || !statistics.success ? 'low' : 'high' };
                if (item.closure) closureRetentionLeaks.push({ ...item.closure, reason: diagnostic.reason,
                    confidence: item.closure.confidence === 'low' ? 'low' : diagnostic.confidence });
                else registrationLeaks.push(diagnostic);
            }
            return { ...base, success: statistics.success, registrationLeaks, closureRetentionLeaks,
                statistics, limitations: statistics.limitations,
                ...(!statistics.success ? { error: 'Retention analysis budget exceeded; results are incomplete' } : {}) };
        } catch (error) { return { ...base, success: false, error: error instanceof Error ? error.message : String(error) }; }
    }
}
