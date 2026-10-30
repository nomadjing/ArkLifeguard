/*
 * Copyright (c) 2024-2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { ArkAssignStmt, ModifierType, Stmt } from '../../../adapter/arkanalyzer';
import type { ArkMethod, Scene } from '../../../adapter/arkanalyzer';
import { NullnessAccessPath, NullnessFact, NullnessKind, NullnessOriginKind } from '../NullnessFact';
import { SdkSignatureSummary } from './SdkSignatureSummary';
import { resolveProjectMethods } from '../../../ifds/CallResolver';
import { GetterReadSummary } from '../GetterReadSummary';
import { NullnessLibrarySummary } from './NullnessLibrarySummary';

/** Ordered registry for library summaries. The first matching summary owns a call. */
export class NullnessLibraryRegistry {
    private readonly summaryCache = new WeakMap<Stmt, NullnessLibrarySummary | null>();
    private readonly nonNullArgumentCache = new WeakMap<Stmt, readonly number[]>();
    private readonly unmodeledReturns = new WeakSet<Stmt>();
    private readonly getters?: GetterReadSummary;

    constructor(private readonly summaries: readonly NullnessLibrarySummary[], private readonly scene?: Scene) {
        this.getters = scene ? new GetterReadSummary(scene) : undefined;
    }

    getGetterRead(stmt: Stmt): NullnessAccessPath | null { return this.getters?.getRead(stmt) ?? null; }

    getFieldReadFacts(stmt: Stmt): Set<NullnessFact> {
        const facts = new Set<NullnessFact>();
        for (const summary of this.summaries) if (summary instanceof SdkSignatureSummary) {
            for (const fact of summary.getFieldReadFacts(stmt)) facts.add(fact);
        }
        return facts;
    }

    static createDefault(scene?: Scene): NullnessLibraryRegistry {
        return new NullnessLibraryRegistry([
            new SdkSignatureSummary(),
        ], scene);
    }

    find(callStmt: Stmt): NullnessLibrarySummary | undefined {
        const cached = this.summaryCache.get(callStmt);
        if (cached !== undefined) return cached ?? undefined;
        const summary = this.summaries.find(candidate => candidate.matches(callStmt)) ?? null;
        const invoke = callStmt.getInvokeExpr();
        if (invoke) {
            const targets = this.scene ? resolveProjectMethods(this.scene, callStmt) : new Set<ArkMethod>();
            // Unsupported calls remain unresolved; no type/name-based non-null promise is made.
            if (!summary && (targets.size === 0 ||
                [...targets].some(method => method.containsModifier(ModifierType.ASYNC)))) {
                this.unmodeledReturns.add(callStmt);
            }
        }
        this.summaryCache.set(callStmt, summary);
        return summary ?? undefined;
    }

    getCallToReturnFacts(callStmt: Stmt, inputFact: NullnessFact): Set<NullnessFact> {
        const summary = this.find(callStmt);
        if (summary) return summary.getCallToReturnFacts(callStmt, inputFact);
        if (!inputFact.isZeroFact() || !(callStmt instanceof ArkAssignStmt) || !this.unmodeledReturns.has(callStmt)) return new Set();
        const target = NullnessAccessPath.fromValue(callStmt.getLeftOp());
        if (target.isEmpty()) return new Set();
        return new Set([NullnessFact.create(target, NullnessKind.MaybeNullish, {
            kind: NullnessOriginKind.UnresolvedReturn, stmt: callStmt,
            description: 'return value outside the supported synchronous models',
        })]);
    }

    getNonNullArgumentIndices(callStmt: Stmt): readonly number[] {
        const cached = this.nonNullArgumentCache.get(callStmt);
        if (cached) return cached;
        const indices = new Set<number>();
        for (const summary of this.summaries) {
            if (!summary.getNonNullArgumentIndices) continue;
            if (!summary.matches(callStmt)) continue;
            for (const index of summary.getNonNullArgumentIndices(callStmt)) {
                indices.add(index);
            }
        }
        const result = [...indices];
        this.nonNullArgumentCache.set(callStmt, result);
        return result;
    }

    shouldSuppressLiteralReturn(callStmt: Stmt, zeroFact: NullnessFact): boolean {
        const summary = this.find(callStmt);
        if (!summary) return false;
        if ([...summary.getCallToReturnFacts(callStmt, zeroFact)]
            .some(fact => !fact.isZeroFact())) {
            return true;
        }
        return summary.suppressesLiteralReturns?.(callStmt) ?? false;
    }
}
