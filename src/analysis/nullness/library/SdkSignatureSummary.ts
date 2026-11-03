import fs from 'node:fs';
import path from 'node:path';
import { AliasType, ArkAssignStmt, ArkCastExpr, ArkInstanceFieldRef, ArkInstanceInvokeExpr,
    ArrayType, BooleanType, ClassType, FunctionType, Local, NumberType, StringType,
    UnionType, UndefinedType, NullConstant, UndefinedConstant, type Stmt, type Type } from '../../../adapter/arkanalyzer';
import { NullnessAccessPath, NullnessFact, NullnessKind, NullnessOriginKind } from '../NullnessFact';
import { tryRenderArkType } from '../ArkAnalyzerCompatibility';
import type { NullnessLibrarySummary } from './NullnessLibrarySummary';

interface SignatureModel {
    signature: string;
    returnNullness: 'non-null' | NullnessKind;
    evidence: string;
    predicate?: 'array';
    semantics?: 'json-parse' | 'map-get';
}

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'sdk-nullness-summary.json'), 'utf8')) as {
    schemaVersion: number; methods: SignatureModel[]; fields: SignatureModel[];
};
if (catalog.schemaVersion !== 2) throw new Error('Unsupported nullness signature catalog');
const models = new Map(catalog.methods.map(model => [model.signature, model]));
const fields = new Map(catalog.fields.map(model => [model.signature, model]));

export function isModeledArrayPredicate(signature: { toString(): string }): boolean {
    const key = tryRenderArkType(signature);
    return key !== null && models.get(key)?.predicate === 'array';
}

/** Only reviewed complete signatures own a call. Unresolved signatures never inherit a model. */
export class SdkSignatureSummary implements NullnessLibrarySummary {
    readonly id = 'sdk-signature';
    private readonly calls = new WeakMap<Stmt, SignatureModel | null>();

    private model(stmt: Stmt): SignatureModel | undefined {
        if (this.calls.has(stmt)) return this.calls.get(stmt) ?? undefined;
        const signature = stmt.getInvokeExpr()?.getMethodSignature();
        const key = signature && tryRenderArkType(signature);
        const result = key ? models.get(key) : undefined;
        this.calls.set(stmt, result ?? null);
        return result;
    }

    matches(stmt: Stmt): boolean { return this.model(stmt) !== undefined; }

    getFieldReadFacts(stmt: Stmt): Set<NullnessFact> {
        if (!(stmt instanceof ArkAssignStmt) || !(stmt.getRightOp() instanceof ArkInstanceFieldRef)) return new Set();
        const field = stmt.getRightOp() as ArkInstanceFieldRef;
        const model = fields.get(field.getFieldSignature().toString());
        if (!model || model.returnNullness === 'non-null') return new Set();
        return new Set([NullnessFact.create(NullnessAccessPath.fromValue(stmt.getLeftOp()), model.returnNullness, {
            kind: NullnessOriginKind.LibraryModel, stmt, description: model.evidence,
        })]);
    }

    getCallToReturnFacts(stmt: Stmt, fact: NullnessFact): Set<NullnessFact> {
        const model = this.model(stmt);
        if (!fact.isZeroFact() || !(stmt instanceof ArkAssignStmt) || !model ||
            model.returnNullness === 'non-null') return new Set();
        const accessPath = NullnessAccessPath.fromValue(stmt.getLeftOp());
        if (accessPath.isEmpty()) return new Set();
        let kind = model.returnNullness;
        if (model.semantics === 'map-get' && this.hasNonNullMapValues(stmt)) {
            // Missing keys still return undefined, even when V excludes null.
            kind = NullnessKind.MaybeUndefined;
        }
        if (model.semantics === 'json-parse') {
            const reviver = stmt.getInvokeExpr()!.getArgs()[1];
            // ECMA-262 JSON.parse: only a callable reviver can produce undefined.
            // Do not infer non-callability from broad/possibly unresolved ArkIR types.
            // Invalid JSON throws; these are normal-return facts, not exception values.
            if (!reviver || reviver instanceof UndefinedConstant || reviver instanceof NullConstant) {
                kind = NullnessKind.MaybeNull;
            }
        }
        return new Set([NullnessFact.create(accessPath, kind, {
            kind: NullnessOriginKind.LibraryModel, stmt, description: model.evidence,
        })]);
    }

    private hasNonNullMapValues(stmt: Stmt): boolean {
        const invoke = stmt.getInvokeExpr();
        if (!(invoke instanceof ArkInstanceInvokeExpr)) return false;
        let receiver = invoke.getBase();
        const locals = new Set<Local>();
        while (!locals.has(receiver)) {
            locals.add(receiver);
            const definition = receiver.getDeclaringStmt();
            if (!(definition instanceof ArkAssignStmt)) break;
            const value = definition.getRightOp();
            // A cast can erase a nullable value type; do not trust it as evidence.
            if (value instanceof ArkCastExpr) return false;
            if (!(value instanceof Local)) break;
            receiver = value;
        }
        const unwrap = (type: Type, visited = new Set<Type>()): Type | undefined => {
            if (visited.has(type)) return undefined;
            visited.add(type);
            return type instanceof AliasType ? unwrap(type.getOriginalType(), visited) : type;
        };
        const map = unwrap(invoke.getBase().getType());
        if (!(map instanceof ClassType) || map.getClassSignature().toString() !==
            invoke.getMethodSignature().getDeclaringClassSignature().toString()) return false;
        const value = map.getRealGenericTypes()?.[1];
        if (!value) return false;
        const excludesNull = (type: Type, visited = new Set<Type>()): boolean => {
            if (visited.has(type)) return false;
            visited.add(type);
            if (type instanceof AliasType) return excludesNull(type.getOriginalType(), visited);
            if (type instanceof UnionType) return type.getTypes().length > 0 &&
                type.getTypes().every(member => excludesNull(member, new Set(visited)));
            // Unresolved/any/generic types do not prove the absence of null.
            return type instanceof ClassType || type instanceof ArrayType || type instanceof FunctionType ||
                type instanceof StringType || type instanceof NumberType || type instanceof BooleanType ||
                type instanceof UndefinedType;
        };
        return excludesNull(value);
    }
}
