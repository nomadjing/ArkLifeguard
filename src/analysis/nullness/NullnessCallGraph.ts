import { ArkInstanceInvokeExpr, type Scene } from '../../adapter/arkanalyzer';
import { ArkInterproceduralCFG } from '../../ifds';
import { createArkUiSynchronousCallbackModel } from '../callgraph/ArkUiSynchronousCallbacks';

const NONE: ReadonlySet<number> = new Set();
const ARRAY_FOR_EACH_CALLBACK: ReadonlySet<number> = new Set([0]);

/** Nullness analyzes verified synchronous execution and isolated async activations. */
export function createNullnessInterproceduralCFG(
    scene: Scene,
    reuseCfgIndex = false
): ArkInterproceduralCFG {
    const arkUiCallbacks = createArkUiSynchronousCallbackModel(scene);
    return new ArkInterproceduralCFG(
        scene,
        reuseCfgIndex,
        true,
        call => {
            const arkUi = arkUiCallbacks(call);
            if (arkUi.size > 0) return arkUi;
            const invoke = call.getInvokeExpr();
            if (!(invoke instanceof ArkInstanceInvokeExpr)) return NONE;
            const signature = invoke.getMethodSignature();
            const owner = signature.getDeclaringClassSignature();
            return owner.getClassName() === 'Array' &&
                owner.getDeclaringFileSignature().getProjectName() === 'built-in' &&
                signature.getMethodSubSignature().getMethodName() === 'forEach'
                ? ARRAY_FOR_EACH_CALLBACK
                : NONE;
        }
    );
}
