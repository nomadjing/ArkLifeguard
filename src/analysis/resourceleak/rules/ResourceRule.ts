/** Location of the acquired handle at an allocation call. */
export type ResourceHandleLocation =
    | { readonly kind: 'return' | 'base' | 'static' }
    | { readonly kind: 'param'; readonly index: number };

export interface ResourceApi {
    /** Fully resolved method identity, including its declaring module and class. */
    readonly methodSignature: string;
    readonly handleLocation: ResourceHandleLocation;
}

/** Rule contract for the new resource analysis; no rules are active in §3.1. */
export interface ResourceRule {
    readonly id: string;
    readonly scope: 'resource' | 'compatibility';
    readonly allocators: readonly ResourceApi[];
    readonly releasers: readonly ResourceApi[];
    /** Only rules that explicitly permit nullification may use it as release. */
    readonly releaseByNullify?: boolean;
}
