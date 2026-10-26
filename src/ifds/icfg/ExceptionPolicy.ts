import {
    ArkAssignStmt,
    ArkAwaitExpr,
    ArkThrowStmt,
    Local,
    type ArkFile,
    type ArkMethod,
    type Scene,
    type Stmt,
} from '../../adapter/arkanalyzer';

/** Calls succeed by default. Only explicit throws and declared API errors add failure paths. */
export class ExceptionPolicy {
    private readonly contracts = new Map<ArkMethod, boolean>();
    private readonly sourceLines = new Map<ArkFile, string[]>();

    constructor(private readonly scene: Scene) {}

    mayThrow(stmt: Stmt): boolean {
        if (stmt instanceof ArkThrowStmt) return true;
        if (this.declaresThrows(stmt)) return true;
        for (const expr of stmt.getExprs()) {
            if (!(expr instanceof ArkAwaitExpr)) continue;
            let promise = expr.getPromise();
            const seen = new Set<Local>();
            while (promise instanceof Local && !seen.has(promise)) {
                seen.add(promise);
                const declaration = promise.getDeclaringStmt();
                if (!declaration) break;
                if (this.declaresThrows(declaration)) return true;
                if (!(declaration instanceof ArkAssignStmt)) break;
                promise = declaration.getRightOp();
            }
        }
        return false;
    }

    private declaresThrows(stmt: Stmt): boolean {
        const signature = stmt.getInvokeExpr()?.getMethodSignature();
        const method = signature ? this.scene.getMethod(signature) : null;
        if (!method) return false;
        const cached = this.contracts.get(method);
        if (cached !== undefined) return cached;
        const file = method.getDeclaringArkFile();
        let lines = this.sourceLines.get(file);
        if (!lines) {
            lines = file.getCode().split('\n');
            this.sourceLines.set(file, lines);
        }
        const implementation = method.getImplOriginFullPosition();
        const positions = [...(method.getDeclareOriginFullPositions() ?? []), ...(implementation ? [implementation] : [])];
        const declared = positions.some(position => {
            const line = position.getFirstLine() - 1;
            let prefix = (lines!.slice(0, line).join('\n') + '\n' +
                (lines![line] ?? '').slice(0, position.getFirstCol() - 1)).trimEnd();
            // SDKs can attach several versioned JSDoc blocks to one overload.
            while (prefix.endsWith('*/')) {
                const start = prefix.lastIndexOf('/*', prefix.length - 2);
                if (start < 0) break;
                const comment = prefix.slice(start);
                if (comment.startsWith('/**') && /^\s*(?:\/\*\*|\*)?\s*@(?:throws|exception)\b/m.test(comment)) return true;
                prefix = prefix.slice(0, start).trimEnd();
            }
            return false;
        });
        this.contracts.set(method, declared);
        return declared;
    }
}
