/*
 * Copyright (c) 2024-2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { Stmt } from '../../../adapter/arkanalyzer';
import { NullnessFact } from '../NullnessFact';
import { NullnessLibrarySummary } from './NullnessLibrarySummary';

const NON_NULL_COLLECTION_BUILDERS = new Set(['ForEach', 'LazyForEach']);

/** Collection boundaries; ForEach rejects nullish input before dereferencing it. */
export class ArkUiArgumentSummary implements NullnessLibrarySummary {
    readonly id = 'arkui-non-null-arguments';

    matches(callStmt: Stmt): boolean {
        const invoke = callStmt.getInvokeExpr();
        if (!invoke) return false;
        const signature = invoke.getMethodSignature();
        const methodName = signature.getMethodSubSignature().getMethodName();
        const className = signature.getDeclaringClassSignature().getClassName();
        return NON_NULL_COLLECTION_BUILDERS.has(methodName) ||
            (methodName === 'create' && NON_NULL_COLLECTION_BUILDERS.has(className));
    }

    getCallToReturnFacts(_callStmt: Stmt, _inputFact: NullnessFact): Set<NullnessFact> {
        return new Set();
    }

    getNonNullArgumentIndices(callStmt: Stmt): readonly number[] {
        const signature = callStmt.getInvokeExpr()?.getMethodSignature();
        const name = signature?.getMethodSubSignature().getMethodName();
        const owner = signature?.getDeclaringClassSignature().getClassName();
        return name === 'ForEach' || (name === 'create' && owner === 'ForEach') ? [] : [0];
    }
}
