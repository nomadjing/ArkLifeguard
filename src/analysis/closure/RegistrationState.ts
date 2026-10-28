import type { Stmt } from '../../adapter/arkanalyzer';
import { HeapState } from '../shared/HeapState';
import type { RegistrationRule } from './RegistrationRules';

export interface Registration {
    readonly id: string;
    readonly rule: RegistrationRule;
    readonly site: Stmt;
    readonly registrars: readonly string[];
    readonly events: readonly string[];
    readonly callbacks: readonly string[];
    readonly token?: string;
    readonly owner?: string;
    readonly active: boolean;
    readonly repeated: boolean;
    readonly rootSlots: readonly string[];
}
export class RegistrationState extends HeapState {
    readonly registrations = new Map<string, Registration>();
    override clone(): RegistrationState {
        const state = this.copyTo(new RegistrationState());
        for (const [id, registration] of this.registrations) state.registrations.set(id, registration);
        return state;
    }
    override signature(encode: (value: string) => string | number = value => value): string {
        return `${super.signature(encode)}|${JSON.stringify([...this.registrations].sort(([a], [b]) => a.localeCompare(b)).map(([id, registration]) =>
            [encode(id), registration.active, registration.repeated, registration.registrars.map(encode),
                registration.events.map(encode), registration.callbacks.map(encode)]))}`;
    }
}
