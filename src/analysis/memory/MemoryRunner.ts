import type { ArkMethod, Scene } from '../../adapter/arkanalyzer';
import { HeapFlow, type HeapFlowOptions } from '../shared/HeapFlow';
import { retentionLocation, type RetentionLocation } from '../shared/AnalysisLocation';
import { RegistrationState } from '../closure/RegistrationState';
import { RegistrationModel } from '../closure/RegistrationModel';
import { resolveRegistrationRules, type RegistrationRule } from '../closure/RegistrationRules';
import type { RetentionEvidenceEdge } from '../closure/ClosureResult';
import { UNSUPPORTED_REGISTRATION_API_FAMILIES } from '../closure/RegistrationCapabilities';

export interface MemoryRetentionCandidate {
    readonly objectId: string; readonly objectType: string;
    readonly allocation: RetentionLocation;
    readonly root: string;
    readonly retentionPath: readonly RetentionEvidenceEdge[];
    readonly lifecycleEnd: RetentionLocation;
    readonly reason: 'retained-after-lifecycle';
    readonly confidence: 'high' | 'low';
}
export interface MemoryAnalysisResult {
    readonly enabled: boolean; readonly success: boolean;
    readonly memoryRetentionCandidates: readonly MemoryRetentionCandidate[];
    readonly registrationRetentions: readonly MemoryRetentionCandidate[];
    readonly limitations: readonly string[];
    readonly unresolvedRegistrationRuleIds?: readonly string[];
    readonly unsupportedRegistrationApiFamilies?: readonly string[];
    readonly statistics?: import('../shared/HeapFlow').HeapFlowRun;
    readonly error?: string;
}

/** Strong-root reachability after a declared owner lifetime ends.
 * This is managed-memory retention, never allocation volume or release()/terminate() matching.
 */
export class MemoryRunner {
    constructor(private readonly scene: Scene, private readonly options: HeapFlowOptions = {},
        private readonly registrationRules?: readonly RegistrationRule[]) {}
    runWithDummyMain(entry: ArkMethod): MemoryAnalysisResult {
        const base = { enabled: true, memoryRetentionCandidates: [], registrationRetentions: [], limitations: [],
            unsupportedRegistrationApiFamilies: UNSUPPORTED_REGISTRATION_API_FAMILIES };
        try {
            const resolution = this.registrationRules === undefined ? resolveRegistrationRules(this.scene)
                : { rules: this.registrationRules, unresolvedRuleIds: [] };
            const registration = new RegistrationModel(resolution.rules);
            const candidates = new Map<string, MemoryRetentionCandidate>();
            const overlaps = new Map<string, MemoryRetentionCandidate>();
            const flow = new HeapFlow<RegistrationState>(this.scene, {
                invoke: (stmt, state, ctx, engine) => registration.invoke(stmt, state, ctx, engine),
                boundary: (exit, state) => {
                    for (const object of state.objects.values()) {
                        const owner = state.endedOwners.has(object.id) ? object.id : object.lifetimeOwner;
                        if (!owner || !state.endedOwners.has(owner) || object.kind !== 'object') continue;
                        // Native handles belong to resource checking. Allocation alone is not a memory diagnostic.
                        if (object.classSignature?.includes('@ohos.') &&
                            /^(?:PixelMap|AVPlayer|AVRecorder|VideoPlayer|AudioPlayer|Worker|ThreadWorker|ImageSource|ImagePacker|File|AudioRenderer|AudioCapturer|TonePlayer|HttpRequest|TCPSocket|UDPSocket|WebSocket|RdbStore|ResultSet|CaptureSession|CameraInput)$/.test(object.label)) continue;
                        const ownPath = state.pathTo(object.id, root => !root.startsWith('registration-root:'));
                        const path = ownPath ?? state.pathTo(object.id);
                        if (!path) continue;
                        const registrationPath = path.root.startsWith('registration-root:') || path.edges.some(edge => edge.via.includes(':listener:'));
                        const uncertainRegistration = [...state.registrations.values()].some(item => item.active &&
                            (item.repeated || item.rule.selfExpiring) && path.edges.some(edge => item.callbacks.includes(edge.to)));
                        const candidate: MemoryRetentionCandidate = { objectId: object.id, objectType: object.label,
                            allocation: retentionLocation(object.allocation), root: path.root,
                            retentionPath: path.edges.map(edge => ({ ...edge,
                                location: edge.location ? retentionLocation(edge.location) : undefined })),
                            lifecycleEnd: retentionLocation(state.endedOwners.get(owner) ?? exit),
                            reason: 'retained-after-lifecycle', confidence: state.uncertainties.size || owner !== object.id || uncertainRegistration ? 'low' : 'high' };
                        // Registration-held paths are related evidence; closure is the primary diagnostic.
                        (registrationPath ? overlaps : candidates).set(`${object.id}:${owner}:${path.root}`, candidate);
                    }
                },
            }, this.options);
            const statistics = flow.run(entry, new RegistrationState());
            const bounded = (items: Iterable<MemoryRetentionCandidate>) => [...items].map(item =>
                statistics.success ? item : { ...item, confidence: 'low' as const });
            return { ...base, success: statistics.success, memoryRetentionCandidates: bounded(candidates.values()),
                registrationRetentions: bounded(overlaps.values()), statistics, limitations: statistics.limitations,
                unresolvedRegistrationRuleIds: resolution.unresolvedRuleIds,
                ...(!statistics.success ? { error: 'Memory analysis budget exceeded; results are incomplete' } : {}) };
        } catch (error) { return { ...base, success: false, error: error instanceof Error ? error.message : String(error) }; }
    }
}
