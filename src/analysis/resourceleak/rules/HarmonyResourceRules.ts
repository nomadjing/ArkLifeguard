import { ModelUtils, type MethodSignature, type Scene } from '../../../adapter/arkanalyzer';
import type { ResourceApi, ResourceHandleLocation, ResourceRule } from './ResourceRule';

interface Selector {
    readonly module: string;
    readonly owner: string;
    readonly methods: readonly string[];
    readonly handle: ResourceHandleLocation;
}
interface Definition {
    readonly id: string;
    readonly allocators: readonly Selector[];
    readonly releasers: readonly Selector[];
    readonly handleProperties?: readonly string[];
    readonly handleValidity?: ResourceRule['handleValidity'];
}
const returns: ResourceHandleLocation = { kind: 'return' };
const base: ResourceHandleLocation = { kind: 'base' };
const param: ResourceHandleLocation = { kind: 'param', index: 0 };
const api = (module: string, owner: string, methods: string[], handle: ResourceHandleLocation = base): Selector =>
    ({ module, owner, methods, handle });

/** Resource-only rules; listener pairing and nullification compatibility rules are separate work. */
export const HARMONY_RESOURCE_DEFINITIONS: readonly Definition[] = [
    { id: 'HttpRequestNotDestroyed',
        allocators: [api('@ohos.net.http', '%dflt', ['createHttp'], returns)],
        releasers: [api('@ohos.net.http', 'HttpRequest', ['destroy'])] },
    { id: 'FileNotClosed', handleProperties: ['fd'], handleValidity: 'non-negative',
        allocators: [api('@ohos.file.fs', '%dflt', ['openSync', 'open'], returns)],
        releasers: [api('@ohos.file.fs', '%dflt', ['closeSync', 'close'], param)] },
    { id: 'FileIONotClosed', handleValidity: 'non-negative',
        allocators: [api('@ohos.fileio', '%dflt', ['openSync', 'open'], returns)],
        releasers: [api('@ohos.fileio', '%dflt', ['closeSync', 'close'], param)] },
    { id: 'ImageSourceNotReleased',
        allocators: [api('@ohos.multimedia.image', '%dflt', ['createImageSource'], returns)],
        releasers: [api('@ohos.multimedia.image', 'ImageSource', ['release'])] },
    { id: 'PixelMapNotReleased',
        allocators: [api('@ohos.multimedia.image', '%dflt', ['createPixelMap', 'createPixelMapSync'], returns),
            api('@ohos.multimedia.image', 'ImageSource', ['createPixelMap', 'createPixelMapSync'], returns)],
        releasers: [api('@ohos.multimedia.image', 'PixelMap', ['release'])] },
    { id: 'ImagePackerNotReleased',
        allocators: [api('@ohos.multimedia.image', '%dflt', ['createImagePacker'], returns)],
        releasers: [api('@ohos.multimedia.image', 'ImagePacker', ['release'])] },
    { id: 'AVPlayerNotReleased',
        allocators: [api('@ohos.multimedia.media', '%dflt', ['createAVPlayer'], returns)],
        releasers: [api('@ohos.multimedia.media', 'AVPlayer', ['release'])] },
    { id: 'AudioRendererNotReleased',
        allocators: [api('@ohos.multimedia.audio', '%dflt', ['createAudioRenderer'], returns)],
        releasers: [api('@ohos.multimedia.audio', 'AudioRenderer', ['release'])] },
    { id: 'AudioCapturerNotReleased',
        allocators: [api('@ohos.multimedia.audio', '%dflt', ['createAudioCapturer'], returns)],
        releasers: [api('@ohos.multimedia.audio', 'AudioCapturer', ['release'])] },
    { id: 'ResultSetNotClosed',
        allocators: [api('@ohos.data.relationalStore', 'RdbStore', ['query', 'querySync', 'querySql', 'querySqlSync'], returns)],
        releasers: [api('@ohos.data.relationalStore', 'ResultSet', ['close'])] },
];

export interface HarmonyResourceRuleResolution {
    readonly rules: readonly ResourceRule[];
    readonly unresolvedRuleIds: readonly string[];
}

/** Bind selectors to exact SDK signatures, including overloads and inferred callsite signatures.
 * A project's own same-named methods can never qualify as platform APIs.
 */
export function resolveHarmonyResourceRules(scene: Scene): HarmonyResourceRuleResolution {
    const sdkFiles = new Set(scene.getSdkArkFiles().map(file => file.getFileSignature().toString()));
    const signatures = new Map<string, MethodSignature>();
    for (const file of scene.getSdkArkFiles()) {
        for (const owner of ModelUtils.getAllClassesInFile(file)) {
            for (const method of owner.getMethods()) {
                for (const signature of [method.getSignature(), ...(method.getDeclareSignatures() ?? [])]) {
                    signatures.set(signature.toString(), signature);
                }
            }
        }
    }
    for (const method of scene.getMethods()) {
        for (const stmt of method.getCfg()?.getStmts() ?? []) {
            const signature = stmt.getInvokeExpr()?.getMethodSignature();
            if (signature && sdkFiles.has(signature.getDeclaringClassSignature()
                .getDeclaringFileSignature().toString())) signatures.set(signature.toString(), signature);
        }
    }
    const resolve = (selectors: readonly Selector[], allocator: boolean): ResourceApi[] => {
        const result = new Map<string, ResourceApi>();
        for (const signature of signatures.values()) {
            const owner = signature.getDeclaringClassSignature();
            const filename = owner.getDeclaringFileSignature().getFileName().replace(/\\/g, '/').split('/').at(-1);
            for (const selector of selectors) {
                if (filename !== `${selector.module}.d.ts` || owner.getClassName() !== selector.owner ||
                    !selector.methods.includes(signature.getMethodSubSignature().getMethodName())) continue;
                const returnType = signature.getMethodSubSignature().getReturnType().toString();
                const acquisition = allocator && returnType.includes('Promise') ? 'promise'
                    : allocator && returnType === 'void' ? 'callback' : undefined;
                result.set(signature.toString(), {
                    methodSignature: signature.toString(), handleLocation: selector.handle,
                    ...(acquisition ? { acquisition } : {}),
                });
            }
        }
        return [...result.values()];
    };
    const rules: ResourceRule[] = [];
    const unresolvedRuleIds: string[] = [];
    for (const definition of HARMONY_RESOURCE_DEFINITIONS) {
        const allocators = resolve(definition.allocators, true);
        const releasers = resolve(definition.releasers, false);
        if (!allocators.length || !releasers.length) {
            unresolvedRuleIds.push(definition.id);
        } else {
            rules.push({ id: definition.id, scope: 'resource', allocators, releasers,
                handleProperties: definition.handleProperties,
                handleValidity: definition.handleValidity ?? 'non-null' });
        }
    }
    return { rules, unresolvedRuleIds };
}
