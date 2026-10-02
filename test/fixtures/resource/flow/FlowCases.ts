class Handle {
    static open(): Handle { return new Handle(); }
    release(): void {}
}

class Other {
    static open(): Handle { return new Handle(); }
    static close(_handle: Handle): void {}
}

class Token {
    static subscribe(): Token { return new Token(); }
}

class Box { value?: Handle; }

declare function externalConsume(handle: Handle): void;
declare function schedule(callback: () => void): void;

export class FlowCases {
    private field?: Handle;

    store(): void {
        this.field = Handle.open();
    }

    releaseField(): void {
        this.field?.release();
    }

    static releaseAcrossMethods(): void {
        const owner = new FlowCases();
        owner.store();
        owner.releaseField();
    }

    static leakAcrossMethods(): void {
        const owner = new FlowCases();
        owner.store();
    }

    static leak(): void {
        const handle = Handle.open();
        handle.toString();
    }

    static releaseAlias(): void {
        const handle = Handle.open();
        const alias = handle;
        alias.release();
    }

    static wrongRelease(): void {
        const handle = Handle.open();
        Other.close(handle);
    }

    static overwritten(): void {
        let handle: Handle | null = Handle.open();
        handle = null;
    }

    static partial(shouldRelease: boolean): void {
        const handle = Handle.open();
        if (shouldRelease) handle.release();
    }

    static closeHandle(handle: Handle): void {
        handle.release();
    }

    static releaseInCallee(): void {
        const handle = Handle.open();
        FlowCases.closeHandle(handle);
    }

    static factory(): Handle {
        return Handle.open();
    }

    static releaseFactoryResult(): void {
        const handle = FlowCases.factory();
        handle.release();
    }

    static oneOfTwo(): void {
        const first = Handle.open();
        const second = Handle.open();
        first.release();
        second.toString();
    }

    static unknownOwnership(): void {
        const handle = Handle.open();
        externalConsume(handle);
    }

    static nullify(): void {
        let token: Token | null = Token.subscribe();
        token = null;
    }

    static returnToCaller(): Handle {
        return Handle.open();
    }

    static storeInContainer(): void {
        const handle = Handle.open();
        const box = new Box();
        box.value = handle;
    }

    static optionalCallbackRelease(): void {
        const handle = Handle.open();
        schedule(() => handle.release());
    }

    static promiseCallbackRelease(): void {
        const handle = Handle.open();
        Promise.resolve().then(() => handle.release());
    }

    static releaseThenCallback(): void {
        const handle = Handle.open();
        handle.release();
        schedule(() => {});
    }
}
