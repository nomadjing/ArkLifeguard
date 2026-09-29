import type { Stmt, Value } from '../../adapter/arkanalyzer';

/** State carried by the new resource analysis once its flow functions are implemented. */
export type ResourceState = 'allocated' | 'released' | 'escaped' | 'unknown';

/** An allocation and its current handle remain distinct from legacy taint facts. */
export interface ResourceFact {
    readonly ruleId: string;
    readonly allocationSite: Stmt;
    readonly handle: Value;
    readonly state: ResourceState;
}
