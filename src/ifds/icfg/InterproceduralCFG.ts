import type { ArkMethod, Scene, Stmt } from '../../adapter/arkanalyzer';
import { CallGraphManager } from './CallGraphManager';
import { CfgIndex } from './CfgIndex';
import type { SynchronousCallbackModel } from '../CallResolver';

/** Default ICFG backed by ArkAnalyzer CFGs and a CHA call graph. */
export class InterproceduralCFG {
    private readonly cfgIndex: CfgIndex;
    private readonly callGraphManager: CallGraphManager;
    private cfgInitialized = false;

    /** Reuse requires a fixed Scene containing all roots before the first initialization. */
    constructor(scene: Scene, private readonly reuseCfgIndex = false, synchronousOnly = false,
        synchronousCallbackModel?: SynchronousCallbackModel) {
        this.cfgIndex = new CfgIndex(scene);
        this.callGraphManager = new CallGraphManager(scene, synchronousOnly, synchronousCallbackModel);
    }

    initialize(entryMethod: ArkMethod): void {
        this.callGraphManager.initialize(entryMethod);
        if (!this.reuseCfgIndex || !this.cfgInitialized) {
            this.cfgIndex.initialize(entryMethod);
            this.cfgInitialized = true;
        }
    }

    getNormalSuccessors(stmt: Stmt): readonly Stmt[] {
        return this.cfgIndex.getNormalSuccessors(stmt);
    }

    getExceptionalSuccessors(stmt: Stmt): readonly Stmt[] {
        return this.cfgIndex.getExceptionalSuccessors(stmt);
    }

    getHandlerContinuation(handler: Stmt): Stmt {
        return this.cfgIndex.getHandlerContinuation(handler);
    }

    mayThrow(stmt: Stmt): boolean {
        return this.cfgIndex.mayThrow(stmt);
    }

    isCallStatement(stmt: Stmt): boolean {
        return this.callGraphManager.isCallStatement(stmt);
    }

    isExitStatement(stmt: Stmt): boolean {
        return this.cfgIndex.isExitStatement(stmt);
    }

    getCalleesOfCallAt(call: Stmt): Set<ArkMethod> {
        return this.callGraphManager.getCalleesOfCallAt(call);
    }

    getReturnSiteOfCallAt(call: Stmt): Stmt | null {
        return this.cfgIndex.getReturnSiteOfCall(call);
    }

    getExceptionalReturnSitesOfCallAt(call: Stmt): readonly Stmt[] {
        return this.cfgIndex.getExceptionalReturnSitesOfCall(call);
    }

    getStartPointOf(method: ArkMethod): Stmt | null {
        return this.cfgIndex.getStartPointOf(method);
    }

    getStartPointOfCaller(call: Stmt): Stmt | null {
        return this.cfgIndex.getStartPointOfCaller(call);
    }
}
