import { ArkAssignStmt, ArkInstanceFieldRef, ArkInstanceInvokeExpr, ArkReturnStmt, ArkThisRef, Local,
    ClassType, FieldSignature, NullType, UndefinedType, UnionType,
    NullConstant, UndefinedConstant, ts, type ArkMethod, type Scene, type Stmt, type Value } from '../../adapter/arkanalyzer';
import { NullnessAccessPath, NullnessFact, NullnessKind, type INullnessFieldSignature } from './NullnessFact';

/** Proves a getter or parameterless method reads one field chain, optionally guarded by an object prefix. */
export class GetterReadSummary {
    private readonly methods = new WeakMap<ArkMethod, NullnessAccessPath | null>();
    private readonly fallback = new WeakMap<ArkMethod, { depth: number; kind: NullnessKind }>();
    private readonly calls = new WeakMap<Stmt, NullnessAccessPath | null>();

    constructor(private readonly scene: Scene) {}

    getRead(stmt: Stmt): NullnessAccessPath | null {
        if (this.calls.has(stmt)) return this.calls.get(stmt)!;
        const invoke = stmt.getInvokeExpr();
        let result: NullnessAccessPath | null = null;
        // Prove the declaration and return shape below, independently of the method name.
        if (invoke instanceof ArkInstanceInvokeExpr && invoke.getArgs().length === 0) {
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
    /** A proven read supplies the return facts; callee literal exits must not add unrelated alternatives. */
    getReturnFacts(stmt: Stmt, fact: NullnessFact): Set<NullnessFact> {
        const result = new Set<NullnessFact>();
        const read = this.getRead(stmt);
        if (!read || fact.isZeroFact() || !(stmt instanceof ArkAssignStmt)) return result;
        const target = NullnessAccessPath.fromValue(stmt.getLeftOp());
        if (read.isPrefixOf(fact.accessPath)) {
            result.add(fact.deriveWithNewAccessPath(new NullnessAccessPath(target.base, target.baseType,
                [...target.fields, ...fact.accessPath.remainingFieldsAfter(read)]), stmt));
        } else if (fact.accessPath.isPrefixOf(read)) {
            const invoke = stmt.getInvokeExpr() as ArkInstanceInvokeExpr;
            const method = this.scene.getMethod(invoke.getMethodSignature());
            const fallback = method && this.fallback.get(method);
            const receiverDepth = NullnessAccessPath.fromValue(invoke.getBase()).fields.length;
            if (fallback && fact.origin && fact.accessPath.fields.length === receiverDepth + fallback.depth) {
                result.add(NullnessFact.create(target, fallback.kind, fact.origin));
            }
        }
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
            !(ts.isGetAccessorDeclaration(declaration.members[0]) || ts.isMethodDeclaration(declaration.members[0]))) return null;
        const member = declaration.members[0];
        if (!member.body || member.parameters.length) return null;
        const fieldPath = (node: ts.Expression): string[] | null => {
            if (node.kind === ts.SyntaxKind.ThisKeyword) return [];
            if (!ts.isPropertyAccessExpression(node) || node.questionDotToken) return null;
            const base = fieldPath(node.expression);
            return base && [...base, node.name.text];
        };
        const returned = (node: ts.Statement): ts.Expression | undefined => {
            if (ts.isBlock(node) && node.statements.length === 1) node = node.statements[0];
            return ts.isReturnStatement(node) ? node.expression : undefined;
        };
        const statements = member.body.statements;
        let expected: string[] | null = null;
        if (statements.length === 1 && ts.isReturnStatement(statements[0]) && statements[0].expression) {
            expected = fieldPath(statements[0].expression);
        } else if (statements.length >= 1 && ts.isIfStatement(statements[0])) {
            const branch = statements[0];
            const guard = fieldPath(branch.expression);
            const present = returned(branch.thenStatement);
            const absent = branch.elseStatement ? returned(branch.elseStatement)
                : statements.length === 2 ? returned(statements[1]) : undefined;
            expected = present ? fieldPath(present) : null;
            const kind = absent?.kind === ts.SyntaxKind.NullKeyword ? NullnessKind.Null
                : absent && ts.isIdentifier(absent) && absent.text === 'undefined' ? NullnessKind.Undefined : null;
            if (!guard?.length || !expected || !kind || guard.length >= expected.length ||
                !guard.every((name, index) => name === expected![index]) ||
                statements.length !== (branch.elseStatement ? 1 : 2)) return null;
            this.fallback.set(method, { depth: guard.length, kind });
        }
        if (!expected?.length) return null;
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
            const fields: INullnessFieldSignature[] = [];
            while (!visited.has(value)) {
                visited.add(value);
                if (value instanceof ArkInstanceFieldRef) {
                    fields.unshift(value.getFieldSignature());
                    value = value.getBase();
                    continue;
                }
                if (!(value instanceof Local)) break;
                const definition = value.getDeclaringStmt();
                if (!(definition instanceof ArkAssignStmt)) break;
                if (definition.getRightOp() instanceof ArkThisRef) break;
                value = definition.getRightOp();
            }
            if (value instanceof NullConstant || value instanceof UndefinedConstant) continue;
            const root = NullnessAccessPath.fromValue(value);
            const path = new NullnessAccessPath(root.base, root.baseType, [...root.fields, ...fields]);
            const identity = (path.base as Local | null)?.getDeclaringStmt();
            if (!(identity instanceof ArkAssignStmt) || !(identity.getRightOp() instanceof ArkThisRef) ||
                path.fields.length === 0 || !method.getDeclaringArkClass().getFieldWithName(path.fields[0].getFieldName())) return null;
            if (read && !read.equals(path)) return null;
            read = path;
        }
        if (!read || read.fields.map(field => field.getFieldName()).join('.') !== expected.join('.')) return null;
        const fallback = this.fallback.get(method);
        if (fallback) {
            const guard = read.fields[fallback.depth - 1];
            if (!(guard instanceof FieldSignature)) return null;
            const alternatives = guard.getType() instanceof UnionType
                ? (guard.getType() as UnionType).getTypes() : [guard.getType()];
            // Falsy numbers/strings would introduce fallback results without a nullish fact.
            if (!alternatives.every(type => type instanceof ClassType || type instanceof NullType ||
                type instanceof UndefinedType)) return null;
        }
        this.methods.set(method, read);
        return read;
    }
}
