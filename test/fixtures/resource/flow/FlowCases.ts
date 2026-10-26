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
    private otherField?: Handle;

    static finallyReturn(): number {
        const handle = Handle.open();
        try { return 1; } finally { handle.release(); }
    }

    static finallyCallChain(): void {
        try { FlowCases.finallyReturn(); } catch (error) { const caught = 1; }
    }

    static ordinaryCallBeforeRelease(): void {
        const handle = Handle.open();
        try { FlowCases.normalOperation(); } catch (error) { return; }
        handle.release();
    }

    static normalOperation(): void { const value = 1; }

    static finallyThrow(): void {
        const handle = Handle.open();
        try { throw new Error('failure'); } finally { handle.release(); }
    }

    static finallyCatchReturn(flag: boolean): number {
        const handle = Handle.open();
        try {
            if (flag) return 1;
            throw new Error('failure');
        } catch (error) {
            return 2;
        } finally { handle.release(); }
    }

    static finallyNested(): number {
        const handle = Handle.open();
        try {
            try { return 1; } finally { const marker = 1; }
        } finally { handle.release(); }
    }

    static finallyNestedThrow(): void {
        const handle = Handle.open();
        try {
            try { throw new Error('failure'); } finally { const marker = 1; }
        } finally { handle.release(); }
    }

    static finallyFactory(): Handle {
        const handle = Handle.open();
        try { return handle; } finally { const marker = 1; }
    }

    static finallyFactoryCaller(): void {
        const handle = FlowCases.finallyFactory();
        handle.release();
    }

    static finallyOverride(): Handle {
        const handle = Handle.open();
        try { return handle; } finally { return new Handle(); }
    }

    static finallyThrowOverridesReturn(): Handle {
        const handle = Handle.open();
        try { return handle; } finally { throw new Error('overridden return'); }
    }

    static finallyThrowOverridesReturnCaller(): void {
        const handle = FlowCases.finallyThrowOverridesReturn();
        handle.release();
    }

    static finallySnapshot(): Handle {
        let handle = Handle.open();
        try { return handle; } finally { handle = new Handle(); }
    }

    static finallySnapshotCaller(): void {
        const handle = FlowCases.finallySnapshot();
        handle.release();
    }

    static finallyOverridesThrow(): Handle {
        const handle = Handle.open();
        try { throw new Error('overridden'); } finally { return handle; }
    }

    static finallyOverridesThrowCaller(): void {
        const handle = FlowCases.finallyOverridesThrow();
        handle.release();
    }

    static finallyBranchFactory(flag: boolean): Handle {
        try {
            if (flag) return Handle.open();
            return Handle.open();
        } finally { const marker = 1; }
    }

    static finallyBranchCaller(flag: boolean): void {
        const handle = FlowCases.finallyBranchFactory(flag);
        handle.release();
    }

    static finallyMissingCleanup(): number {
        const handle = Handle.open();
        try { return 1; } finally { const marker = 1; }
    }

    static finallyConditional(flag: boolean): number {
        const handle = Handle.open();
        try { return 1; } finally { if (flag) handle.release(); }
    }

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

    replaceFieldWithoutRelease(): void {
        this.field = new Handle();
    }

    static overwriteFieldInCallee(): void {
        const owner = new FlowCases();
        owner.store();
        owner.replaceFieldWithoutRelease();
        owner.releaseField();
    }

    static preserveCallerAliasAfterFieldOverwrite(): void {
        const owner = new FlowCases();
        owner.store();
        const alias = owner.field;
        owner.replaceFieldWithoutRelease();
        alias?.release();
    }

    static repeatStoreThenRelease(): void {
        const owner = new FlowCases();
        for (let round = 0; round < 2; round++) owner.store();
        owner.releaseField();
    }

    static repeatStoreWithRelease(): void {
        const owner = new FlowCases();
        for (let round = 0; round < 2; round++) {
            owner.store();
            owner.releaseField();
        }
    }

    static repeatReplaceAfterRelease(): void {
        const owner = new FlowCases();
        for (let round = 0; round < 2; round++) {
            owner.releaseField();
            owner.store();
        }
        owner.releaseField();
    }

    static repeatLocalThenRelease(): void {
        let handle: Handle | undefined;
        for (let round = 0; round < 2; round++) handle = Handle.open();
        handle?.release();
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

    storeFactoryPair(): void {
        this.field = FlowCases.factory();
        this.otherField = FlowCases.factory();
    }

    storeFactoryPairThroughWrapper(): void {
        this.storeFactoryPair();
    }

    static wrappedFactory(): Handle {
        return FlowCases.factory();
    }

    storeWrappedFactoryPair(): void {
        this.field = FlowCases.wrappedFactory();
        this.otherField = FlowCases.wrappedFactory();
    }

    static releaseOneMiddleContextFactoryField(): void {
        const owner = new FlowCases();
        owner.storeWrappedFactoryPair();
        owner.releaseField();
    }

    static releaseBothMiddleContextFactoryFields(): void {
        const owner = new FlowCases();
        owner.storeWrappedFactoryPair();
        owner.releaseField();
        owner.releaseOtherField();
    }

    storeFactoryField(): void {
        this.field = FlowCases.factory();
    }

    releaseOtherField(): void {
        this.otherField?.release();
    }

    static releaseOneNestedFactoryField(): void {
        const owner = new FlowCases();
        owner.storeFactoryPair();
        owner.releaseField();
    }

    static releaseOneWrappedFactoryField(): void {
        const owner = new FlowCases();
        owner.storeFactoryPairThroughWrapper();
        owner.releaseField();
    }

    static releaseBothNestedFactoryFields(): void {
        const owner = new FlowCases();
        owner.storeFactoryPair();
        owner.releaseField();
        owner.releaseOtherField();
    }

    static releaseBothWrappedFactoryFields(): void {
        const owner = new FlowCases();
        owner.storeFactoryPairThroughWrapper();
        owner.releaseField();
        owner.releaseOtherField();
    }

    static releaseOneFactoryOwner(): void {
        const first = new FlowCases();
        const second = new FlowCases();
        first.storeFactoryField();
        second.storeFactoryField();
        second.releaseField();
    }

    static releaseBothFactoryOwners(): void {
        const first = new FlowCases();
        const second = new FlowCases();
        first.storeFactoryField();
        second.storeFactoryField();
        first.releaseField();
        second.releaseField();
    }

    static releaseFactoryResult(): void {
        const handle = FlowCases.factory();
        handle.release();
    }

    static leakFactoryResult(): void {
        const handle = FlowCases.factory();
    }

    static mixedFactoryConsumers(): void {
        FlowCases.releaseFactoryResult();
        FlowCases.leakFactoryResult();
    }

    static releaseOneFactoryResult(): void {
        const first = FlowCases.factory();
        const second = FlowCases.factory();
        first.release();
    }

    static releaseBothFactoryResults(): void {
        const first = FlowCases.factory();
        const second = FlowCases.factory();
        FlowCases.closeHandle(first);
        second.release();
    }

    static releaseFactoryResultInCallback(): void {
        const handle: Handle = FlowCases.factory();
        Promise.resolve().then(() => handle.release());
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
        const handle: Handle = Handle.open();
        schedule(() => handle.release());
    }

    static promiseCallbackRelease(): void {
        const handle: Handle = Handle.open();
        Promise.resolve().then(() => handle.release());
    }

    static releaseThenCallback(): void {
        const handle = Handle.open();
        handle.release();
        schedule(() => {});
    }
}
