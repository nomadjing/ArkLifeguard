import type { HeapFlowRun } from '../shared/HeapFlow';
import type { RetentionLocation } from '../shared/AnalysisLocation';
export interface RetentionEvidenceEdge {
    readonly from: string; readonly via: string; readonly to: string; readonly location?: RetentionLocation;
}
export interface RegistrationDiagnostic {
    readonly registrationId: string;
    readonly ruleId: string;
    readonly registration: RetentionLocation;
    readonly boundary: RetentionLocation;
    readonly registrars: readonly string[];
    readonly events: readonly string[];
    readonly callbacks: readonly string[];
    readonly timerId?: string;
    readonly reason: 'unregistered' | 'partially-unregistered' | 'unknown-registration';
    readonly confidence: 'high' | 'low';
}
export interface ClosureRetentionDiagnostic extends RegistrationDiagnostic {
    readonly capturedObject: string;
    readonly root: string;
    readonly retentionPath: readonly RetentionEvidenceEdge[];
    readonly lifecycleEnd: RetentionLocation;
}
export interface ClosureAnalysisResult {
    readonly enabled: boolean; readonly success: boolean;
    readonly registrationLeaks: readonly RegistrationDiagnostic[];
    readonly closureRetentionLeaks: readonly ClosureRetentionDiagnostic[];
    readonly unresolvedRuleIds: readonly string[];
    readonly unsupportedLegacyRuleIds?: readonly string[];
    readonly limitations: readonly string[];
    readonly statistics?: HeapFlowRun;
    readonly error?: string;
}
