class Account { touch(): void {} }
class ItemNode { items: number[] = []; }
function absentNode(): ItemNode | undefined { return undefined; }
export function mixedOptionalCalls(): void {
    if (absentNode()?.items && absentNode()!.items.length > 0) { }
}
export function reversedOptionalCalls(): void {
    if (absentNode()!.items.length > 0 && absentNode()?.items) { }
}
export function optionalCallOnly(): void { const value = absentNode()?.items; }
export function jsonNull(): void { const value = JSON.parse('null'); value.map(() => 1); }
export function guardedJson(): void { const value = JSON.parse('null'); if (value) value.map(() => 1); }
export function jsonUndefined(): void { const value = JSON.stringify(undefined); value!.trim(); }
export function jsonNullGuard(text: string): void {
    const value = JSON.parse(text); if (value === null) return; value.field;
}
export function jsonUndefinedReviver(text: string): void {
    const value = JSON.parse(text, undefined); if (value === null) return; value.field;
}
export function jsonNullReviver(text: string): void {
    // @ts-expect-error ECMAScript accepts a non-callable reviver and ignores it.
    const value = JSON.parse(text, null); if (value === null) return; value.field;
}
export function jsonCallableReviver(text: string): void {
    const value = JSON.parse(text, () => undefined); if (value === null) return; value.field;
}
export function jsonNullStillUnsafe(text: string): void {
    const value = JSON.parse(text); if (value === undefined) return; value.field;
}
export function jsonRoundtripToNull(): void {
    const value = JSON.parse(JSON.stringify({ toJSON() { return null; } })); value.field;
}
export function stringApis(): void { ' value '.trim().split(',').slice(); }
function identity(value: Account | null): Account | null { return value; }
export function returnedParameter(): void { identity(null)!.touch(); }

class Holder {
    value: Account | null = null;
    get selected(): Account | null { return this.value; }
    guarded(): void { if (this.selected) this.selected!.touch(); }
    unsafe(): void { this.selected!.touch(); }
    optional(): void { this.selected?.touch(); }
    changed(): void {
        this.value = new Account();
        if (this.selected) { this.value = null; this.selected!.touch(); }
    }
}
export function guardedGetter(): void { new Holder().guarded(); }
export function nullableGetter(): void { new Holder().unsafe(); }
export function optionalGetter(): void { new Holder().optional(); }
export function changedGetter(): void { new Holder().changed(); }

class ChangingHolder {
    first: boolean = true;
    get selected(): Account | null {
        if (this.first) { this.first = false; return new Account(); }
        return null;
    }
}
export function effectfulGetter(): void {
    const holder = new ChangingHolder();
    if (holder.selected) holder.selected!.touch();
}

declare function register(callback: () => void): void;
function invokeNow(callback: () => void): void { callback(); }
function forwardNow(callback: () => void): void { invokeNow(callback); }
export function synchronousCallback(): void {
    forwardNow(() => { const account: Account | null = null; account!.touch(); });
}
function enqueue(callback: () => void): void { setTimeout(callback, 0); }
export function timerWrapper(): void {
    enqueue(() => { const account: Account | null = null; account!.touch(); });
}
export function deferredCallback(): void {
    const account: Account | null = null;
    register(() => { account!.touch(); });
}
async function asynchronous(): Promise<Account | null> { return null; }
export async function awaitedValue(): Promise<void> { const account = await asynchronous(); account!.touch(); }
export function callsAsync(): void { asynchronous(); }

export function flagGuard(flag: boolean): void {
    let account: Account;
    let empty = false;
    if (flag) empty = true; else account = new Account();
    if (empty) return;
    account!.touch();
}
export function flagGuardMissingAssignment(flag: boolean): void {
    let account: Account;
    let empty = false;
    if (flag) empty = true;
    if (empty) return;
    account!.touch();
}
export function flagGuardThenNull(flag: boolean): void {
    let account: Account | null;
    let empty = false;
    if (flag) empty = true; else account = new Account();
    if (empty) return;
    account = null;
    account!.touch();
}
export function flagGuardWithAssignmentInCondition(flag: boolean): void {
    let account: Account;
    let empty = false;
    if (flag) empty = true;
    if (empty = false) return;
    account!.touch();
}
export function shadowedFlag(flag: boolean): void {
    let account: Account;
    let empty = false;
    if (flag) { let empty = true; } else account = new Account();
    if (empty) return;
    account!.touch();
}
export function copiedUndefined(flag: boolean): void {
    let account: Account | undefined;
    let empty = false;
    const saved = account;
    if (flag) empty = true; else account = saved;
    if (empty) return;
    account!.touch();
}
export function guardedIteration(flag: boolean): void {
    let accounts: Account[];
    let empty = false;
    if (flag) empty = true; else accounts = [];
    if (empty) return;
    for (const account of accounts!) account.touch();
}

export function numericConversions(value: unknown): string {
    if (typeof value === 'number') return value.toString();
    return Number(value).toString();
}

class NestedState { value: Account | null = null; }
class NestedHolder {
    state: NestedState | undefined = undefined;
    get selected(): Account | null | undefined {
        if (this.state) return this.state.value;
        return undefined;
    }
    read(): Account | null | undefined {
        if (this.state) return this.state.value;
        return undefined;
    }
    clear(): void { this.state = undefined; }
    guarded(): void { if (this.selected) this.selected!.touch(); }
    guardedMethod(): void { if (this.read()) this.read()!.touch(); }
    unsafe(): void { this.selected!.touch(); }
    changed(): void {
        this.state = new NestedState(); this.state.value = new Account();
        if (this.selected) { this.state = undefined; this.selected!.touch(); }
    }
    changedByCall(): void {
        this.state = new NestedState(); this.state.value = new Account();
        if (this.selected) { this.clear(); this.selected!.touch(); }
    }
}
export function nestedGuarded(): void { new NestedHolder().guarded(); }
export function nestedReadMethod(): void { new NestedHolder().guardedMethod(); }
export function nestedUnsafe(): void { new NestedHolder().unsafe(); }
export function nestedChanged(): void { new NestedHolder().changed(); }
export function nestedChangedByCall(): void { new NestedHolder().changedByCall(); }
class ConditionalHolder {
    enabled: boolean = false;
    value: Account = new Account();
    get selected(): Account | null { if (this.enabled) return this.value; return null; }
}
export function unrelatedGetterGuard(): void { new ConditionalHolder().selected!.touch(); }
export function nestedSavedThenChanged(): void {
    const holder = new NestedHolder();
    holder.state = new NestedState(); holder.state.value = new Account();
    const saved = holder.selected;
    holder.state = undefined;
    if (saved) holder.selected!.touch();
}
