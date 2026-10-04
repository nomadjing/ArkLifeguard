/** Location of the acquired handle at an allocation call. */
export type ResourceHandleLocation =
    | { readonly kind: 'return' | 'base' | 'static' }
    | { readonly kind: 'param'; readonly index: number };

export interface ResourceApi {
    /** Fully resolved method identity, including its declaring module and class. */
    readonly methodSignature: string;
    readonly handleLocation: ResourceHandleLocation;
    /** Promise handles become owned resources after await; callback results stay uncertain. */
    readonly acquisition?: 'promise' | 'callback';
}

/** Exact SDK API identities and the ownership contract for one resource family. */
export interface ResourceRule {
    readonly id: string;
    readonly scope: 'resource' | 'compatibility';
    readonly allocators: readonly ResourceApi[];
    readonly releasers: readonly ResourceApi[];
    /** Only rules that explicitly permit nullification may use it as release. */
    readonly releaseByNullify?: boolean;
    /** Explicit handle projections, e.g. fs.File.fd. Never applies to arbitrary fields. */
    readonly handleProperties?: readonly string[];
}
