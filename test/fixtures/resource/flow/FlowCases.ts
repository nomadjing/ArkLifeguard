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

    static replace(_handle: Handle): Handle {
        return new Handle();
    }

    static identity(handle: Handle): Handle {
        return handle;
    }

    static overwriteByReturn(): void {
        let handle = Handle.open();
        handle = FlowCases.replace(handle);
        handle.release();
    }

    static preserveReturnedAlias(): void {
        let handle = Handle.open();
        handle = FlowCases.identity(handle);
        handle.release();
    }

    static preserveOtherAlias(): void {
        let handle = Handle.open();
        const alias = handle;
        handle = FlowCases.replace(handle);
        alias.release();
    }

    static choose(handle: Handle, keep: boolean): Handle {
        if (keep) return handle;
        return new Handle();
    }

    static conditionalReturnedAlias(keep: boolean): void {
        let handle = Handle.open();
        handle = FlowCases.choose(handle, keep);
        handle.release();
    }

    static reassignParameter(handle: Handle): void {
        handle = Handle.open();
    }

    static parameterAssignmentIsLocal(): void {
        const handle = Handle.open();
        FlowCases.reassignParameter(handle);
        handle.release();
    }

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

    static releaseOwner(owner: FlowCases): void {
        owner.releaseField();
    }

    static releaseThroughOwnerParameter(): void {
        const owner = new FlowCases();
        owner.store();
        FlowCases.releaseOwner(owner);
    }

    static releaseDifferentOwner(): void {
        const owner = new FlowCases();
        const other = new FlowCases();
        owner.store();
        FlowCases.releaseOwner(other);
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
