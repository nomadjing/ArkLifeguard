/*
 * Copyright (c) 2024-2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    BooleanConstant,
    BooleanType,
    NullConstant,
    NumberConstant,
    StringConstant,
    UndefinedConstant,
} from '../../adapter/arkanalyzer';
import {
    ArkAwaitExpr,
    ArkCastExpr,
    ArkConditionExpr,
    ArkInstanceOfExpr,
    ArkStaticInvokeExpr,
    ArkTypeOfExpr,
    ArkInstanceInvokeExpr,
    ArkNormalBinopExpr,
    ArkUnopExpr,
    NormalBinaryOperator,
    RelationalBinaryOperator,
    UnaryOperator,
} from '../../adapter/arkanalyzer';
import { Local } from '../../adapter/arkanalyzer';
import {
    ArkArrayRef,
    ArkCaughtExceptionRef,
    ArkInstanceFieldRef,
    ArkParameterRef,
    ArkThisRef,
    ClosureFieldRef,
} from '../../adapter/arkanalyzer';
import { ArkAssignStmt, ArkIfStmt, ArkReturnStmt, ArkThrowStmt, Stmt } from '../../adapter/arkanalyzer';
import { DataflowProblem, FlowFunction } from '../../ifds';
import { ArkClass, ArkMethod } from '../../adapter/arkanalyzer';
import { CONSTRUCTOR_NAME, ModifierType } from '../../adapter/arkanalyzer';
import {
    AliasType,
    FunctionType,
    LexicalEnvType,
    NullType,
    Type,
    UndefinedType,
    UnionType,
} from '../../adapter/arkanalyzer';
import { Value } from '../../adapter/arkanalyzer';
import {
    NullnessAccessPath,
    NullnessFact,
    NullnessKind,
    NullnessOriginKind,
    keepOnlyNull,
    keepOnlyUndefined,
    mayBeNull,
    nullnessFromAlternatives,
    mayBeUndefined,
    removeNull,
    removeNullish,
    removeUndefined,
} from './NullnessFact';
import { NullnessLibraryRegistry } from './library/NullnessLibraryRegistry';
import { NullnessSourceSemantics, NULL, UNDEFINED, SourceAccess,
    appendSourceProperty, sourcePropertyName } from './NullnessSourceSemantics';
import type { BasicBlock, Cfg } from '../../adapter/arkanalyzer';
import { haveSameCallableIdentity, tryRenderArkType } from './ArkAnalyzerCompatibility';

export interface NullnessAnalysisConfig {
    maxAccessPathLength?: number;
    /** Maximum number of fact-transforming propagation steps; mirrors taint analysis bounds. */
    maxPropagationDepth?: number;
    /** Include low-confidence diagnostics based only on unresolved return types. */
    reportUnresolvedReturns?: boolean;
    /** Join fact kinds and access paths inside recursive call-graph SCCs. */
    recursiveSccWidening?: boolean;
    /** Access-path depth retained inside a recursive SCC before a wildcard suffix. */
    recursiveSccAccessPathLength?: number;
    /** Method-count threshold for conservative whole-project path widening. */
    largeProjectWideningThreshold?: number;
    /** Access-path depth retained when the large-project threshold is exceeded. */
    largeProjectAccessPathLength?: number;
}

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

/**
 * IFDS problem for nullness analysis.
 *
 * Nullish facts are propagated through assignments, arguments, receivers and return values.
 * Reading a field, invoking a method or indexing an array through a tracked access path emits
 * a source-linked diagnostic.
 */
export class NullnessProblem extends DataflowProblem<NullnessFact> {
    private readonly zeroFact = NullnessFact.getZeroFact();
    private readonly config: Required<NullnessAnalysisConfig>;
    private readonly nullDereferences: NullDereferenceDiagnostic[] = [];
    private readonly statementInfo = new WeakMap<Stmt, NullnessStatementInfo>();
    private readonly diagnosticsByLocation = new Map<string, NullDereferenceDiagnostic[]>();
    private readonly cfgIndices = new WeakMap<Cfg, Map<Stmt, BasicBlock>>();
    private readonly callBindings = new WeakMap<Stmt, WeakMap<ArkMethod, readonly NullnessCallBinding[]>>();
    private readonly reassignedLocals = new WeakMap<ArkMethod, ReadonlySet<Local>>();

    constructor(
        private readonly entryPoint: Stmt,
        private readonly entryMethod: ArkMethod,
        config: NullnessAnalysisConfig = {},
        private readonly libraryRegistry: NullnessLibraryRegistry = NullnessLibraryRegistry.createDefault(),
        private readonly sourceSemantics: NullnessSourceSemantics = new NullnessSourceSemantics()
    ) {
        super();
        this.config = {
            maxAccessPathLength: config.maxAccessPathLength ?? 5,
            maxPropagationDepth: config.maxPropagationDepth ?? 100,
            reportUnresolvedReturns: config.reportUnresolvedReturns ?? false,
            recursiveSccWidening: config.recursiveSccWidening ?? true,
            recursiveSccAccessPathLength: config.recursiveSccAccessPathLength ?? 2,
            largeProjectWideningThreshold: config.largeProjectWideningThreshold ?? 5000,
            largeProjectAccessPathLength: config.largeProjectAccessPathLength ?? 2,
        };
    }

    getNormalFlowFunction(srcStmt: Stmt, tgtStmt: Stmt): FlowFunction<NullnessFact> {
        const problem = this;
        return new (class implements FlowFunction<NullnessFact> {
            getDataFacts(fact: NullnessFact): Set<NullnessFact> {
                const result = new Set<NullnessFact>();
                if (fact.isZeroFact()) {
                    problem.checkTypedNonNullArguments(srcStmt);
                    problem.checkLateNullGuard(srcStmt);
                    result.add(fact);
                    const generated = problem.createNullishLiteralFact(srcStmt);
                    if (generated) {
                        result.add(generated);
                    }
                    const nullableFieldRead = problem.createKnownNullableFieldReadFact(srcStmt);
                    if (nullableFieldRead) {
                        result.add(nullableFieldRead);
                    }
                    for (const summaryFact of problem.libraryRegistry
                        .getCallToReturnFacts(srcStmt, fact)) {
                        result.add(summaryFact);
                    }
                    return result;
                }

                const narrowedFact = problem.narrowFactOnBranch(srcStmt, tgtStmt, fact);
                if (!narrowedFact) {
                    return result;
                }
                fact = narrowedFact;


                problem.checkDirectDereference(srcStmt, fact);

                if (srcStmt instanceof ArkAssignStmt) {
                    const propagated = problem.propagateAssignment(srcStmt, fact);
                    for (const derivedFact of propagated) {
                        result.add(derivedFact);
                    }
                    if (!problem.definesAccessPath(srcStmt, fact.accessPath)) {
                        result.add(fact);
                    }
                    return result;
                }

                result.add(fact);
                return result;
            }
        })();
    }

    getCallFlowFunction(srcStmt: Stmt, method: ArkMethod): FlowFunction<NullnessFact> {
        const problem = this;
        return {
            getDataFacts(fact: NullnessFact): Set<NullnessFact> {
                const result = new Set<NullnessFact>();
                if (fact.isZeroFact()) {
                    result.add(fact);
                }
                // Static fields are global facts. They do not need parameter or
                // receiver rebasing when a caller enters another method.
                if (fact.accessPath.isStaticFieldRef()) {
                    result.add(fact);
                }
                const invokeExpr = srcStmt.getInvokeExpr();
                if (!invokeExpr) {
                    return result;
                }

                const args = invokeExpr.getArgs();
                if (fact.isZeroFact()) {
                    if (problem.isCallbackCallee(srcStmt, method)) return result;
                    for (let index = 0; index < args.length; index++) {
                        const argument = args[index];
                        const kind = argument instanceof NullConstant
                            ? NullnessKind.Null
                            : argument instanceof UndefinedConstant
                                ? NullnessKind.Undefined
                                : null;
                        if (!kind) continue;
                        const parameterLocal = problem.getParameterLocal(method, index);
                        if (!parameterLocal) continue;
                        result.add(NullnessFact.create(
                            NullnessAccessPath.fromValue(parameterLocal),
                            kind,
                            {
                                kind: kind === NullnessKind.Null
                                    ? NullnessOriginKind.NullLiteral
                                    : NullnessOriginKind.UndefinedLiteral,
                                stmt: srcStmt,
                                description: `${kind} literal passed to parameter ${index}`,
                            }
                        ));
                    }
                    return result;
                }

                for (const binding of problem.getCallBindings(srcStmt, method)) {
                    const fields = problem.getRemainingCallFields(binding.caller, fact.accessPath);
                    if (!fields) continue;
                    if (binding.argumentIndex !== undefined && fields.length === 0) {
                        const accesses = problem.getSourceAccessMatches(srcStmt, binding.caller, null, binding.argumentIndex);
                        const nullish = (mayBeNull(fact.kind) ? NULL : 0) | (mayBeUndefined(fact.kind) ? UNDEFINED : 0);
                        if (accesses.length && accesses.every(access => (nullish & ~access.excluded) === 0)) continue;
                    }
                    // A normal receiver edge already proves the receiver is
                    // non-null; only its fields belong in the callee.
                    if (!binding.parameter && fields.length === 0) continue;
                    result.add(fact.deriveWithNewAccessPath(new NullnessAccessPath(
                        binding.callee, binding.callee.getType(), fields
                    ), srcStmt));
                }

                for (const asyncFact of problem.mapAsyncBoundaryFactToCallee(
                    srcStmt,
                    method,
                    fact
                )) {
                    result.add(asyncFact);
                }

                for (const closureFact of problem.mapCapturedFactToCallee(
                    args,
                    method,
                    fact,
                    srcStmt
                )) {
                    result.add(closureFact);
                }

                return result;
            },
        };
    }

    getExitToReturnFlowFunction(srcStmt: Stmt, _tgtStmt: Stmt, callStmt: Stmt): FlowFunction<NullnessFact> {
        const problem = this;
        return {
            getDataFacts(fact: NullnessFact): Set<NullnessFact> {
                const result = new Set<NullnessFact>();
                const callTargetPath = callStmt instanceof ArkAssignStmt
                    ? NullnessAccessPath.fromValue(callStmt.getLeftOp())
                    : NullnessAccessPath.getEmptyAccessPath();
                const returnTargetPath = problem.isPromiseContinuation(callStmt) &&
                    !callTargetPath.isEmpty()
                    ? callTargetPath.appendPromisePayload()
                    : callTargetPath;

                if (fact.isZeroFact()) {
                    result.add(fact);
                    // A call-site summary joins all normal return alternatives
                    // (and may select a non-null overload).  Do not re-introduce
                    // one individual `return null` as a definite fact on the
                    // exit edge after that joined contract has been applied on
                    // the call-to-return edge.
                    const returnedKind = !problem.libraryRegistry.shouldSuppressLiteralReturn(
                        callStmt,
                        fact
                    ) &&
                        srcStmt instanceof ArkReturnStmt
                        ? problem.getLiteralNullnessKind(srcStmt.getOp())
                        : null;
                    if (returnedKind && problem.isTrackableAccessPath(returnTargetPath)) {
                        result.add(NullnessFact.create(
                            returnTargetPath,
                            returnedKind,
                            {
                                kind: returnedKind === NullnessKind.Null
                                    ? NullnessOriginKind.NullLiteral
                                    : NullnessOriginKind.UndefinedLiteral,
                                stmt: srcStmt,
                                description: `returned the ${returnedKind} literal`,
                            }
                        ));
                    }
                    return result;
                }

                for (const returnedFact of problem.mapHeapFactToCaller(srcStmt, callStmt, fact)) {
                    result.add(returnedFact);
                }

                if (srcStmt instanceof ArkReturnStmt &&
                    !problem.libraryRegistry.shouldSuppressLiteralReturn(
                        callStmt,
                        problem.zeroFact
                    ) &&
                    problem.isTrackableAccessPath(returnTargetPath)) {
                    const returnedPath = NullnessAccessPath.fromValue(srcStmt.getOp());
                    if (!returnedPath.isEmpty() && returnedPath.isPrefixOf(fact.accessPath)) {
                        const remainingFields = fact.accessPath.remainingFieldsAfter(returnedPath);
                        const mappedPath = new NullnessAccessPath(
                            returnTargetPath.base,
                            returnTargetPath.baseType,
                            [...returnTargetPath.fields, ...remainingFields],
                            returnTargetPath.isStatic
                        );
                        if (problem.isTrackableAccessPath(mappedPath)) {
                            result.add(fact.deriveWithNewAccessPath(mappedPath, callStmt));
                        }
                    }
                }

                return result;
            },
        };
    }

    getCallToReturnFlowFunction(
        srcStmt: Stmt,
        _tgtStmt: Stmt,
        callees?: ReadonlySet<ArkMethod>
    ): FlowFunction<NullnessFact> {
        const problem = this;
        return {
            getDataFacts(fact: NullnessFact): Set<NullnessFact> {
                if (fact.isZeroFact()) {
                    problem.checkTypedNonNullArguments(srcStmt);
                    problem.checkLateNullGuard(srcStmt);
                }
                const result = problem.libraryRegistry.getCallToReturnFacts(srcStmt, fact);
                if (!fact.isZeroFact()) {
                    problem.checkDirectDereference(srcStmt, fact);
                    if (srcStmt instanceof ArkAssignStmt &&
                        problem.definesAccessPath(srcStmt, fact.accessPath)) {
                        return result;
                    }
                    if (problem.shouldRouteHeapFactThroughCallees(
                        srcStmt,
                        fact,
                        callees
                    )) {
                        return result;
                    }
                }
                result.add(fact);
                return result;
            },
        };
    }

    getExceptionalFlowFunction(
        srcStmt: Stmt,
        handlerStmt: Stmt
    ): FlowFunction<NullnessFact> {
        return this.createExceptionalFlowFunction(srcStmt, handlerStmt);
    }

    getCallToExceptionalReturnFlowFunction(
        srcStmt: Stmt,
        _handlerStmt: Stmt,
        callees?: ReadonlySet<ArkMethod>,
        fromCallee = false
    ): FlowFunction<NullnessFact> {
        const problem = this;
        return {
            getDataFacts(fact: NullnessFact): Set<NullnessFact> {
                if (fact.isZeroFact()) {
                    problem.checkTypedNonNullArguments(srcStmt);
                    problem.checkLateNullGuard(srcStmt);
                } else {
                    problem.checkDirectDereference(srcStmt, fact);
                    if (fromCallee && problem.shouldRouteHeapFactThroughCallees(srcStmt, fact, callees)) {
                        return new Set();
                    }
                }
                return new Set([fact]);
            },
        };
    }

    getExceptionalExitToReturnFlowFunction(
        exitStmt: Stmt,
        handlerStmt: Stmt,
        callStmt: Stmt
    ): FlowFunction<NullnessFact> {
        const problem = this;
        const exceptionalFlow = this.createExceptionalFlowFunction(exitStmt, handlerStmt);
        return { getDataFacts(fact: NullnessFact): Set<NullnessFact> {
            const result = problem.mapHeapFactToCaller(exitStmt, callStmt, fact);
            if (fact.isZeroFact()) result.add(fact);
            for (const caughtFact of exceptionalFlow.getDataFacts(fact)) {
                if (caughtFact !== fact) result.add(caughtFact);
            }
            return result;
        } };
    }

    createZeroValue(): NullnessFact {
        return this.zeroFact;
    }

    getEntryPoint(): Stmt {
        return this.entryPoint;
    }

    getEntryMethod(): ArkMethod {
        return this.entryMethod;
    }

    factEqual(left: NullnessFact, right: NullnessFact): boolean {
        return left.equals(right);
    }

    factHash(fact: NullnessFact): number {
        return fact.hashCode();
    }

    getConfig(): Readonly<Required<NullnessAnalysisConfig>> {
        return this.config;
    }

    private createExceptionalFlowFunction(
        srcStmt: Stmt,
        handlerStmt: Stmt
    ): FlowFunction<NullnessFact> {
        const problem = this;
        return {
            getDataFacts(fact: NullnessFact): Set<NullnessFact> {
                const result = new Set<NullnessFact>([fact]);
                if (!(srcStmt instanceof ArkThrowStmt)) {
                    if (fact.isZeroFact()) {
                        problem.checkTypedNonNullArguments(srcStmt);
                        problem.checkLateNullGuard(srcStmt);
                    } else {
                        problem.checkDirectDereference(srcStmt, fact);
                    }
                    return result;
                }

                const caughtPath = problem.getCaughtExceptionPath(handlerStmt);
                if (caughtPath.isEmpty()) return result;
                const thrownValue = srcStmt.getOp();
                if (fact.isZeroFact()) {
                    const kind = problem.getLiteralNullnessKind(thrownValue);
                    if (kind) {
                        result.add(NullnessFact.create(caughtPath, kind, {
                            kind: kind === NullnessKind.Null
                                ? NullnessOriginKind.NullLiteral
                                : NullnessOriginKind.UndefinedLiteral,
                            stmt: srcStmt,
                            description: `${kind} value thrown into catch`,
                        }));
                    }
                    return result;
                }

                const thrownPath = NullnessAccessPath.fromValue(thrownValue);
                if (thrownPath.isEmpty() ||
                    !thrownPath.isPrefixOf(fact.accessPath)) {
                    return result;
                }
                const remainingFields = fact.accessPath
                    .remainingFieldsAfter(thrownPath);
                result.add(fact.deriveWithNewAccessPath(
                    new NullnessAccessPath(
                        caughtPath.base,
                        caughtPath.baseType,
                        [...caughtPath.fields, ...remainingFields]
                    ),
                    srcStmt
                ));
                return result;
            },
        };
    }

    private getCaughtExceptionPath(handlerStmt: Stmt): NullnessAccessPath {
        if (!(handlerStmt instanceof ArkAssignStmt) ||
            !(handlerStmt.getRightOp() instanceof ArkCaughtExceptionRef)) {
            return NullnessAccessPath.getEmptyAccessPath();
        }
        return NullnessAccessPath.fromValue(handlerStmt.getLeftOp());
    }

    getNullDereferences(): readonly NullDereferenceDiagnostic[] {
        return this.nullDereferences;
    }

    private createNullishLiteralFact(stmt: Stmt): NullnessFact | null {
        if (!(stmt instanceof ArkAssignStmt)) {
            return null;
        }

        const rightOp = stmt.getRightOp();
        const kind = this.getLiteralNullnessKind(rightOp);
        if (!kind) {
            return null;
        }

        const accessPath = NullnessAccessPath.fromValue(stmt.getLeftOp());
        if (!this.isTrackableAccessPath(accessPath)) {
            return null;
        }
        // A required ArkUI component property is supplied by the framework
        // before build() runs. Its source-level `= undefined` is only a
        // declaration placeholder, not a reachable component-entry value.
        if (this.isRequiredComponentField(stmt, accessPath)) {
            return null;
        }

        return NullnessFact.create(accessPath, kind, {
            kind: kind === NullnessKind.Null
                ? NullnessOriginKind.NullLiteral
                : NullnessOriginKind.UndefinedLiteral,
            stmt,
            description: `assigned the ${kind} literal`,
        });
    }

    /** Seed nullable reads whose platform contract is not represented as a call summary. */
    private createKnownNullableFieldReadFact(stmt: Stmt): NullnessFact | null {
        if (!(stmt instanceof ArkAssignStmt)) return null;
        const rightOp = stmt.getRightOp();
        if (!(rightOp instanceof ArkInstanceFieldRef)) return null;

        const signature = rightOp.getFieldSignature();
        if (signature.getFieldName() !== 'stack' || signature.getBaseName() !== 'Error') {
            return null;
        }
        const accessPath = NullnessAccessPath.fromValue(stmt.getLeftOp());
        if (!this.isTrackableAccessPath(accessPath)) return null;

        return NullnessFact.create(accessPath, NullnessKind.MaybeUndefined, {
            kind: NullnessOriginKind.LibraryModel,
            stmt,
            description: 'nullable Error.stack field read',
        });
    }

    private getLiteralNullnessKind(value: unknown): NullnessKind | null {
        return value instanceof NullConstant
            ? NullnessKind.Null
            : value instanceof UndefinedConstant
                ? NullnessKind.Undefined
                : null;
    }

    private isTrackableAccessPath(accessPath: NullnessAccessPath): boolean {
        // Overlong paths are conservatively folded to a wildcard suffix by the
        // solver. Dropping them here would make the depth bound under-approximate.
        return !accessPath.isEmpty() && !accessPath.isZero();
    }

    private shouldRouteHeapFactThroughCallees(
        callStmt: Stmt,
        fact: NullnessFact,
        callees?: ReadonlySet<ArkMethod>
    ): boolean {
        if (!callees || callees.size === 0 ||
            fact.accessPath.fields.length === 0) {
            return false;
        }
        return [...callees].every(callee => callee.getCfg() && !this.isCallbackCallee(callStmt, callee) &&
            (fact.accessPath.isStaticFieldRef() || this.getCallBindings(callStmt, callee).some(binding =>
                binding.stable && (this.getRemainingCallFields(binding.caller, fact.accessPath)?.length ?? 0) > 0)));
    }

    private getCallBindings(callStmt: Stmt, method: ArkMethod): readonly NullnessCallBinding[] {
        let byMethod = this.callBindings.get(callStmt);
        if (!byMethod) this.callBindings.set(callStmt, byMethod = new WeakMap());
        const cached = byMethod.get(method);
        if (cached) return cached;
        const bindings: NullnessCallBinding[] = [];
        const invoke = callStmt.getInvokeExpr();
        const callback = this.isCallbackCallee(callStmt, method);
        const calleeThis = this.getThisLocal(method);
        let receiver: Local | undefined;
        if (invoke instanceof ArkInstanceInvokeExpr && !callback) {
            receiver = invoke.getBase();
        } else if (this.sourceSemantics.isArrowMethod(method)) {
            const caller = callStmt.getCfg()?.getDeclaringMethod();
            if (caller && this.getLexicalReceiverOwner(caller) === this.getLexicalReceiverOwner(method)) {
                receiver = this.getThisLocal(caller) ?? undefined;
            }
        }
        if (receiver && calleeThis) bindings.push({
            caller: NullnessAccessPath.fromValue(receiver),
            callee: calleeThis, parameter: false, stable: true,
        });
        if (!callback) invoke?.getArgs().forEach((argument, index) => {
            const local = this.getParameterLocal(method, index);
            const path = NullnessAccessPath.fromValue(argument);
            if (local && !path.isEmpty()) bindings.push({ caller: path, callee: local,
                parameter: true, argumentIndex: index, stable: !this.getReassignedLocals(method).has(local) });
        });
        byMethod.set(method, bindings);
        return bindings;
    }

    private getRemainingCallFields(caller: NullnessAccessPath, fact: NullnessAccessPath) {
        if (caller.isPrefixOf(fact)) return fact.remainingFieldsAfter(caller);
        const canonicalCaller = this.canonicalAccessPath(caller, new Set(), true);
        const canonicalFact = this.canonicalAccessPath(fact, new Set(), true);
        if (!canonicalCaller.isPrefixOf(canonicalFact)) return null;
        const fields = canonicalFact.remainingFieldsAfter(canonicalCaller);
        return fields.length === 0 && caller.isLocal() !== fact.isLocal() ? null : fields;
    }

    private isCallbackCallee(callStmt: Stmt, method: ArkMethod): boolean {
        const invoke = callStmt.getInvokeExpr();
        return !!invoke && !haveSameCallableIdentity(invoke.getMethodSignature(), method.getSignature()) &&
            this.isFunctionArgumentCallee(invoke.getArgs(), method);
    }

    private getLexicalReceiverOwner(method: ArkMethod): ArkMethod {
        while (this.sourceSemantics.isArrowMethod(method) && method.getOuterMethod()) method = method.getOuterMethod()!;
        return method;
    }

    private getReassignedLocals(method: ArkMethod): ReadonlySet<Local> {
        let reassigned = this.reassignedLocals.get(method);
        if (!reassigned) {
            const defined = new Set<Local>();
            const repeated = new Set<Local>();
            for (const stmt of method.getCfg()?.getStmts() ?? []) {
                const local = stmt.getDef();
                if (!(local instanceof Local)) continue;
                if (defined.has(local)) repeated.add(local);
                defined.add(local);
            }
            this.reassignedLocals.set(method, reassigned = repeated);
        }
        return reassigned;
    }

    private mapHeapFactToCaller(exitStmt: Stmt, callStmt: Stmt, fact: NullnessFact): Set<NullnessFact> {
        const result = new Set<NullnessFact>();
        if (fact.accessPath.isStaticFieldRef()) result.add(fact);
        const method = exitStmt.getCfg()?.getDeclaringMethod();
        if (!method || fact.accessPath.fields.length === 0) return result;
        for (const binding of this.getCallBindings(callStmt, method)) {
            // A reassigned formal denotes a replacement object, not the caller's object.
            if (!binding.stable || fact.accessPath.base !== binding.callee) continue;
            result.add(fact.deriveWithNewAccessPath(new NullnessAccessPath(
                binding.caller.base, binding.caller.baseType,
                [...binding.caller.fields, ...fact.accessPath.fields], binding.caller.isStatic
            ), callStmt));
        }
        return result;
    }

    /**
     * Maps a caller fact captured by a lexical-environment argument to the
     * corresponding ClosureFieldRef at the callee entry.
     *
     * ArkIR lowers a nested call as `inner(%closuresN)` and starts the nested
     * method with `captured = %closuresN.captured`.  Seeding the field fact lets
     * the ordinary assignment transfer create the callee-local fact, including
     * for another nested closure level.
     */
    private mapCapturedFactToCallee(
        args: readonly Value[],
        callee: ArkMethod,
        fact: NullnessFact,
        callStmt: Stmt
    ): Set<NullnessFact> {
        const result = new Set<NullnessFact>();
        for (const argument of args) {
            const argumentType = argument.getType();
            if (!(argumentType instanceof LexicalEnvType)) {
                continue;
            }

            for (const capturedLocal of argumentType.getClosures()) {
                const callerPath = NullnessAccessPath.fromValue(capturedLocal);
                if (callerPath.isEmpty() || !callerPath.isPrefixOf(fact.accessPath)) {
                    continue;
                }

                const calleeClosureRef = this.findCapturedClosureRef(
                    callee,
                    capturedLocal.getName(),
                    capturedLocal
                );
                if (!calleeClosureRef) {
                    continue;
                }
                const closurePath = NullnessAccessPath.fromValue(calleeClosureRef);
                const remainingFields = fact.accessPath.remainingFieldsAfter(callerPath);
                const mappedPath = new NullnessAccessPath(
                    closurePath.base,
                    closurePath.baseType,
                    [...closurePath.fields, ...remainingFields],
                    closurePath.isStatic
                );
                if (this.isTrackableAccessPath(mappedPath)) {
                    result.add(fact.deriveWithNewAccessPath(mappedPath, callStmt));
                }
            }
        }
        return result;
    }

    private mapAsyncBoundaryFactToCallee(
        callStmt: Stmt,
        callee: ArkMethod,
        fact: NullnessFact
    ): Set<NullnessFact> {
        const result = new Set<NullnessFact>();
        const invoke = callStmt.getInvokeExpr();
        if (!invoke || !this.isExecutableAsyncBoundary(callStmt) ||
            !this.isFunctionArgumentCallee(invoke.getArgs(), callee)) {
            return result;
        }

        const capturedLocal = fact.accessPath.base;
        if (capturedLocal instanceof Local) {
            const closureRef = this.findCapturedClosureRef(callee, capturedLocal.getName(), capturedLocal);
            if (closureRef) {
                const closurePath = NullnessAccessPath.fromValue(closureRef);
                const mappedPath = new NullnessAccessPath(
                    closurePath.base,
                    closurePath.baseType,
                    [...closurePath.fields, ...fact.accessPath.fields],
                    closurePath.isStatic
                );
                if (this.isTrackableAccessPath(mappedPath)) {
                    result.add(fact.deriveWithNewAccessPath(mappedPath, callStmt));
                }
            }
        }

        if (!this.isPromiseThen(callStmt)) {
            return result;
        }
        const instanceInvoke = invoke instanceof ArkInstanceInvokeExpr ? invoke : null;
        if (!instanceInvoke) return result;
        const receiverPayload = NullnessAccessPath.fromValue(
            instanceInvoke.getBase()
        ).appendPromisePayload();
        if (!receiverPayload.isPrefixOf(fact.accessPath)) {
            return result;
        }
        const parameter = this.getParameterLocal(callee, 0);
        if (!parameter) return result;
        const remainingFields = fact.accessPath.remainingFieldsAfter(receiverPayload);
        result.add(fact.deriveWithNewAccessPath(new NullnessAccessPath(
            parameter,
            parameter.getType(),
            remainingFields
        ), callStmt));
        return result;
    }

    private isFunctionArgumentCallee(args: readonly Value[], callee: ArkMethod): boolean {
        const signature = callee.getSignature();
        return args.some(argument => {
            const type = argument.getType();
            return type instanceof FunctionType &&
                haveSameCallableIdentity(type.getMethodSignature(), signature);
        });
    }

    private isPromiseThen(stmt: Stmt): boolean {
        return stmt.getInvokeExpr()?.getMethodSignature()
            .getMethodSubSignature().getMethodName() === 'then';
    }

    private isPromiseContinuation(stmt: Stmt): boolean {
        const methodName = stmt.getInvokeExpr()?.getMethodSignature()
            .getMethodSubSignature().getMethodName();
        return methodName === 'then' || methodName === 'catch' || methodName === 'finally';
    }

    private isExecutableAsyncBoundary(stmt: Stmt): boolean {
        const methodName = stmt.getInvokeExpr()?.getMethodSignature()
            .getMethodSubSignature().getMethodName();
        return methodName === 'then' || methodName === 'catch' || methodName === 'finally' ||
            methodName === 'setTimeout' || methodName === 'setInterval';
    }

    private findCapturedClosureRef(callee: ArkMethod, capturedName: string, capturedLocal?: Local): ClosureFieldRef | null {
        const startingBlock = callee.getCfg()?.getStartingBlock();
        if (!startingBlock) {
            return null;
        }
        for (const stmt of startingBlock.getStmts()) {
            if (!(stmt instanceof ArkAssignStmt)) {
                continue;
            }
            const rightOp = stmt.getRightOp();
            if (rightOp instanceof ClosureFieldRef && rightOp.getFieldName() === capturedName) {
                const environment = rightOp.getBase().getType();
                if (capturedLocal && environment instanceof LexicalEnvType &&
                    !environment.getClosures().includes(capturedLocal)) continue;
                return rightOp;
            }
        }
        return null;
    }

    private definesAccessPath(stmt: ArkAssignStmt, accessPath: NullnessAccessPath): boolean {
        const definedPath = NullnessAccessPath.fromValue(stmt.getLeftOp());
        if (definedPath.isEmpty()) return false;
        const rightOp = stmt.getRightOp();
        // Method-entry identity bindings and closure loads establish aliases;
        // they are not writes to the underlying receiver/captured storage.
        const isEntryBinding = rightOp instanceof ArkThisRef ||
            rightOp instanceof ArkParameterRef || rightOp instanceof ClosureFieldRef;
        if (isEntryBinding) return false;
        // A strong update kills the assigned storage cell and every fact rooted
        // below it.  Captured locals need the alias check as well: ArkIR loads a
        // closure field into a Local at callback entry, so assigning that Local
        // must also kill the stale `%closuresN.field` representation.
        if (definedPath.equals(accessPath)) return true;
        if (definedPath.isLocal() && definedPath.base === accessPath.base &&
            definedPath.isPrefixOf(accessPath)) {
            return true;
        }
        return (definedPath.fields.length > 0 && definedPath.isPrefixOf(accessPath)) ||
            this.accessPathsAlias(definedPath, accessPath);
    }

    private narrowFactOnBranch(
        srcStmt: Stmt,
        tgtStmt: Stmt,
        fact: NullnessFact
    ): NullnessFact | null {
        if (!(srcStmt instanceof ArkIfStmt)) {
            return fact;
        }
        const branchTruth = this.getBranchTruth(srcStmt, tgtStmt);
        if (branchTruth === undefined) {
            return fact;
        }

        return this.narrowFactForBooleanValue(
            srcStmt.getConditionExpr(),
            branchTruth,
            fact,
            srcStmt,
            new Set()
        );
    }

    private narrowFactForBooleanValue(
        value: unknown,
        expectedTruth: boolean,
        fact: NullnessFact,
        branchStmt: ArkIfStmt,
        visited: Set<unknown>
    ): NullnessFact | null {
        if (!value || visited.has(value)) {
            return fact;
        }
        visited.add(value);

        if (value instanceof ArkUnopExpr && value.getOperator() === UnaryOperator.LogicalNot) {
            return this.narrowFactForBooleanValue(
                value.getOp(),
                !expectedTruth,
                fact,
                branchStmt,
                visited
            );
        }

        // `value instanceof Type` is true only for a non-null object. ArkIR
        // frequently stores this predicate in a boolean Local; the Local case
        // below recursively reaches this expression.
        if (value instanceof ArkInstanceOfExpr) {
            const checkedPath = NullnessAccessPath.fromValue(value.getOp());
            if (expectedTruth && !checkedPath.isEmpty() &&
                this.accessPathsAlias(checkedPath, fact.accessPath, branchStmt)) {
                return null;
            }
            return fact;
        }

        if ((value instanceof ArkStaticInvokeExpr || value instanceof ArkInstanceInvokeExpr) && expectedTruth) {
            const signature = value.getMethodSignature();
            const owner = signature.getDeclaringClassSignature();
            if (owner.getClassName() === 'ArrayConstructor' &&
                owner.getDeclaringFileSignature().getFileName() === 'lib.es5.d.ts' &&
                signature.getMethodSubSignature().getMethodName() === 'isArray') {
                const argument = value.getArgs()[0];
                if (argument instanceof Local &&
                    !this.getReassignedLocals(branchStmt.getCfg()!.getDeclaringMethod()).has(argument) &&
                    fact.accessPath.equals(NullnessAccessPath.fromValue(argument))) return null;
            }
        }

        // A truthy value cannot be null or undefined.  ArkIR commonly keeps
        // guards such as `if (value)` as a Local, or as a temporary Local whose
        // defining assignment reads a field.  Nullness facts only represent the
        // nullish alternatives, so the truthy edge kills the matching fact.
        const truthinessPath = NullnessAccessPath.fromValue(value as Value);
        if (!truthinessPath.isEmpty() &&
            (this.accessPathsAlias(truthinessPath, fact.accessPath, branchStmt) ||
                truthinessPath.isLocal() === fact.accessPath.isLocal() &&
                this.canonicalAccessPath(fact.accessPath, new Set()).isPrefixOf(
                    this.canonicalAccessPath(truthinessPath, new Set())
                ))) {
            if (!expectedTruth) {
                return fact;
            }
            const narrowedKind = removeNullish(fact.kind);
            return narrowedKind
                ? fact.deriveWithKind(narrowedKind, branchStmt)
                : null;
        }

        if (value instanceof Local) {
            const declaringStmt = value.getDeclaringStmt();
            if (declaringStmt instanceof ArkAssignStmt) {
                // Value copies are snapshots. Only predicate expressions may
                // be re-evaluated here; chasing a field load would read its new value.
                if (!NullnessAccessPath.fromValue(declaringStmt.getRightOp()).isEmpty()) return fact;
                return this.narrowFactForBooleanValue(
                    declaringStmt.getRightOp(),
                    expectedTruth,
                    fact,
                    branchStmt,
                    visited
                );
            }
            return fact;
        }

        if (value instanceof ArkNormalBinopExpr) {
            const operator = value.getOperator();
            const shouldNarrowBoth =
                (operator === NormalBinaryOperator.LogicalAnd && expectedTruth) ||
                (operator === NormalBinaryOperator.LogicalOr && !expectedTruth);
            if (!shouldNarrowBoth) {
                return fact;
            }
            const afterFirst = this.narrowFactForBooleanValue(
                value.getOp1(),
                expectedTruth,
                fact,
                branchStmt,
                new Set(visited)
            );
            return afterFirst
                ? this.narrowFactForBooleanValue(
                    value.getOp2(),
                    expectedTruth,
                    afterFirst,
                    branchStmt,
                    new Set(visited)
                )
                : null;
        }

        if (!(value instanceof ArkConditionExpr)) {
            return fact;
        }

        const operator = value.getOperator();
        const equalityOperator = operator === RelationalBinaryOperator.Equality ||
            operator === RelationalBinaryOperator.StrictEquality;
        const inequalityOperator = operator === RelationalBinaryOperator.InEquality ||
            operator === RelationalBinaryOperator.StrictInequality;
        if (!equalityOperator && !inequalityOperator) {
            return fact;
        }

        const op1 = value.getOp1();
        const op2 = value.getOp2();
        const assignedValue = (operand: Value): Value => {
            const declaration = operand instanceof Local ? operand.getDeclaringStmt() : undefined;
            return declaration instanceof ArkAssignStmt ? declaration.getRightOp() : operand;
        };
        const left = assignedValue(op1);
        const right = assignedValue(op2);
        const typeOf = left instanceof ArkTypeOfExpr ? left : right instanceof ArkTypeOfExpr ? right : undefined;
        const typeName = left instanceof StringConstant ? left : right instanceof StringConstant ? right : undefined;
        const checked = typeOf?.getOp();
        if (checked instanceof Local && typeName &&
            !this.getReassignedLocals(branchStmt.getCfg()!.getDeclaringMethod()).has(checked) &&
            fact.accessPath.equals(NullnessAccessPath.fromValue(checked))) {
            const equal = equalityOperator ? expectedTruth : !expectedTruth;
            const name = typeName.getValue();
            let kind: NullnessKind | null = fact.kind;
            if (name === 'undefined') kind = equal ? keepOnlyUndefined(kind) : removeUndefined(kind);
            else if (name === 'object') kind = equal ? removeUndefined(kind) : removeNull(kind);
            else if (equal && ['string', 'number', 'boolean', 'function', 'symbol', 'bigint'].includes(name)) {
                kind = removeNullish(kind);
            }
            return kind === fact.kind ? fact : kind ? fact.deriveWithKind(kind, branchStmt) : null;
        }
        const booleanOperand = op1 instanceof BooleanConstant
            ? op1
            : op2 instanceof BooleanConstant
                ? op2
                : null;
        if (booleanOperand) {
            const comparedValue = booleanOperand === op1 ? op2 : op1;
            const equalityHolds = equalityOperator ? expectedTruth : !expectedTruth;
            const booleanValue = booleanOperand.getValue() === 'true';
            return this.narrowFactForBooleanValue(
                comparedValue,
                equalityHolds ? booleanValue : !booleanValue,
                fact,
                branchStmt,
                visited
            );
        }

        // ArkAnalyzer lowers ordinary truthiness checks to comparisons with a
        // type-specific falsy sentinel, for example `value != 0` for objects and
        // `value != ''` for strings.  Recover the source-level truthiness guard
        // so aliases loaded from fields are narrowed on the protected edge too.
        // A loose boolean comparison with 0/'' is a truth test even when
        // another part of the source condition contains an explicit comparison.
        const looseBooleanTest = (operator === RelationalBinaryOperator.Equality ||
            operator === RelationalBinaryOperator.InEquality) &&
            ((op1.getType() instanceof BooleanType && isNumericFalsySentinel(op2)) ||
                (op2.getType() instanceof BooleanType && isNumericFalsySentinel(op1)));
        const truthTest = looseBooleanTest || this.isLoweredTruthinessGuard(branchStmt);
        const falsyOperand = truthTest && isFalsySentinel(op1)
            ? op1
            : truthTest && isFalsySentinel(op2)
                ? op2
                : null;
        if (falsyOperand) {
            const comparedValue = falsyOperand === op1 ? op2 : op1;
            const equalityHolds = equalityOperator ? expectedTruth : !expectedTruth;
            return this.narrowFactForBooleanValue(
                comparedValue,
                !equalityHolds,
                fact,
                branchStmt,
                visited
            );
        }

        const nullishOperand = op1 instanceof NullConstant || op1 instanceof UndefinedConstant
            ? op1
            : op2 instanceof NullConstant || op2 instanceof UndefinedConstant
                ? op2
                : null;
        if (!nullishOperand) {
            return fact;
        }
        const comparedValue = nullishOperand === op1 ? op2 : op1;
        const comparedPath = NullnessAccessPath.fromValue(comparedValue);
        if (comparedPath.isEmpty() ||
            !this.accessPathsAlias(comparedPath, fact.accessPath, branchStmt)) {
            return fact;
        }

        const equalityHolds = equalityOperator ? expectedTruth : !expectedTruth;
        const strictComparison = operator === RelationalBinaryOperator.StrictEquality ||
            operator === RelationalBinaryOperator.StrictInequality;
        let narrowedKind: NullnessKind | null;
        if (!strictComparison) {
            // JavaScript/ArkTS loose null equality matches both null and undefined.
            narrowedKind = equalityHolds
                ? fact.kind
                : removeNullish(fact.kind);
        } else if (nullishOperand instanceof NullConstant) {
            narrowedKind = equalityHolds ? keepOnlyNull(fact.kind) : removeNull(fact.kind);
        } else {
            narrowedKind = equalityHolds ? keepOnlyUndefined(fact.kind) : removeUndefined(fact.kind);
        }

        if (!narrowedKind) {
            return null;
        }
        return narrowedKind === fact.kind ? fact : fact.deriveWithKind(narrowedKind, branchStmt);
    }

    private getBranchTruth(srcStmt: ArkIfStmt, tgtStmt: Stmt): boolean | undefined {
        const cfg = srcStmt.getCfg();
        if (!cfg) {
            return undefined;
        }
        const index = this.getCfgIndex(cfg);
        const sourceBlock = index.get(srcStmt);
        const targetBlock = index.get(tgtStmt);
        if (!sourceBlock || !targetBlock) {
            return undefined;
        }
        const successors = sourceBlock.getSuccessors();
        if (successors.length !== 2 || successors[0] === successors[1]) {
            return undefined;
        }
        if (successors[0] === targetBlock) {
            return true;
        }
        if (successors[1] === targetBlock) {
            return false;
        }
        return undefined;
    }

    private isLoweredTruthinessGuard(stmt: ArkIfStmt): boolean {
        return !!stmt.getOriginalText?.() && !this.sourceSemantics.isEqualityCondition(stmt);
    }

    private propagateAssignment(stmt: ArkAssignStmt, fact: NullnessFact): Set<NullnessFact> {
        const result = new Set<NullnessFact>();
        const rightOp = stmt.getRightOp();
        const leftPath = NullnessAccessPath.fromValue(stmt.getLeftOp());
        if (leftPath.isEmpty() || leftPath.isZero()) {
            return result;
        }

        if (rightOp instanceof ArkNormalBinopExpr &&
            rightOp.getOperator() === NormalBinaryOperator.NullishCoalescing) {
            const fallbackPath = NullnessAccessPath.fromValue(rightOp.getOp2());
            if (!fallbackPath.isEmpty() && fallbackPath.isPrefixOf(fact.accessPath)) {
                const remainingFields = fact.accessPath.remainingFieldsAfter(fallbackPath);
                result.add(fact.deriveWithNewAccessPath(
                    new NullnessAccessPath(
                        leftPath.base,
                        leftPath.baseType,
                        [...leftPath.fields, ...remainingFields],
                        leftPath.isStatic
                    ),
                    stmt
                ));
            }
            return result;
        }

        if (rightOp instanceof ArkInstanceFieldRef && this.isOptionalChainStmt(stmt)) {
            const receiverPath = NullnessAccessPath.fromValue(rightOp.getBase());
            if (receiverPath.equals(fact.accessPath)) {
                result.add(fact
                    .deriveWithNewAccessPath(leftPath, stmt)
                    .deriveWithKind(NullnessKind.Undefined, stmt));
            }
        }

        // ArkIR keeps `await` as an explicit wrapper around the value produced by
        // the async call. Until Promise payload summaries are introduced, unwrap
        // this ordinary IR node so project-defined async returns keep their facts.
        const propagatedValue = rightOp instanceof ArkAwaitExpr
            ? rightOp.getPromise()
            : rightOp instanceof ArkCastExpr
                ? rightOp.getOp()
                : rightOp;
        const rightPath = NullnessAccessPath.fromValue(propagatedValue);
        if (rightPath.isEmpty() || !rightPath.isPrefixOf(fact.accessPath)) {
            return result;
        }

        const remainingFields = fact.accessPath.remainingFieldsAfter(rightPath);
        const mappedPath = new NullnessAccessPath(
            leftPath.base,
            leftPath.baseType,
            [...leftPath.fields, ...remainingFields],
            leftPath.isStatic
        );
        const declaringMethod = stmt.getCfg()?.getDeclaringMethod();
        if (leftPath.fields.length > 0 && rightPath.isLocal() &&
            declaringMethod?.getName().startsWith('%AM')) {
            result.add(NullnessFact.create(mappedPath, fact.kind, {
                kind: fact.origin?.kind ?? NullnessOriginKind.Unknown,
                stmt,
                description: 'nullable callback value assigned to a field',
            }));
        } else {
            result.add(fact.deriveWithNewAccessPath(mappedPath, stmt));
        }
        return result;
    }

    private checkDirectDereference(stmt: Stmt, fact: NullnessFact): void {
        if ((!mayBeNull(fact.kind) && !mayBeUndefined(fact.kind)) ||
            !fact.origin || typeof stmt.getUses !== 'function') {
            return;
        }
        if (fact.isUnresolvedEvidence() && !this.config.reportUnresolvedReturns) {
            return;
        }
        const info = this.getStatementInfo(stmt);
        const isReceiverDereference = info.receivers.some(receiver =>
            this.accessPathsAlias(receiver.path, fact.accessPath) &&
            this.isReportableSourceUse(stmt, receiver.path, receiver.member, undefined, fact)
        );
        const isNonNullArgumentUse = info.arguments.some(argument =>
            this.accessPathsAlias(argument.path, fact.accessPath) &&
            this.isReportableSourceUse(stmt, argument.path, null, argument.index, fact)
        );
        if (!isReceiverDereference && !isNonNullArgumentUse) return;
        if (stmt instanceof ArkIfStmt &&
            this.isDereferenceProtectedByShortCircuit(stmt.getConditionExpr(), fact, stmt)) {
            return;
        }
        if (this.isInitializedByEveryConcreteSubclass(stmt, fact)) {
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
            confidence: fact.isUnresolvedEvidence() || fact.isApproximateEvidence()
                ? 'low'
                : 'high',
        });
    }

    /**
     * Detect `value!.field || value === undefined` before fact propagation.
     * The right operand cannot protect a dereference already evaluated by the
     * left operand, even when no explicit nullish assignment is reachable.
     */
    private checkLateNullGuard(stmt: Stmt): void {
        const info = this.getStatementInfo(stmt);
        for (const access of info.accesses) {
            if (!access.asserted || !access.checkedLater || access.optional ||
                (access.excluded & access.checkedLater) === access.checkedLater) continue;
            const receiver = info.receivers.find(receiver =>
                receiver.member === access.member &&
                this.renderSourceAccessPath(receiver.path) === access.receiver);
            if (!receiver) continue;
            const accessPath = this.canonicalAccessPath(receiver.path, new Set());
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
    private checkTypedNonNullArguments(stmt: Stmt): void {
        const invoke = stmt.getInvokeExpr();
        if (!invoke) return;
        for (const index of this.libraryRegistry.getNonNullArgumentIndices(stmt)) {
            const argument = invoke.getArgs()[index];
            if (!argument) continue;
            const accessPath = NullnessAccessPath.fromValue(argument);
            const kind = this.getTypeNullness(argument.getType());
            if (accessPath.isEmpty() || !kind ||
                this.isRequiredComponentField(stmt, accessPath)) continue;
            this.checkDirectDereference(stmt, NullnessFact.create(accessPath, kind, {
                kind: NullnessOriginKind.Uninitialized,
                stmt,
                description: 'nullable value used where the API requires a non-null argument',
            }));
        }
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
        if (bucket.some(existing => this.accessPathsAlias(existing.accessPath, diagnostic.accessPath))) return;
        bucket.push(diagnostic);
        this.diagnosticsByLocation.set(key, bucket);
        this.nullDereferences.push(diagnostic);
    }

    private getStatementInfo(stmt: Stmt): NullnessStatementInfo {
        const cached = this.statementInfo.get(stmt);
        if (cached) return cached;
        const receivers: NullnessStatementInfo['receivers'] = [];
        for (const value of stmt.getUses?.() ?? []) {
            if (value instanceof ArkInstanceFieldRef || value instanceof ArkArrayRef ||
                value instanceof ArkInstanceInvokeExpr) {
                const member = value instanceof ArkInstanceFieldRef ? value.getFieldSignature().getFieldName()
                    : value instanceof ArkInstanceInvokeExpr
                        ? value.getMethodSignature().getMethodSubSignature().getMethodName() : null;
                receivers.push({ path: NullnessAccessPath.fromValue(value.getBase()), member });
            }
        }
        const invoke = stmt.getInvokeExpr();
        const args = this.libraryRegistry.getNonNullArgumentIndices(stmt).flatMap(index => {
            const value = invoke?.getArgs()[index];
            return value ? [{ path: NullnessAccessPath.fromValue(value), index }] : [];
        });
        const result = { receivers, arguments: args, accesses: this.sourceSemantics.getAccesses(stmt),
            location: this.getLocation(stmt) };
        this.statementInfo.set(stmt, result);
        return result;
    }

    private isReportableSourceUse(stmt: Stmt, path: NullnessAccessPath, member: string | null,
        argumentIndex: number | undefined, fact: NullnessFact): boolean {
        const info = this.getStatementInfo(stmt);
        const matches = this.getSourceAccessMatches(stmt, path, member, argumentIndex);
        if (!matches.length) return true; // No precise source mapping: keep the IR evidence.
        const nullish = (mayBeNull(fact.kind) ? NULL : 0) | (mayBeUndefined(fact.kind) ? UNDEFINED : 0);
        return matches.some(access => !access.optional && !access.coercion &&
            (nullish & ~access.excluded) !== 0 &&
            (argumentIndex !== undefined || access.asserted ||
                fact.origin?.kind === NullnessOriginKind.NullableReturn ||
                !info.location.filePath.endsWith('.ets')));
    }

    private getSourceAccessMatches(stmt: Stmt, path: NullnessAccessPath, member: string | null,
        argumentIndex?: number): readonly SourceAccess[] {
        const info = this.getStatementInfo(stmt);
        const canonical = this.renderSourceAccessPath(path);
        const original = this.renderSourceAccessPath(path, false);
        const sourceMember = member === null ? null : sourcePropertyName(member);
        const candidates = info.accesses.filter(access => access.argumentIndex === argumentIndex &&
            (argumentIndex !== undefined || access.member === sourceMember || (member === null && access.indexed)));
        let matches = candidates.filter(access => access.receiver === original);
        if (!matches.length) matches = candidates.filter(access => access.receiver === canonical);
        if (!matches.length) matches = candidates.filter(access => access.receiver === null);
        return matches;
    }

    private isOptionalChainStmt(stmt: Stmt): boolean {
        const right = stmt instanceof ArkAssignStmt ? stmt.getRightOp() : undefined;
        if (!(right instanceof ArkInstanceFieldRef)) return false;
        const canonical = this.renderSourceAccessPath(NullnessAccessPath.fromValue(right.getBase()));
        return this.getStatementInfo(stmt).accesses.some(access => access.optional &&
            access.receiver === canonical && access.member === sourcePropertyName(right.getFieldSignature().getFieldName()));
    }

    private renderSourceAccessPath(path: NullnessAccessPath, followAliases = true): string {
        const canonical = followAliases ? this.canonicalAccessPath(path, new Set()) : path;
        const field = canonical.fields[0] as { getBaseName?: () => string } | undefined;
        const owner = canonical.isStaticFieldRef() ? field?.getBaseName?.() : undefined;
        const base = canonical.isStaticFieldRef() ? owner ?? '<static>' : canonical.base?.getName();
        return base ? canonical.fields.reduce((path, field) => appendSourceProperty(path,
            field.toString().startsWith('array-index:') ? field.getFieldName().slice(1, -1)
                : sourcePropertyName(field.getFieldName())), base)
            : canonical.toString();
    }

    private getCfgIndex(cfg: Cfg) {
        let index = this.cfgIndices.get(cfg);
        if (!index) {
            index = new Map<Stmt, BasicBlock>();
            for (const block of cfg.getBlocks()) {
                for (const stmt of block.getStmts()) index.set(stmt, block);
            }
            this.cfgIndices.set(cfg, index);
        }
        return index;
    }

    /** Compare SSA temporaries and field reloads through their defining assignments. */
    private accessPathsAlias(left: NullnessAccessPath, right: NullnessAccessPath, atStmt?: Stmt): boolean {
        if (left.equals(right)) return true;
        // A field is a storage cell; a local loaded from it is a value snapshot.
        // Copies are propagated explicitly at the load, not re-read through the cell.
        if (left.isLocal() !== right.isLocal()) {
            return !!atStmt && (left.isLocal()
                ? this.isFreshFieldRead(left, right, atStmt) : this.isFreshFieldRead(right, left, atStmt));
        }
        return this.canonicalAccessPath(left, new Set()).equals(
            this.canonicalAccessPath(right, new Set())
        );
    }

    private isFreshFieldRead(local: NullnessAccessPath, field: NullnessAccessPath, atStmt: Stmt): boolean {
        const definition = (local.base as Local | null)?.getDeclaringStmt();
        if (!(definition instanceof ArkAssignStmt) ||
            !NullnessAccessPath.fromValue(definition.getRightOp()).equals(field)) return false;
        const cfg = atStmt.getCfg();
        if (!cfg || definition.getCfg() !== cfg) return false;
        const block = this.getCfgIndex(cfg).get(atStmt);
        if (!block || this.getCfgIndex(cfg).get(definition) !== block) return false;
        const statements = block.getStmts();
        const start = statements.indexOf(definition);
        const end = statements.indexOf(atStmt);
        if (start < 0 || end <= start) return false;
        return statements.slice(start + 1, end).every(stmt => {
            if (stmt.getInvokeExpr()) return false;
            const defined = stmt.getDef();
            return !defined || !NullnessAccessPath.fromValue(defined).isPrefixOf(field);
        });
    }

    private canonicalAccessPath(
        accessPath: NullnessAccessPath,
        visited: Set<Local>,
        stableOnly = false
    ): NullnessAccessPath {
        // NullnessAccessPath deliberately exposes a small local contract; this
        // routine needs ArkAnalyzer's concrete declaring-statement API.
        const base = accessPath.base as Local | null;
        if (!base || visited.has(base)) return accessPath;
        visited.add(base);
        const declaringStmt = base.getDeclaringStmt();
        if (!(declaringStmt instanceof ArkAssignStmt)) return accessPath;
        const method = declaringStmt.getCfg()?.getDeclaringMethod();
        if (stableOnly && method && this.getReassignedLocals(method).has(base)) return accessPath;
        const assignedPath = NullnessAccessPath.fromValue(declaringStmt.getRightOp());
        if (assignedPath.isEmpty() || assignedPath.isZero()) return accessPath;

        const canonicalBase = this.canonicalAccessPath(assignedPath, visited, stableOnly);
        return new NullnessAccessPath(
            canonicalBase.base,
            canonicalBase.baseType,
            [...canonicalBase.fields, ...accessPath.fields],
            canonicalBase.isStatic
        );
    }

    /**
     * Avoid reporting the right-hand side of `value && value.member` after the
     * left-hand side has established that the same access path is truthy.  The
     * analogous rule for `||` uses the falsy edge.  This is deliberately limited
     * to boolean conditions; ordinary calls and assignments stay conservative.
     */
    private isDereferenceProtectedByShortCircuit(
        value: Value,
        fact: NullnessFact,
        branchStmt: ArkIfStmt
    ): boolean {
        if (!(value instanceof ArkNormalBinopExpr)) {
            return false;
        }
        const operator = value.getOperator();
        if (operator !== NormalBinaryOperator.LogicalAnd &&
            operator !== NormalBinaryOperator.LogicalOr) {
            return false;
        }

        const left = value.getOp1();
        const right = value.getOp2();
        const leftDereferences = this.valueDereferencesAccessPath(left, fact.accessPath);
        const rightDereferences = this.valueDereferencesAccessPath(right, fact.accessPath);
        if (!rightDereferences || leftDereferences) {
            return false;
        }

        const rightEvaluationTruth = operator === NormalBinaryOperator.LogicalAnd;
        const narrowed = this.narrowFactForBooleanValue(
            left,
            rightEvaluationTruth,
            fact,
            branchStmt,
            new Set()
        );
        return narrowed === null ||
            this.isDereferenceProtectedByShortCircuit(right, narrowed, branchStmt);
    }

    private valueDereferencesAccessPath(
        value: Value,
        accessPath: NullnessAccessPath
    ): boolean {
        const values = [value, ...value.getUses()];
        return values.some(used => {
            if (used instanceof ArkInstanceFieldRef || used instanceof ArkArrayRef) {
                return NullnessAccessPath.fromValue(used.getBase()).equals(accessPath);
            }
            if (used instanceof ArkInstanceInvokeExpr) {
                return NullnessAccessPath.fromValue(used.getBase()).equals(accessPath);
            }
            return false;
        });
    }

    /** Suppress an abstract base-field default overwritten by every concrete constructor. */
    private isInitializedByEveryConcreteSubclass(
        stmt: Stmt,
        fact: NullnessFact
    ): boolean {
        const sourceStmt = fact.origin?.stmt;
        if (!(sourceStmt instanceof ArkAssignStmt)) return false;
        const sourceField = sourceStmt.getLeftOp();
        if (!(sourceField instanceof ArkInstanceFieldRef) ||
            !(sourceStmt.getRightOp() instanceof UndefinedConstant)) {
            return false;
        }
        const baseClass = sourceStmt.getCfg()?.getDeclaringMethod().getDeclaringArkClass();
        if (!baseClass?.containsModifier(ModifierType.ABSTRACT)) return false;
        const canonical = this.canonicalAccessPath(fact.accessPath, new Set());
        const fieldName = sourceField.getFieldSignature().getFieldName();
        if (canonical.fields.at(-1)?.getFieldName() !== fieldName) return false;

        const descendants: ArkClass[] = [];
        const workList = [...baseClass.getExtendedClasses().values()];
        const visited = new Set<ArkClass>();
        while (workList.length > 0) {
            const candidate = workList.pop()!;
            if (visited.has(candidate)) continue;
            visited.add(candidate);
            descendants.push(candidate);
            workList.push(...candidate.getExtendedClasses().values());
        }
        const concreteClasses = descendants.filter(candidate =>
            !candidate.containsModifier(ModifierType.ABSTRACT)
        );
        if (concreteClasses.length === 0) return false;
        return concreteClasses.every(candidate => {
            const constructor = candidate.getMethodWithName(CONSTRUCTOR_NAME);
            const startingBlock = constructor?.getCfg()?.getStartingBlock();
            if (!startingBlock) return false;
            return startingBlock.getStmts().some(candidateStmt => {
                if (!(candidateStmt instanceof ArkAssignStmt)) return false;
                const left = candidateStmt.getLeftOp();
                const right = candidateStmt.getRightOp();
                return left instanceof ArkInstanceFieldRef &&
                    left.getBase().toString() === 'this' &&
                    left.getFieldSignature().getFieldName() === fieldName &&
                    !(right instanceof NullConstant) &&
                    !(right instanceof UndefinedConstant);
            });
        });
    }

    /** Match an exact `this.field` access to an ArkUI `@Require` property. */
    private isRequiredComponentField(
        stmt: Stmt,
        accessPath: NullnessAccessPath
    ): boolean {
        const canonical = this.canonicalAccessPath(accessPath, new Set());
        if (canonical.base?.getName() !== 'this' || canonical.fields.length !== 1) {
            return false;
        }
        const declaringClass = stmt.getCfg()?.getDeclaringMethod().getDeclaringArkClass();
        if (!declaringClass?.hasComponentDecorator()) return false;
        const fieldName = canonical.fields[0].getFieldName();
        return declaringClass.getFieldWithName(fieldName)?.hasDecorator('Require') ?? false;
    }

    private getLocation(stmt: Stmt): NullnessSourceLocation {
        const cached = this.statementInfo.get(stmt);
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

    private getThisLocal(method: ArkMethod): Local | null {
        const cfg = method.getCfg();
        if (!cfg) {
            return null;
        }
        for (const stmt of cfg.getStartingBlock()?.getStmts() ?? []) {
            const defined = stmt.getDef();
            if (defined instanceof Local && defined.getName() === 'this') {
                return defined;
            }
        }
        return null;
    }

    private getParameterLocal(method: ArkMethod, index: number): Local | null {
        const cfg = method.getCfg();
        if (!cfg) {
            return null;
        }
        for (const stmt of cfg.getStartingBlock()?.getStmts() ?? []) {
            if (!(stmt instanceof ArkAssignStmt)) {
                continue;
            }
            const parameterRef = stmt.getRightOp();
            const parameterLocal = stmt.getLeftOp();
            if (parameterRef instanceof ArkParameterRef &&
                parameterRef.getIndex() === index &&
                parameterLocal instanceof Local) {
                return parameterLocal;
            }
        }
        return null;
    }
}

function isFalsySentinel(value: Value): value is NumberConstant | StringConstant | NullConstant | UndefinedConstant {
    return value instanceof NullConstant || value instanceof UndefinedConstant ||
        isNumericFalsySentinel(value);
}

function isNumericFalsySentinel(value: Value): value is NumberConstant | StringConstant {
    return (value instanceof NumberConstant && value.getValue() === '0') ||
        (value instanceof StringConstant && value.getValue() === '');
}

interface NullnessStatementInfo {
    receivers: Array<{ path: NullnessAccessPath; member: string | null }>;
    arguments: Array<{ path: NullnessAccessPath; index: number }>;
    accesses: readonly SourceAccess[];
    location: NullnessSourceLocation;
}

interface NullnessCallBinding {
    caller: NullnessAccessPath;
    callee: Local;
    parameter: boolean;
    argumentIndex?: number;
    stable: boolean;
}
