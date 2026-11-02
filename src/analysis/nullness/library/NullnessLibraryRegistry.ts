/*
 * Copyright (c) 2024-2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { Stmt } from '../../../adapter/arkanalyzer';
import type { Scene } from '../../../adapter/arkanalyzer';
import { NullnessAccessPath, NullnessFact } from '../NullnessFact';
import { SdkSignatureSummary } from './SdkSignatureSummary';
import { GetterReadSummary } from '../GetterReadSummary';
import { NullnessLibrarySummary } from './NullnessLibrarySummary';

/** Ordered registry for library summaries. The first matching summary owns a call. */
export class NullnessLibraryRegistry {
    private readonly summaryCache = new WeakMap<Stmt, NullnessLibrarySummary | null>();
    private readonly nonNullArgumentCache = new WeakMap<Stmt, readonly number[]>();
    private readonly getters?: GetterReadSummary;

    constructor(private readonly summaries: readonly NullnessLibrarySummary[], scene?: Scene) {
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
        this.summaryCache.set(callStmt, summary);
        return summary ?? undefined;
    }

    getCallToReturnFacts(callStmt: Stmt, inputFact: NullnessFact): Set<NullnessFact> {
        // Unsupported returns have no nullness contract and produce no fact.
        return this.find(callStmt)?.getCallToReturnFacts(callStmt, inputFact) ?? new Set();
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
