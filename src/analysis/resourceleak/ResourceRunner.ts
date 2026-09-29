import type { ArkMethod, Scene } from '../../adapter/arkanalyzer';
import type { ResourceAnalysisResult } from './ResourceResult';

/** Explicit new-engine entry point; rule and IFDS semantics are implemented after §3.1. */
export class ResourceRunner {
    constructor(private readonly scene: Scene) {}

    runWithDummyMain(dummyMain: ArkMethod): ResourceAnalysisResult {
        return {
            status: 'not-implemented',
            success: false,
            entryMethod: dummyMain.getSignature().toString(),
            diagnostics: [],
            error: '新资源分析尚未实现规则和 IFDS 传播；请选择 legacy 引擎。',
        };
    }
}
