import {
    ArkArrayRef,
    ArkInstanceFieldRef,
    GlobalRef,
    Local,
    Stmt,
    Value,
} from '../../adapter/arkanalyzer';

export type ResourceState = 'allocated' | 'released' | 'escaped' | 'unknown';
export type ResourceEvent = 'overwritten' | 'wrong-release' | 'unknown-ownership';

/** Caller aliases are restored after a direct call, while callee locals stay local. */
export interface ResourceCallFrame {
    readonly callSite: Stmt;
    readonly callerHandles: readonly Value[];
}

/** Finite IFDS domain: identity excludes the evidence path and includes only one event site. */
export class ResourceFact {
    private static readonly zero = new ResourceFact('', undefined, [], 'allocated', [], undefined, undefined);

    private constructor(
        readonly ruleId: string,
        readonly allocationSite: Stmt | undefined,
        readonly handles: readonly Value[],
        readonly state: ResourceState,
        readonly frames: readonly ResourceCallFrame[],
        readonly event?: ResourceEvent,
        readonly eventSite?: Stmt,
    ) {}

    static zeroFact(): ResourceFact {
        return ResourceFact.zero;
    }

    static allocate(ruleId: string, site: Stmt, handle?: Value): ResourceFact {
        return new ResourceFact(ruleId, site, handle ? [handle] : [],
            handle ? 'allocated' : 'unknown', [],
            handle ? undefined : 'unknown-ownership', handle ? undefined : site);
    }

    isZero(): boolean {
        return this === ResourceFact.zero;
    }

    derive(change: {
        handles?: readonly Value[];
        state?: ResourceState;
        frames?: readonly ResourceCallFrame[];
        event?: ResourceEvent;
        eventSite?: Stmt;
    }): ResourceFact {
        return new ResourceFact(
            this.ruleId,
            this.allocationSite,
            change.handles ?? this.handles,
            change.state ?? this.state,
            change.frames ?? this.frames,
            change.event ?? this.event,
            change.eventSite ?? this.eventSite,
        );
    }
}

/** ArkAnalyzer may materialize equivalent field refs as distinct Value objects. */
export function resourceValueKey(value: Value): string {
    if (value instanceof Local) return `local:${value.getName()}`;
    if (value instanceof ArkInstanceFieldRef) {
        return `field:${resourceValueKey(value.getBase())}:${value.getFieldSignature().toString()}`;
    }
    if (value instanceof ArkArrayRef) {
        return `array:${resourceValueKey(value.getBase())}:${value.toString()}`;
    }
    if (value instanceof GlobalRef) return `global:${value.toString()}`;
    return `${value.constructor.name}:${value.toString()}`;
}

export function hasResourceHandle(handles: readonly Value[], value: Value): boolean {
    const key = resourceValueKey(value);
    return handles.some(handle => resourceValueKey(handle) === key);
}

export function uniqueResourceHandles(handles: readonly Value[]): Value[] {
    const byKey = new Map<string, Value>();
    for (const handle of handles) byKey.set(resourceValueKey(handle), handle);
    return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, handle]) => handle);
}
