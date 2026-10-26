export function run(): number {
    let result = 0;
    try {
        result = 1;
        throw new Error('explicit failure');
    } catch (error) {
        result = 2;
    }
    return result;
}

function fail(): never {
    throw new Error('callee failure');
}

function middle(): never {
    fail();
    throw new Error('unreachable fallback');
}

export function callAndCatch(): number {
    let result = 0;
    try {
        fail();
    } catch (error) {
        result = 1;
    }
    return result;
}

export function callThroughMiddleAndCatch(): number {
    let result = 0;
    try {
        middle();
    } catch (error) {
        result = 1;
    }
    return result;
}

export function noThrowCatch(): number {
    let result = 0;
    try {
        result = 1;
    } catch (error) {
        result = 2;
    }
    return result;
}

export function uncaughtThrow(): number {
    throw new Error('uncaught failure');
    return 1;
}

declare function ordinaryExternal(): void;
declare function ordinaryAsync(): Promise<void>;
/** @throws {Error} A documented interface failure. */
declare function documentedExternal(): void;
/** @throws {Error} A documented asynchronous failure. */
declare function documentedAsync(): Promise<void>;
/** @exception {Error} An alternate exception contract tag. */
declare function alternateExternal(): void;

function normalBody(): void { const value = 1; }

export function defaultCalls(): void {
    try {
        normalBody();
        ordinaryExternal();
    } catch (error) { const caught = 1; }
}

export function defaultReads(value: { name: string }, values: number[]): void {
    try {
        const name = value.name;
        const first = values[0];
    } catch (error) { const caught = 1; }
}

export async function defaultAwait(): Promise<void> {
    try { await ordinaryAsync(); } catch (error) { const caught = 1; }
}

export function documentedCall(): void {
    try { documentedExternal(); } catch (error) { const caught = 1; }
}

export async function documentedAwait(): Promise<void> {
    const promise = documentedAsync();
    try { await promise; } catch (error) { const caught = 1; }
}

function documentedHelper(): void { documentedExternal(); }

export function documentedThroughCall(): void {
    try { documentedHelper(); } catch (error) { const caught = 1; }
}

export function alternateContract(): void {
    try { alternateExternal(); } catch (error) { const caught = 1; }
}
