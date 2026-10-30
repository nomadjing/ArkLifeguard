import {
    ArkInstanceInvokeExpr,
    ArkInvokeStmt,
    ArkMethod,
    ArkStaticInvokeExpr,
    CallGraph,
    CallGraphBuilder,
    ClassHierarchyAnalysis,
    Scene,
    Stmt,
    ModifierType,
} from '../../adapter/arkanalyzer';
import { CallResolver, resolveProjectMethods, type SynchronousCallbackModel } from '../CallResolver';

/** Owns CHA dispatch and per-analysis, per-call-site callee resolution caches. */
export class CallGraphManager {
    private resolver?: CallResolver;
    private synchronousCallees = new WeakMap<Stmt, Set<ArkMethod>>();

    constructor(private readonly scene: Scene, private readonly synchronousOnly = false,
        private readonly synchronousCallbackModel?: SynchronousCallbackModel) {}

    initialize(entryMethod: ArkMethod): void {
        this.synchronousCallees = new WeakMap();
        const graph = new CallGraph(this.scene);
        const analysis = new ClassHierarchyAnalysis(this.scene, graph, new CallGraphBuilder(graph, this.scene));
        this.resolver = new CallResolver(this.scene, call => {
            const invoke = call.getInvokeExpr();
            const methods = resolveProjectMethods(this.scene, call);
            if (!invoke) return methods;
            const file = invoke.getMethodSignature().getDeclaringClassSignature().getDeclaringFileSignature();
            if (!this.scene.getFile(file) || this.scene.hasSdkFile(file)) return methods;

            // CHA adds every function argument to resolveCall's result. Query
            // expression dispatch with a separate argument-free expression:
            // retain real virtual targets even when also passed as callbacks,
            // without mutating the application's call or its closure arguments.
            const expression = invoke instanceof ArkInstanceInvokeExpr
                ? new ArkInstanceInvokeExpr(invoke.getBase(), invoke.getMethodSignature(), [])
                : invoke instanceof ArkStaticInvokeExpr
                    ? new ArkStaticInvokeExpr(invoke.getMethodSignature(), [])
                    : undefined;
            if (!expression) return methods;
            const expressionCall = new ArkInvokeStmt(expression);
            const caller = call.getCfg()?.getDeclaringMethod() ?? entryMethod;
            expressionCall.setCfg(caller.getCfg()!);
            const callerNode = graph.getCallGraphNodeByMethod(caller.getSignature());
            for (const site of analysis.resolveCall(callerNode.getID(), expressionCall)) {
                const signature = graph.getMethodByFuncID(site.calleeFuncID);
                const method = signature ? this.scene.getMethod(signature) : null;
                if (method?.getCfg()) methods.add(method);
            }
            return methods;
        }, this.synchronousOnly, this.synchronousCallbackModel);
    }

    getAllCalleeMethods(call: Stmt): Set<ArkMethod> {
        return this.getCalleesOfCallAt(call);
    }

    getCalleesOfCallAt(call: Stmt): Set<ArkMethod> {
        if (!this.resolver) throw new Error('CallGraphManager must be initialized before querying callees');
        if (!this.synchronousOnly) return this.resolver.getCallees(call);
        const cached = this.synchronousCallees.get(call);
        if (cached) return cached;
        // Keep proven synchronous parameter calls and lowered component builders; no SDK callback guessing.
        const result = new Set([...this.resolver.getCallees(call)]
            .filter(method => !method.containsModifier(ModifierType.ASYNC)));
        this.synchronousCallees.set(call, result);
        return result;
    }

    isCallStatement(stmt: Stmt): boolean {
        return !!stmt.getInvokeExpr() && this.getCalleesOfCallAt(stmt).size > 0;
    }
}
