import { ModelUtils, type MethodSignature, type Scene } from '../../adapter/arkanalyzer';

export interface RegistrationRule {
    readonly id: string;
    readonly allocators: readonly string[];
    readonly releasers: readonly string[];
    readonly kind: 'timer' | 'event';
    readonly registrar: 'system' | 'receiver';
    readonly callbackIndex: number;
    readonly eventIndex?: number;
    readonly releaseEventIndex?: number;
    readonly releaseCallbackIndex?: number;
    readonly allowRemoveAll?: boolean;
    readonly selfExpiring?: boolean;
}
interface Definition extends Omit<RegistrationRule, 'allocators' | 'releasers'> {
    readonly file: string;
    readonly owner: string;
    readonly on: readonly string[];
    readonly off: readonly string[];
}
const definitions: readonly Definition[] = [
    { id: 'IntervalRegistration', file: 'global.d.ts', owner: '%dflt', on: ['setInterval'], off: ['clearInterval'],
        kind: 'timer', registrar: 'system', callbackIndex: 0 },
    { id: 'TimeoutRegistration', file: 'global.d.ts', owner: '%dflt', on: ['setTimeout'], off: ['clearTimeout'],
        kind: 'timer', registrar: 'system', callbackIndex: 0, selfExpiring: true },
    { id: 'EmitterRegistration', file: '@ohos.events.emitter.d.ts', owner: '%dflt', on: ['on'], off: ['off'],
        kind: 'event', registrar: 'system', callbackIndex: 1, eventIndex: 0, releaseEventIndex: 0,
        releaseCallbackIndex: 1, allowRemoveAll: true },
    { id: 'EmitterOnceRegistration', file: '@ohos.events.emitter.d.ts', owner: '%dflt', on: ['once'], off: ['off'],
        kind: 'event', registrar: 'system', callbackIndex: 1, eventIndex: 0, releaseEventIndex: 0,
        releaseCallbackIndex: 1, allowRemoveAll: true, selfExpiring: true },
    { id: 'EventHubRegistration', file: '@ohos.app.ability.EventHub.d.ts', owner: 'EventHub', on: ['on'], off: ['off'],
        kind: 'event', registrar: 'receiver', callbackIndex: 1, eventIndex: 0, releaseEventIndex: 0,
        releaseCallbackIndex: 1, allowRemoveAll: true },
    ...[
        ['WindowRegistration', '@ohos.window.d.ts', 'Window'],
        ['WindowStageRegistration', '@ohos.window.d.ts', 'WindowStage'],
        ['DisplayRegistration', '@ohos.display.d.ts', '%dflt'],
        ['DataObjectRegistration', '@ohos.data.distributedDataObject.d.ts', 'DataObject'],
    ].map(([id, file, owner]): Definition => ({ id, file, owner, on: ['on'], off: ['off'],
        kind: 'event', registrar: owner === '%dflt' ? 'system' : 'receiver', callbackIndex: 1,
        eventIndex: 0, releaseEventIndex: 0, releaseCallbackIndex: 1, allowRemoveAll: true })),
];

export function resolveRegistrationRules(scene: Scene): {
    rules: readonly RegistrationRule[]; unresolvedRuleIds: readonly string[];
} {
    const signatures = new Map<string, MethodSignature>();
    const sdk = new Set(scene.getSdkArkFiles().map(file => file.getFileSignature().toString()));
    for (const file of scene.getSdkArkFiles()) for (const cls of ModelUtils.getAllClassesInFile(file)) {
        for (const method of cls.getMethods()) for (const signature of [method.getSignature(), ...(method.getDeclareSignatures() ?? [])]) {
            signatures.set(signature.toString(), signature);
        }
    }
    for (const method of scene.getMethods()) for (const stmt of method.getCfg()?.getStmts() ?? []) {
        const signature = stmt.getInvokeExpr()?.getMethodSignature();
        if (signature && sdk.has(signature.getDeclaringClassSignature().getDeclaringFileSignature().toString())) {
            signatures.set(signature.toString(), signature);
        }
    }
    const rules: RegistrationRule[] = [];
    const unresolvedRuleIds: string[] = [];
    for (const definition of definitions) {
        const candidates = [...signatures.values()].filter(signature => {
            const cls = signature.getDeclaringClassSignature();
            const filename = cls.getDeclaringFileSignature().getFileName().replace(/\\/g, '/');
            return filename.split('/').at(-1) === definition.file && cls.getClassName() === definition.owner;
        });
        const on = candidates.filter(signature => definition.on.includes(signature.getMethodSubSignature().getMethodName()));
        const off = candidates.filter(signature => definition.off.includes(signature.getMethodSubSignature().getMethodName()));
        if (!on.length || !off.length) unresolvedRuleIds.push(definition.id);
        else { const { file: _file, owner: _owner, on: _on, off: _off, ...rule } = definition;
            rules.push({ ...rule, allocators: on.map(api => api.toString()), releasers: off.map(api => api.toString()) }); }
    }
    return { rules, unresolvedRuleIds };
}
