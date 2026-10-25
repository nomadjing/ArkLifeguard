class Account {
    touch(): boolean { return true; }
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
