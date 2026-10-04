import { ArkAssignStmt, ArkInstanceInvokeExpr, type Stmt } from '../../adapter/arkanalyzer';
import type { HeapContext, HeapFlow } from '../shared/HeapFlow';
import { RegistrationState, type Registration } from './RegistrationState';
import type { RegistrationRule } from './RegistrationRules';

/** Registration identity is API family + registrar + event + callback, never callback body equality. */
export class RegistrationModel {
    constructor(readonly rules: readonly RegistrationRule[]) {
        const ids = new Set<string>();
        for (const rule of rules) {
            if (!rule.id || ids.has(rule.id) || !rule.allocators.length || !rule.releasers.length ||
                !Number.isInteger(rule.callbackIndex) || rule.callbackIndex < 0 ||
                [rule.eventIndex, rule.releaseEventIndex, rule.releaseCallbackIndex]
                    .some(index => index !== undefined && (!Number.isInteger(index) || index < 0))) {
                throw new Error(`Invalid registration rule: ${rule.id}`);
            }
            ids.add(rule.id);
        }
    }

    invoke(stmt: Stmt, state: RegistrationState, ctx: HeapContext, flow: HeapFlow<RegistrationState>): boolean {
        const invoke = stmt.getInvokeExpr();
        if (!invoke) return false;
        const signature = invoke.getMethodSignature().toString();
        let handled = false;
        for (const rule of this.rules) {
            if (rule.allocators.includes(signature)) {
                handled = true;
                const registrars = rule.registrar === 'system' ? [`system:${rule.id.replace('Once', '')}`]
                    : invoke instanceof ArkInstanceInvokeExpr ? flow.read(invoke.getBase(), state, ctx) : [];
                const callbackArg = invoke.getArgs()[rule.callbackIndex];
                const callbacks = callbackArg ? flow.read(callbackArg, state, ctx, stmt) : [];
                const events = rule.eventIndex === undefined ? []
                    : this.event(invoke.getArgs()[rule.eventIndex] ? flow.read(invoke.getArgs()[rule.eventIndex], state, ctx, stmt) : [], state);
                const id = `registration:${rule.id}:${flow.siteId(stmt)}:${ctx.scope}`;
                const token = rule.kind === 'timer' ? `timer:${id}` : undefined;
                const rootSlots = registrars.map(registrar => rule.registrar === 'system'
                    ? `registration-root:${registrar}:${id}` : `field:${registrar}:listener:${id}`);
                const registration: Registration = { id, rule, site: stmt, registrars, callbacks, events,
                    token, owner: ctx.lifetimeOwner, active: true,
                    repeated: state.registrations.get(id)?.active === true, rootSlots };
                state.registrations.set(id, registration);
                for (const slot of rootSlots) {
                    state.set(slot, callbacks, stmt);
                    if (rule.registrar === 'system') state.roots.add(slot);
                }
                if (token && stmt instanceof ArkAssignStmt) flow.write(stmt.getLeftOp(), [token], state, ctx, stmt);
                if (!callbacks.length || (rule.kind === 'event' && !events.length) || !registrars.length) {
                    state.uncertainties.add('unknown-registration-identity');
                }
            }
            if (rule.releasers.includes(signature)) {
                handled = true;
                const tokens = rule.kind === 'timer' && invoke.getArgs()[0] ? flow.read(invoke.getArgs()[0], state, ctx, stmt) : [];
                const registrars = rule.registrar === 'system' ? [`system:${rule.id.replace('Once', '')}`]
                    : invoke instanceof ArkInstanceInvokeExpr ? flow.read(invoke.getBase(), state, ctx) : [];
                const events = rule.releaseEventIndex === undefined ? []
                    : this.event(invoke.getArgs()[rule.releaseEventIndex] ? flow.read(invoke.getArgs()[rule.releaseEventIndex], state, ctx, stmt) : [], state);
                const callbackArg = rule.releaseCallbackIndex === undefined ? undefined : invoke.getArgs()[rule.releaseCallbackIndex];
                const callbacks = callbackArg ? flow.read(callbackArg, state, ctx, stmt) : [];
                for (const [id, registration] of state.registrations) {
                    if (registration.rule.id !== rule.id || !registration.active) continue;
                    const matches = rule.kind === 'timer' ? !!registration.token && tokens.includes(registration.token)
                        : this.same(registration.registrars, registrars) && this.same(registration.events, events) &&
                            (callbackArg ? this.same(registration.callbacks, callbacks) : rule.allowRemoveAll === true);
                    if (!matches) continue;
                    if (registration.repeated) {
                        state.uncertainties.add('repeated-registration-identity'); continue;
                    }
                    state.registrations.set(id, { ...registration, active: false });
                    for (const slot of registration.rootSlots) state.slots.delete(slot);
                }
            }
        }
        return handled;
    }

    private event(values: readonly string[], state: RegistrationState): readonly string[] {
        return [...new Set(values.flatMap(value => state.objects.has(value)
            ? state.slots.get(`field:${value}:eventId`) ?? [value] : [value]))].sort();
    }
    private same(left: readonly string[], right: readonly string[]): boolean {
        return left.length === 1 && right.length === 1 && !left[0].startsWith('unknown:') && left[0] === right[0];
    }
}
