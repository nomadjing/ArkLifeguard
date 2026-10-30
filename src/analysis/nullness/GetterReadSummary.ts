import { ArkAssignStmt, ArkInstanceInvokeExpr, ArkReturnStmt, ArkThisRef, Local,
    NullConstant, UndefinedConstant, ts, type ArkMethod, type Scene, type Stmt, type Value } from '../../adapter/arkanalyzer';
import { NullnessAccessPath } from './NullnessFact';

/** Proves an actual accessor returns one backing field (or nullish), without calls or writes. */
export class GetterReadSummary {
    private readonly methods = new WeakMap<ArkMethod, NullnessAccessPath | null>();
    private readonly calls = new WeakMap<Stmt, NullnessAccessPath | null>();

    constructor(private readonly scene: Scene) {}

    getRead(stmt: Stmt): NullnessAccessPath | null {
        if (this.calls.has(stmt)) return this.calls.get(stmt)!;
        const invoke = stmt.getInvokeExpr();
        let result: NullnessAccessPath | null = null;
        // Get- is ArkIR's accessor tag; the source AST below still proves it is an accessor.
        if (invoke instanceof ArkInstanceInvokeExpr &&
            invoke.getMethodSignature().getMethodSubSignature().getMethodName().startsWith('Get-')) {
            const method = this.scene.getMethod(invoke.getMethodSignature());
            const read = method && this.getMethodRead(method);
            if (read) {
                const receiver = NullnessAccessPath.fromValue(invoke.getBase());
                result = new NullnessAccessPath(receiver.base, receiver.baseType, [...receiver.fields, ...read.fields]);
            }
        }
        this.calls.set(stmt, result);
        return result;
    }

    private getMethodRead(method: ArkMethod): NullnessAccessPath | null {
        if (this.methods.has(method)) return this.methods.get(method)!;
        this.methods.set(method, null);
        const code = method.getCode();
        if (!code || method.getDeclaringArkClass().getExtendedClasses().size) return null;
        const source = ts.createSourceFile('getter.ts', `class C { ${code} }`, ts.ScriptTarget.Latest, true);
        const declaration = source.statements[0];
        if (!ts.isClassDeclaration(declaration) || declaration.members.length !== 1 ||
            !ts.isGetAccessorDeclaration(declaration.members[0])) return null;
        let read: NullnessAccessPath | null = null;
        const assigned = new Set<Local>();
        for (const stmt of method.getCfg()?.getStmts() ?? []) {
            if (stmt.getInvokeExpr()) return null;
            if (stmt instanceof ArkAssignStmt) {
                const target = stmt.getLeftOp();
                if (!(target instanceof Local) || assigned.has(target)) return null;
                assigned.add(target);
            }
            if (!(stmt instanceof ArkReturnStmt)) continue;
            let value: Value = stmt.getOp();
            const visited = new Set<Value>();
            while (value instanceof Local && !visited.has(value)) {
                visited.add(value);
                const definition = value.getDeclaringStmt();
                if (!(definition instanceof ArkAssignStmt)) break;
                value = definition.getRightOp();
            }
            if (value instanceof NullConstant || value instanceof UndefinedConstant) continue;
            const path = NullnessAccessPath.fromValue(value);
            const identity = (path.base as Local | null)?.getDeclaringStmt();
            if (!(identity instanceof ArkAssignStmt) || !(identity.getRightOp() instanceof ArkThisRef) ||
                path.fields.length !== 1 || !method.getDeclaringArkClass().getFieldWithName(path.fields[0].getFieldName())) return null;
            if (read && !read.equals(path)) return null;
            read = path;
        }
        this.methods.set(method, read);
        return read;
    }
}
