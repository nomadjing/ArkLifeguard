import type { Scene } from '../../adapter/arkanalyzer';
import { ArkInterproceduralCFG } from '../../ifds';
import { createArkUiSynchronousCallbackModel } from '../callgraph/ArkUiSynchronousCallbacks';

/** Nullness analyzes only the project's verified synchronous execution core. */
export function createNullnessInterproceduralCFG(
    scene: Scene,
    reuseCfgIndex = false
): ArkInterproceduralCFG {
    return new ArkInterproceduralCFG(
        scene,
        reuseCfgIndex,
        true,
        createArkUiSynchronousCallbackModel(scene)
    );
}
