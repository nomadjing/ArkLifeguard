import {
    ArkArrayRef,
    ArkInstanceFieldRef,
    ClosureFieldRef,
    GlobalRef,
    Local,
    Stmt,
    Value,
} from '../../adapter/arkanalyzer';

export type ResourceState = 'allocated' | 'pending' | 'released' | 'escaped' | 'unknown';
export type ResourceEvent = 'overwritten' | 'wrong-release' | 'unknown-ownership';

/** Caller aliases are restored after a direct call, while callee locals stay local. */
export interface ResourceCallFrame {
    readonly callSite: Stmt;
    readonly callerHandles: readonly Value[];
}

export interface RegistrationIdentity {
    readonly registrar?: string;
    readonly event?: string;
    readonly callback?: string;
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
        /** Bounded inner-to-outer acquisition returns; stable through cleanup calls. */
        readonly acquisitionContext: readonly Stmt[] = [],
        readonly registration?: RegistrationIdentity,
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

    hasLostHandles(): boolean {
        return this.event === 'overwritten' && this.handles.length === 0 &&
            (this.state === 'allocated' || this.state === 'unknown');
    }

    atAcquisitionReturn(callSite: Stmt): ResourceFact {
        return this.derive({
            // Keep a finite call context, including distinctions in middle wrappers.
            acquisitionContext: [...this.acquisitionContext, callSite].slice(-4),
        });
    }

    derive(change: {
        handles?: readonly Value[];
        state?: ResourceState;
        frames?: readonly ResourceCallFrame[];
        event?: ResourceEvent;
        eventSite?: Stmt;
        acquisitionContext?: readonly Stmt[];
        registration?: RegistrationIdentity;
    }): ResourceFact {
        return new ResourceFact(
            this.ruleId,
            this.allocationSite,
            change.handles ?? this.handles,
            change.state ?? this.state,
            change.frames ?? this.frames,
            change.event ?? this.event,
            change.eventSite ?? this.eventSite,
            change.acquisitionContext ?? this.acquisitionContext,
            change.registration ?? this.registration,
        );
    }
}

/** ArkAnalyzer may materialize equivalent field refs as distinct Value objects. */
export function resourceValueKey(value: Value): string {
    if (value instanceof Local) {
        const method = value.getDeclaringStmt()?.getCfg()?.getDeclaringMethod();
        const scope = method?.getSignature().toString() ?? value.getSignature()?.toString() ?? '';
        return `local:${scope}:${value.getName()}`;
    }
    if (value instanceof ArkInstanceFieldRef) {
        return `field:${resourceValueKey(value.getBase())}:${value.getFieldSignature().toString()}`;
    }
    if (value instanceof ClosureFieldRef) {
        return `capture:${resourceValueKey(value.getBase())}:${value.getFieldName()}`;
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
