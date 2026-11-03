import {
    AliasType,
    ArkArrayRef,
    ArkAssignStmt,
    ArkIfStmt,
    ArkInstanceFieldRef,
    ArkInstanceInvokeExpr,
    Local,
    NullConstant,
    NullType,
    UndefinedConstant,
    UndefinedType,
    UnionType,
    type Stmt,
    type Type,
    type Value,
} from '../../adapter/arkanalyzer';
import { tryRenderArkType } from './ArkAnalyzerCompatibility';
import {
    NullnessAccessPath,
    NullnessFact,
    NullnessKind,
    NullnessOriginKind,
    mayBeNull,
    mayBeUndefined,
    nullnessFromAlternatives,
} from './NullnessFact';
import type { NullnessLibraryRegistry } from './library/NullnessLibraryRegistry';
import {
    NULL,
    UNDEFINED,
    NullnessSourceSemantics,
    appendSourceProperty,
    sourcePropertyName,
    type SourceAccess,
} from './NullnessSourceSemantics';

export interface NullDereferenceDiagnostic {
    kind: 'null-dereference';
    nullness: NullnessKind;
    accessPath: NullnessAccessPath;
    sourceStmt: Stmt;
    dereferenceStmt: Stmt;
    sourceLocation: NullnessSourceLocation;
    dereferenceLocation: NullnessSourceLocation;
    description: string;
    confidence: 'high' | 'low';
}

export interface NullnessSourceLocation {
    filePath: string;
    line: number;
    col: number;
}

export interface NullnessStatementInfo {
    receivers: Array<{ path: NullnessAccessPath; member: string | null; operand: Value }>;
    arguments: Array<{ path: NullnessAccessPath; index: number }>;
    accesses: readonly SourceAccess[];
    location: NullnessSourceLocation;
}

interface NullnessReporterOptions {
    readonly sourceSemantics: NullnessSourceSemantics;
    readonly libraryRegistry: NullnessLibraryRegistry;
    readonly statementInfo: WeakMap<Stmt, NullnessStatementInfo>;
    readonly accessPathsAlias: (
        left: NullnessAccessPath,
        right: NullnessAccessPath,
        atStmt?: Stmt
    ) => boolean;
    readonly renderSourceAccessPath: (path: NullnessAccessPath, followAliases?: boolean) => string;
    readonly canonicalizeAccessPath: (path: NullnessAccessPath) => NullnessAccessPath;
    readonly isDereferenceProtectedByShortCircuit: (
        value: Value,
        fact: NullnessFact,
        branchStmt: ArkIfStmt
    ) => boolean;
}

/** Detects and records null-dereference diagnostics without owning IFDS propagation. */
export class NullnessReporter {
    private readonly diagnostics: NullDereferenceDiagnostic[] = [];
    private readonly diagnosticsByLocation = new Map<string, NullDereferenceDiagnostic[]>();

    constructor(private readonly options: NullnessReporterOptions) {}

    checkDirectDereference(stmt: Stmt, fact: NullnessFact): void {
        if ((!mayBeNull(fact.kind) && !mayBeUndefined(fact.kind)) ||
            !fact.origin || typeof stmt.getUses !== 'function') {
            return;
        }
        if (this.isFrameworkInitializationDependent(fact)) return;
        const info = this.getStatementInfo(stmt);
        const isReceiverDereference = info.receivers.some(receiver =>
            this.options.accessPathsAlias(receiver.path, fact.accessPath) &&
            this.isReportableSourceUse(stmt, receiver.path, receiver.member, undefined, fact)
        );
        const isNonNullArgumentUse = info.arguments.some(argument =>
            this.options.accessPathsAlias(argument.path, fact.accessPath) &&
            this.isReportableSourceUse(stmt, argument.path, null, argument.index, fact)
        );
        if (!isReceiverDereference && !isNonNullArgumentUse) return;
        if (stmt instanceof ArkIfStmt &&
            this.options.isDereferenceProtectedByShortCircuit(stmt.getConditionExpr(), fact, stmt)) {
            return;
        }

        const sourceStmt = fact.origin.stmt as Stmt;
        const sourceLocation = this.getLocation(sourceStmt);
        const dereferenceLocation = this.getLocation(stmt);
        this.recordDiagnostic({
            kind: 'null-dereference',
            nullness: fact.kind,
            accessPath: fact.accessPath,
            sourceStmt,
            dereferenceStmt: stmt,
            sourceLocation,
            dereferenceLocation,
            description: isNonNullArgumentUse && !isReceiverDereference
                ? `${fact.kind === NullnessKind.MaybeNull ||
                    fact.kind === NullnessKind.MaybeUndefined ||
                    fact.kind === NullnessKind.MaybeNullish ? 'Potential' : 'Definite'} ` +
                    `nullish value passed to a non-null parameter: ${fact.accessPath.toString()}`
                : fact.kind === NullnessKind.MaybeNull ||
                    fact.kind === NullnessKind.MaybeUndefined ||
                    fact.kind === NullnessKind.MaybeNullish
                    ? `Potential nullish dereference of ${fact.accessPath.toString()}`
                    : `Definite ${fact.kind} dereference of ${fact.accessPath.toString()}`,
            confidence: fact.isApproximateEvidence()
                ? 'low'
                : 'high',
        });
    }

    /**
     * Detect `value!.field || value === undefined` before fact propagation.
     * The right operand cannot protect a dereference already evaluated by the
     * left operand, even when no explicit nullish assignment is reachable.
     */
    checkLateNullGuard(stmt: Stmt): void {
        const info = this.getStatementInfo(stmt);
        for (const access of info.accesses) {
            if (!access.asserted || !access.checkedLater || access.optional ||
                (access.excluded & access.checkedLater) === access.checkedLater) continue;
            const receiver = info.receivers.find(receiver =>
                receiver.member === access.member &&
                this.options.renderSourceAccessPath(receiver.path) === access.receiver);
            if (!receiver) continue;
            const accessPath = this.options.canonicalizeAccessPath(receiver.path);
            const kind = access.checkedLater === NULL ? NullnessKind.MaybeNull
                : access.checkedLater === UNDEFINED ? NullnessKind.MaybeUndefined : NullnessKind.MaybeNullish;
            this.recordDiagnostic({
                kind: 'null-dereference',
                nullness: kind,
                accessPath,
                sourceStmt: stmt,
                dereferenceStmt: stmt,
                sourceLocation: info.location,
                dereferenceLocation: info.location,
                description: `Potential nullish dereference of ${accessPath.toString()} before its null check`,
                confidence: 'high',
            });
        }
    }

    /** Report a registered non-null API argument when its declared type is nullable. */
    checkTypedNonNullArguments(stmt: Stmt): void {
        const invoke = stmt.getInvokeExpr();
        if (!invoke) return;
        for (const index of this.options.libraryRegistry.getNonNullArgumentIndices(stmt)) {
            const argument = invoke.getArgs()[index];
            if (!argument) continue;
            const accessPath = NullnessAccessPath.fromValue(argument);
            const kind = this.getTypeNullness(argument.getType());
            if (accessPath.isEmpty() || !kind) continue;
            this.checkDirectDereference(stmt, NullnessFact.create(accessPath, kind, {
                kind: NullnessOriginKind.Uninitialized,
                stmt,
                description: 'nullable value used where the API requires a non-null argument',
            }));
        }
    }

    isOptionalChainStatement(stmt: Stmt): boolean {
        const right = stmt instanceof ArkAssignStmt ? stmt.getRightOp() : undefined;
        if (!(right instanceof ArkInstanceFieldRef)) return false;
        const canonical = this.options.renderSourceAccessPath(NullnessAccessPath.fromValue(right.getBase()));
        return this.getStatementInfo(stmt).accesses.some(access => access.optional &&
            access.receiver === canonical &&
            access.member === sourcePropertyName(right.getFieldSignature().getFieldName()));
    }

    excludesCallerArgument(
        stmt: Stmt,
        path: NullnessAccessPath,
        argumentIndex: number,
        fact: NullnessFact
    ): boolean {
        const origin = fact.origin?.stmt;
        if (origin instanceof ArkAssignStmt && origin.getRightOp() instanceof UndefinedConstant &&
            origin.getLeftOp() instanceof Local && fact.kind === NullnessKind.Undefined &&
            this.options.renderSourceAccessPath(path, false) ===
                (origin.getLeftOp() as Local).getName() &&
            this.options.sourceSemantics.excludesUninitializedLocal(
                stmt,
                (origin.getLeftOp() as Local).getName(),
                origin
            )) return true;
        const accesses = this.getSourceAccessMatches(stmt, path, null, argumentIndex);
        const nullish = (mayBeNull(fact.kind) ? NULL : 0) | (mayBeUndefined(fact.kind) ? UNDEFINED : 0);
        return accesses.length > 0 && accesses.every(access => (nullish & ~access.excluded) === 0);
    }

    getNullDereferences(): readonly NullDereferenceDiagnostic[] {
        return this.diagnostics;
    }

    /** Component injection/reuse/event order is outside this check's current scope, not proven safe. */
    private isFrameworkInitializationDependent(fact: NullnessFact): boolean {
        const origin = fact.origin?.stmt;
        if (!(origin instanceof ArkAssignStmt) ||
            !(origin.getRightOp() instanceof NullConstant || origin.getRightOp() instanceof UndefinedConstant)) {
            return false;
        }
        const field = origin.getLeftOp();
        const method = origin.getCfg()?.getDeclaringMethod();
        if (!(field instanceof ArkInstanceFieldRef) || method?.getName() !== '%instInit') return false;
        const owner = method.getDeclaringArkClass();
        if (!owner.hasDecorator('Component') && !owner.hasDecorator('Entry')) return false;
        const declaration = owner.getFieldWithName(field.getFieldSignature().getFieldName());
        return ['Require', 'State', 'Prop', 'Link', 'Consume', 'StorageLink', 'StorageProp',
            'LocalStorageLink', 'LocalStorageProp', 'ObjectLink']
            .some(name => declaration?.hasDecorator(name));
    }

    private getTypeNullness(type: Type): NullnessKind | null {
        const alternatives = { null: false, undefined: false, nonNull: false };
        const visit = (candidate: Type, visited: Set<Type>): void => {
            if (visited.has(candidate)) return;
            visited.add(candidate);
            if (candidate instanceof AliasType) {
                visit(candidate.getOriginalType(), visited);
            } else if (candidate instanceof UnionType) {
                for (const member of candidate.getTypes()) visit(member, visited);
            } else if (candidate instanceof NullType) {
                alternatives.null = true;
            } else if (candidate instanceof UndefinedType) {
                alternatives.undefined = true;
            } else {
                alternatives.nonNull = true;
            }
        };
        visit(type, new Set());
        if (!alternatives.null && !alternatives.undefined) {
            // Some unresolved ArkIR types retain a useful union only in their
            // rendered form. Accept explicit null/undefined members, not any.
            const rendered = tryRenderArkType(type);
            if (rendered === null) return null;
            alternatives.null = /(?:^|\|)null(?:\||$)/.test(rendered);
            alternatives.undefined = /(?:^|\|)undefined(?:\||$)/.test(rendered);
            if (!alternatives.null && !alternatives.undefined) return null;
            alternatives.nonNull = true;
        }
        const kind = nullnessFromAlternatives(alternatives);
        return kind === 'non-null' ? null : kind;
    }

    private recordDiagnostic(diagnostic: NullDereferenceDiagnostic): void {
        const location = diagnostic.dereferenceLocation;
        const key = JSON.stringify([location.filePath, location.line, location.col]);
        const bucket = this.diagnosticsByLocation.get(key) ?? [];
        if (bucket.some(existing =>
            this.options.accessPathsAlias(existing.accessPath, diagnostic.accessPath))) return;
        bucket.push(diagnostic);
        this.diagnosticsByLocation.set(key, bucket);
        this.diagnostics.push(diagnostic);
    }

    private getStatementInfo(stmt: Stmt): NullnessStatementInfo {
        const cached = this.options.statementInfo.get(stmt);
        if (cached) return cached;
        const receivers: NullnessStatementInfo['receivers'] = [];
        for (const value of stmt.getUses?.() ?? []) {
            if (value instanceof ArkInstanceFieldRef || value instanceof ArkArrayRef ||
                value instanceof ArkInstanceInvokeExpr) {
                const member = value instanceof ArkInstanceFieldRef
                    ? value.getFieldSignature().getFieldName()
                    : value instanceof ArkInstanceInvokeExpr
                        ? value.getMethodSignature().getMethodSubSignature().getMethodName()
                        : null;
                receivers.push({ path: NullnessAccessPath.fromValue(value.getBase()), member, operand: value });
            }
        }
        const invoke = stmt.getInvokeExpr();
        const args = this.options.libraryRegistry.getNonNullArgumentIndices(stmt).flatMap(index => {
            const value = invoke?.getArgs()[index];
            return value ? [{ path: NullnessAccessPath.fromValue(value), index }] : [];
        });
        const result = {
            receivers,
            arguments: args,
            accesses: this.options.sourceSemantics.getAccesses(stmt),
            location: this.getLocation(stmt),
        };
        this.options.statementInfo.set(stmt, result);
        return result;
    }

    private isReportableSourceUse(
        stmt: Stmt,
        path: NullnessAccessPath,
        member: string | null,
        argumentIndex: number | undefined,
        fact: NullnessFact
    ): boolean {
        const origin = fact.origin?.stmt;
        if (origin instanceof ArkAssignStmt && origin.getRightOp() instanceof UndefinedConstant &&
            origin.getLeftOp() instanceof Local && fact.kind === NullnessKind.Undefined &&
            this.options.renderSourceAccessPath(path, false) ===
                (origin.getLeftOp() as Local).getName() &&
            this.options.sourceSemantics.excludesUninitializedLocal(
                stmt,
                (origin.getLeftOp() as Local).getName(),
                origin
            )) return false;
        const info = this.getStatementInfo(stmt);
        const matches = this.getSourceAccessMatches(stmt, path, member, argumentIndex);
        if (!matches.length) return true; // No precise source mapping: keep the IR evidence.
        const nullish = (mayBeNull(fact.kind) ? NULL : 0) | (mayBeUndefined(fact.kind) ? UNDEFINED : 0);
        // Compilable ArkTS requires narrowing, assertion or optional access for nullable types.
        // Keep that source contract; JS/TS, explicit API obligations and concrete nullable-return
        // evidence retain their existing diagnostic policy. Missing source mapping stays conservative.
        return matches.some(access => !access.optional && !access.coercion &&
            (nullish & ~access.excluded) !== 0 &&
            (argumentIndex !== undefined || access.asserted ||
                fact.origin?.kind === NullnessOriginKind.NullableReturn ||
                !info.location.filePath.endsWith('.ets')));
    }

    private getSourceAccessMatches(
        stmt: Stmt,
        path: NullnessAccessPath,
        member: string | null,
        argumentIndex?: number
    ): readonly SourceAccess[] {
        const info = this.getStatementInfo(stmt);
        const canonical = this.options.renderSourceAccessPath(path);
        const original = this.options.renderSourceAccessPath(path, false);
        const sourceMember = member === null ? null : sourcePropertyName(member);
        const precise = argumentIndex === undefined ? info.receivers
            .filter(receiver => receiver.path.equals(path) && receiver.member === member)
            .flatMap(receiver =>
                this.options.sourceSemantics.getOperandAccesses(stmt, receiver.operand) ?? [])
            : [];
        const relevant = (access: SourceAccess): boolean => access.argumentIndex === argumentIndex &&
            (argumentIndex !== undefined || access.member === sourceMember || (member === null && !!access.indexed));
        const exact = precise.filter(relevant);
        const candidates = exact.length ? exact : info.accesses.filter(relevant);
        let matches = candidates.filter(access => access.receiver === original);
        const definition = (path.base as Local | null)?.getDeclaringStmt();
        const getter = definition?.getInvokeExpr();
        if (!matches.length && definition && getter instanceof ArkInstanceInvokeExpr &&
            getter.getMethodSignature().getMethodSubSignature().getMethodName().startsWith('Get-') &&
            this.options.libraryRegistry.getGetterRead(definition)) {
            const getterName = getter.getMethodSignature().getMethodSubSignature().getMethodName().slice(4);
            const receiver = appendSourceProperty(
                this.options.renderSourceAccessPath(NullnessAccessPath.fromValue(getter.getBase())),
                getterName
            );
            // Optional access is safe for this evaluation. Do not reuse a source getter guard:
            // a write to its differently named backing field must still invalidate the result.
            matches = candidates.filter(access => access.receiver === receiver && access.optional);
        }
        if (!matches.length) matches = candidates.filter(access => access.receiver === canonical);
        if (!matches.length) matches = candidates.filter(access => access.receiver === null);
        return matches;
    }

    private getLocation(stmt: Stmt): NullnessSourceLocation {
        const cached = this.options.statementInfo.get(stmt);
        if (cached) return cached.location;
        const position = stmt.getOriginPositionInfo();
        let filePath = 'unknown';
        try {
            filePath = stmt.getCfg()?.getDeclaringMethod().getDeclaringArkFile().getFilePath() ?? 'unknown';
        } catch {
            // Synthetic statements may not have a declaring file.
        }
        return {
            filePath,
            line: position?.getLineNo() ?? -1,
            col: position?.getColNo() ?? -1,
        };
    }
}
