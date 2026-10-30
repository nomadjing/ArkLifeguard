import { ArkStaticInvokeExpr, ClassType, FunctionType, type Scene } from '../../../adapter/arkanalyzer';
import type { SynchronousCallbackModel } from '../../../ifds/CallResolver';

const NONE: ReadonlySet<number> = new Set();
const COMPONENT_CONTENT: ReadonlySet<number> = new Set([1]);

/** Verified compiler/framework contracts, independent of application class and method names. */
export function createSynchronousCallbackModel(scene: Scene): SynchronousCallbackModel {
    return call => {
        const invoke = call.getInvokeExpr();
        if (!(invoke instanceof ArkStaticInvokeExpr) ||
            invoke.getMethodSignature().toString() !== '@%unk/%unk: View.create()') return NONE;
        const type = invoke.getArgs()[0]?.getType();
        if (!(type instanceof ClassType)) return NONE;
        const component = scene.getClass(type.getClassSignature());
        // ArkIR custom-component content slot: require the actual component declaration and function type.
        return component?.hasDecorator('Component') && invoke.getArgs()[1]?.getType() instanceof FunctionType
            ? COMPONENT_CONTENT : NONE;
    };
}
