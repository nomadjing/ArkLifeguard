/** Location of the acquired handle at an allocation call. */
export type ResourceHandleLocation =
    | { readonly kind: 'return' | 'base' | 'static' }
    | { readonly kind: 'param'; readonly index: number };

export interface ResourceApi {
    /** Fully resolved method identity, including its declaring module and class. */
    readonly methodSignature: string;
    readonly handleLocation: ResourceHandleLocation;
    /** Promise handles become resources after await or a fulfillment callback; API callbacks stay uncertain. */
    readonly acquisition?: 'promise' | 'callback';
}

/** Exact SDK API identities and the ownership contract for one resource family. */
export interface ResourceRule {
    readonly id: string;
    readonly scope: 'resource' | 'listener' | 'compatibility';
    readonly allocators: readonly ResourceApi[];
    /** A reachable matching call on the correct handle discharges the allocation's obligation, even on failure.
     * This models the application's cleanup duty, not guaranteed physical deallocation. */
    readonly releasers: readonly ResourceApi[];
    /** Only rules that explicitly permit nullification may use it as release. */
    readonly releaseByNullify?: boolean;
    /** Explicit handle projections, e.g. fs.File.fd. Never applies to arbitrary fields. */
    readonly handleProperties?: readonly string[];
    /** Successful acquisition yields a non-null handle; numeric file handles are also >= 0. */
    readonly handleValidity?: 'non-null' | 'non-negative';
}
