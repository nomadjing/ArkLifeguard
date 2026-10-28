class Leaf {
    touch(): number { return 1; }
}

class Cell {
    value: Leaf | null = null;
    reset(): void { this.value = new Leaf(); }
}

class State {
    static value: Leaf | null = null;
    static reset(): void { State.value = new Leaf(); }
}

function resetArgument(cell: Cell): void { cell.value = new Leaf(); }
function clearArgument(cell: Cell): void { cell.value = null; }
function clearStatic(): void { State.value = null; }
declare function opaque(cell: Cell): void;
function unrelated(): number { return 7; }

export function staticOverwrite(): number {
    State.value = null;
    State.value = new Leaf();
    return State.value!.touch();
}

export function staticGuarded(): number {
    clearStatic();
    if (State.value !== null) return State.value.touch();
    return 0;
}

export function staticShortCircuit(): boolean {
    clearStatic();
    return State.value !== null && State.value.touch() > 0;
}

export function staticOptional(): number {
    clearStatic();
    return State.value?.touch() ?? 0;
}

export function staticCallOverwrite(): number {
    State.value = null;
    State.reset();
    return State.value!.touch();
}

export function argumentOverwrite(): number {
    const cell = new Cell();
    cell.value = null;
    resetArgument(cell);
    return cell.value!.touch();
}

export function argumentBecomesNull(): number {
    const cell = new Cell();
    cell.value = new Leaf();
    clearArgument(cell);
    return cell.value!.touch();
}

export function unchangedArgument(): number {
    const cell = new Cell();
    cell.value = null;
    unrelated();
    return cell.value!.touch();
}

export function unknownArgumentCall(): number {
    const cell = new Cell();
    cell.value = null;
    opaque(cell);
    return cell.value!.touch();
}

function rebindParameter(cell: Cell): void { cell = new Cell(); }
export function parameterRebinding(): number {
    const cell = new Cell();
    cell.value = null;
    rebindParameter(cell);
    return cell.value!.touch();
}

export function parameterRebindingSafe(): number {
    const cell = new Cell();
    cell.value = new Leaf();
    rebindParameter(cell);
    return cell.value!.touch();
}

export function separateArgumentObjects(): number {
    const first = new Cell();
    const second = new Cell();
    resetArgument(first);
    first.value!.touch();
    return second.value!.touch();
}

function resetOrKeep(cell: Cell, change: boolean): void { if (change) cell.value = new Leaf(); }
export function conditionalArgumentUpdate(change: boolean): number {
    const cell = new Cell();
    cell.value = null;
    resetOrKeep(cell, change);
    return cell.value!.touch();
}

function resetAndThrow(cell: Cell): void { cell.value = new Leaf(); throw new Error('stop'); }
function clearAndThrow(cell: Cell): void { cell.value = null; throw new Error('stop'); }
export function exceptionalReset(): number {
    const cell = new Cell();
    cell.value = null;
    try { resetAndThrow(cell); } catch (error) { return cell.value!.touch(); }
    return 0;
}
export function exceptionalClear(): number {
    const cell = new Cell();
    cell.value = new Leaf();
    try { clearAndThrow(cell); } catch (error) { return cell.value!.touch(); }
    return 0;
}

export function receiverOverwrite(): number {
    const cell = new Cell();
    cell.value = null;
    cell.reset();
    return cell.value!.touch();
}

export function aliasOverwrite(): number {
    const cell = new Cell();
    const alias = cell;
    cell.value = null;
    alias.value = new Leaf();
    return cell.value!.touch();
}

export function trulyNullStatic(): number {
    State.value = null;
    return State.value!.touch();
}

export function trulyNullArgument(): number {
    const cell = new Cell();
    cell.value = null;
    unrelated();
    return cell.value!.touch();
}

class Owner {
    value: Leaf | null = null;
    attach(): Promise<void> {
        const promise: Promise<void> = Promise.resolve();
        return promise.then(() => { this.value = null; });
    }
    each(callback: () => void): void { callback(); }
    checkCallbackReceiver(): number {
        this.value = new Leaf();
        const other = new Owner();
        other.value = null;
        other.each(() => { this.value!.touch(); });
        return 1;
    }
    failInCallback(): Promise<void> {
        this.value = null;
        const promise: Promise<void> = Promise.resolve();
        return promise.then(() => { this.value!.touch(); });
    }
    callbackUpdate(): number {
        this.value = new Leaf();
        const other = new Owner();
        other.each(() => { this.value = null; });
        return this.value!.touch();
    }
}

export function callbackOwner(): Promise<void> { return new Owner().attach(); }
export function callbackReceiverEntry(): number { return new Owner().checkCallbackReceiver(); }
export function callbackRealDefect(): Promise<void> { return new Owner().failInCallback(); }
export function lexicalCallbackUpdate(): number { return new Owner().callbackUpdate(); }

