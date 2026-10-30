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
    private readonly sources = new Map<ArkFile, { code: string; lineStarts: number[] }>();
    private readonly statements = new WeakMap<Stmt, boolean>();

    constructor(private readonly scene: Scene) {}

    mayThrow(stmt: Stmt): boolean {
        const cached = this.statements.get(stmt);
        if (cached !== undefined) return cached;
        const result = this.computeMayThrow(stmt);
        this.statements.set(stmt, result);
        return result;
    }

    private computeMayThrow(stmt: Stmt): boolean {
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
        let source = this.sources.get(file);
        if (!source) {
            const code = file.getCode();
            const lineStarts = [0];
            for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
            source = { code, lineStarts };
            this.sources.set(file, source);
        }
        const { code, lineStarts } = source;
        const implementation = method.getImplOriginFullPosition();
        const positions = [...(method.getDeclareOriginFullPositions() ?? []), ...(implementation ? [implementation] : [])];
        const declared = positions.some(position => {
            const lineStart = lineStarts[position.getFirstLine() - 1];
            if (lineStart === undefined) return false;
            let end = lineStart + position.getFirstCol() - 1;
            const skipWhitespace = (): void => {
                while (end > 0 && /\s/.test(code[end - 1])) end--;
            };
            skipWhitespace();
            // SDKs can attach several versioned JSDoc blocks to one overload.
            while (code.slice(end - 2, end) === '*/') {
                const start = code.lastIndexOf('/*', end - 2);
                if (start < 0) break;
                const comment = code.slice(start, end);
                if (comment.startsWith('/**') && /^\s*(?:\/\*\*|\*)?\s*@(?:throws|exception)\b/m.test(comment)) return true;
                end = start;
                skipWhitespace();
            }
            return false;
        });
        this.contracts.set(method, declared);
        return declared;
    }
}
