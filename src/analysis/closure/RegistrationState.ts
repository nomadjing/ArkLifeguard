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
    override signature(): string {
        return `${super.signature()}|${JSON.stringify([...this.registrations].map(([id, registration]) =>
            [id, registration.active, registration.repeated, registration.registrars, registration.events, registration.callbacks]).sort())}`;
    }
}
