class Account {
    value: number = 1;
    touch(): boolean { return true; }
}

export function castOptionalProperty(): number | undefined {
    const value = nullable();
    return (value as Account | null)?.value;
}

export function castUnprotectedProperty(): number {
    const value = nullable();
    return (value as Account)!.value;
}

export function typeofOptionalProperty(): number {
    const value = nullable();
    return typeof value?.value === 'number' ? value.value : 0;
}

export function continueAfterNullGuard(): void {
    for (let i = 0; i < 2; i++) {
        const value = nullable();
        if (!value || i === 1) continue;
        value.touch();
    }
}

function cachedWidths(present = false): number[] | undefined {
    return present ? [10] : undefined;
}
class WidthOwner {
    widths: number[] = [];
    initialize(): void {
        const cached = cachedWidths();
        const count = 1;
        if (cached && cached.length === count) {
            this.widths = cached;
            return;
        }
        this.widths = [];
    }
    read(): number { return this.widths[0] || 140; }
}
export function guardedWidthAssignment(): number {
    const owner = new WidthOwner();
    owner.initialize();
    return owner.read();
}

class Heading { type: string = 'heading'; level: number = 1; }
function absentHeading(): Heading | undefined { return undefined; }
export function guardedSwitchReceiver(): number {
    const base = absentHeading();
    if (base?.type === 'heading') {
        switch (base.level) { case 1: return 10; default: return 20; }
    }
    return 0;
}
export function staleSwitchReceiver(): number {
    let base = absentHeading();
    const type = base?.type;
    base = undefined;
    if (type === 'heading') {
        switch (base!.level) { case 1: return 10; default: return 20; }
    }
    return 0;
}

export function explicitFalsyComparisonStillUndefined(): number {
    const cached = cachedWidths();
    if (cached === undefined) return cached!.length;
    return 0;
}

export function reversePropertyGuard(): number {
    const node = absentHeading();
    if ('heading' === node?.type) {
        switch (node.level) { case 1: return 10; default: return 20; }
    }
    return 0;
}

export function earlyExitPropertyGuard(): number {
    const node = absentHeading();
    if (node?.type !== 'heading') return 0;
    switch (node.level) { case 1: return 10; default: return 20; }
}

export function earlyExitCompoundGuard(): number {
    const entries = cachedWidths();
    if (!entries || entries.length !== 1) return 0;
    return entries[0];
}

export function nullablePropertyComparison(): number {
    const node = absentHeading();
    if (node?.type === undefined) return node!.level;
    return 0;
}

export function mutatedPropertyGuard(): number {
    const holder = { node: absentHeading() };
    if (holder.node?.type === 'heading') {
        holder.node = undefined;
        return holder.node!.level;
    }
    return 0;
}

function nullable(present = false): Account | null { return present ? new Account() : null; }

export function mixedAccesses(): void {
    const safe = nullable();
    const unsafe = nullable();
    const result = [safe?.touch(), unsafe!.touch()];
}

export function guardThenWrite(): void {
    let value = nullable(true);
    if (value) {
        value = null;
        value!.touch();
    }
}

let firstCall = true;
function getAccount(): Account | null {
    if (firstCall) {
        firstCall = false;
        return new Account();
    }
    return null;
}
export function repeatedCall(): void {
    if (getAccount()) {
        getAccount()!.touch();
    }
}

class Controller {
    private resource: Account | null = null;
    private state: string = 'initial';
    initializeResource(): void { this.resource = new Account(); }
    isInPlayReadyState(): boolean { return this.state === 'ready'; }
    start(): void {
        this.state = 'ready'; // No resource initialization: the name proves no invariant.
        if (this.isInPlayReadyState()) this.resource!.touch();
    }
}

export function readyWithoutResource(): void {
    new Controller().start();
}

class RecordValue {
    address: string = '';
}
function nullableRecord(): RecordValue | null { return null; }

export function optionalIndex(): string | undefined {
    const record = nullableRecord();
    return record?.['address'];
}

export function optionalUnknownIndex(): string | undefined {
    const record: Record<string, string> | null = nullableUnknownRecord();
    return record?.['address'];
}

function nullableUnknownRecord(): Record<string, string> | null { return null; }

export function assertedIndex(): string {
    const record = nullableRecord();
    return record!['address'];
}

export function nullableChildInOptionalChain(): boolean {
    const record = new NullableChild();
    return record?.child!.touch();
}

class NullableChild { child: Account | null = null; }

function absentArray(): Account[] | undefined { return undefined; }
function absentString(): string | undefined { return undefined; }

export function guardedArrayRead(): number {
    const value = absentArray();
    if (!Array.isArray(value)) return 0;
    return value!.length;
}

export function guardedStringRead(): string[] {
    const value = absentString();
    if (typeof value !== 'string') return [];
    return value.split(',');
}

function acceptsString(value: string): string[] { return value.split(','); }
export function guardedStringArgument(): string[] {
    const value = absentString();
    if (typeof value === 'string') return acceptsString(value);
    return [];
}

export function typeofObjectStillNull(): boolean {
    const value = nullable();
    if (typeof value === 'object') return value!.touch();
    return false;
}

function arbitraryArrayPredicate(value: unknown): boolean { return true; }
export function arbitraryPredicateStillNull(): number {
    const value = absentArray();
    if (arbitraryArrayPredicate(value)) return value!.length;
    return 0;
}

export function staleTypeofStillNull(): boolean {
    let value = nullable(true);
    const type = typeof value;
    value = null;
    if (type === 'object') return value!.touch();
    return false;
}

export function explicitPredicateComparisonStillNull(): number {
    const value = absentArray();
    if (Array.isArray(value) === undefined) return 0;
    return value!.length;
}

class FakeArray {
    static isArray(value: unknown): boolean { return true; }
}
export function sameNamedPredicateStillNull(): number {
    const value = absentArray();
    if (FakeArray.isArray(value)) return value!.length;
    return 0;
}

export function mixedIndexedAccesses(): void {
    const safe = nullableUnknownRecord();
    const unsafe = nullableUnknownRecord();
    const result = [safe?.['address'], unsafe!['address']];
}

export function guardedFieldAlias(): boolean {
    const holder = new NullableChild();
    const value = holder.child;
    return value !== null && value!.touch();
}

export function ternaryFieldAlias(): boolean {
    const holder = new NullableChild();
    const value = holder.child;
    return value === null ? false : value!.touch();
}

function missingEntry(): Account | undefined { return undefined; }
export function templateReturnCoercion(): string {
    return `${missingEntry()}`;
}

export function explicitReturnToString(): string {
    return missingEntry()!.toString();
}

export function nullOnlyFallbackStillUndefined(): boolean {
    const value = missingEntry();
    const selected = value === null ? new Account() : value;
    return selected!.touch();
}

function touches(value: Account): boolean { return value.touch(); }
export function guardedCalleeArgument(): boolean {
    const value = nullable();
    return value !== null && touches(value);
}

export function unguardedCalleeArgument(): boolean {
    const value = nullable();
    return touches(value!);
}

export function mapGuardInLoop(): void {
    const entries = new Map<string, Account>();
    for (const key of ['one', 'one']) {
        if (entries.has(key)) {
            entries.get(key)!.touch();
        } else {
            entries.set(key, new Account());
        }
    }
}

export function mapGuardThenDelete(): void {
    const entries = new Map<string, Account>();
    entries.set('one', new Account());
    if (entries.has('one')) {
        entries.delete('one');
        entries.get('one')!.touch();
    }
}

export function preservedFieldSnapshot(): boolean {
    const holder = new NullableChild();
    holder.child = new Account();
    const snapshot = holder.child;
    holder.child = null;
    return snapshot!.touch();
}

export function nullableFieldSnapshot(): boolean {
    const holder = new NullableChild();
    holder.child = null;
    const snapshot = holder.child;
    holder.child = new Account();
    return (snapshot as Account | null)!.touch();
}

export function arrayGuardWithNestedComparison(): number {
    const value = absentArray();
    if (Array.isArray(value)) {
        if (typeof value![0] === 'object') return value!.length;
    }
    return 0;
}

export function shadowedCallbackCapture(): Promise<void> {
    const value = nullable();
    {
        const value = new Account();
        return Promise.resolve().then(() => { value.touch(); });
    }
}

export function realCallbackCapture(): Promise<void> {
    const value = nullable();
    return Promise.resolve().then(() => { value!.touch(); });
}

export function preservedSnapshotArgument(): boolean {
    const holder = new NullableChild();
    holder.child = new Account();
    const snapshot = holder.child;
    holder.child = null;
    return touches(snapshot);
}

export function nullableSnapshotArgument(): boolean {
    const holder = new NullableChild();
    const snapshot = holder.child;
    holder.child = new Account();
    return touches(snapshot!);
}

export function mapFalseGuard(): void {
    const entries = new Map<string, Account>();
    if (entries.has('one') === false) entries.get('one')!.touch();
}

function clearEntries(entries: Map<string, Account>): void { entries.clear(); }
export function mapGuardThenUnknownCall(): void {
    const entries = new Map<string, Account>();
    entries.set('one', new Account());
    if (entries.has('one')) {
        clearEntries(entries);
        entries.get('one')!.touch();
    }
}

export function staleSnapshotGuardStillNull(): boolean {
    const holder = new NullableChild();
    holder.child = new Account();
    const snapshot = holder.child;
    holder.child = null;
    if (snapshot) return holder.child!.touch();
    return false;
}

class CompoundGuard {
    expanded: boolean = true;
    child: Account | null = null;
    clear(): void { this.child = null; }
    protectedRead(): boolean {
        if (this.expanded && this.child !== null) {
            touches(this.child);
            return this.child.touch();
        }
        return false;
    }
    mutationAfterGuard(): boolean {
        this.child = new Account();
        if (this.expanded && this.child !== null) {
            this.clear();
            return this.child!.touch();
        }
        return false;
    }
}
export function compoundFieldGuard(): boolean { return new CompoundGuard().protectedRead(); }
export function compoundFieldGuardThenMutation(): boolean { return new CompoundGuard().mutationAfterGuard(); }
