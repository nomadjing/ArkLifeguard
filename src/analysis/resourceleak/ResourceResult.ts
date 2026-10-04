export type ResourceEngineStatus = 'not-implemented' | 'success' | 'failed';

export interface ResourceLocation {
    readonly filePath: string;
    readonly line: number;
    readonly col: number;
}

export type ResourceLeakReason =
    | 'unreleased'
    | 'partially-released'
    | 'overwritten'
    | 'wrong-release'
    | 'unknown-ownership';

export interface ResourceDiagnostic {
    readonly ruleId: string;
    readonly allocation: ResourceLocation;
    readonly boundary: ResourceLocation;
    readonly reason: ResourceLeakReason;
    readonly confidence: 'high' | 'low';
    readonly evidence: readonly ResourceLocation[];
}

/** New-engine result. A missing implementation must never be reported as zero leaks. */
export interface ResourceAnalysisResult {
    readonly status: ResourceEngineStatus;
    readonly success: boolean;
    readonly entryMethod: string;
    readonly ruleIds?: readonly string[];
    readonly diagnostics: readonly ResourceDiagnostic[];
    readonly reachedStatements?: number;
    readonly reachedFacts?: number;
    readonly error?: string;
    readonly unresolvedRuleIds?: readonly string[];
    readonly solverStatistics?: Readonly<import('../../ifds').IFDSSolverStatistics>;
    readonly coverage?: readonly ResourceRuleCoverage[];
}

export interface ResourceRuleCoverage {
    readonly ruleId: string;
    readonly allocatorCalls: number;
    readonly reachedAllocatorCalls: number;
    readonly releaserCalls: number;
    readonly reachedReleaserCalls: number;
    readonly allocations: readonly (ResourceLocation & { readonly reached: boolean })[];
}
