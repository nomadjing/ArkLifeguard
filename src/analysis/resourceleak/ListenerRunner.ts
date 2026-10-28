import type { ArkMethod, Scene, Stmt } from '../../adapter/arkanalyzer';
import type { ResourceAnalysisResult } from './ResourceResult';
import { ReleaseObligationRunner } from './ReleaseObligationRunner';
import { ListenerProblem, listenerContracts } from './ListenerProblem';
import { resolveListenerRules, type ListenerRule } from './rules/ListenerRules';
import type { ResourceRule } from './rules/ResourceRule';
import { UNSUPPORTED_LISTENER_API_FAMILIES } from './rules/ListenerCapabilities';

/** Listener/timer cleanup only; no captured-object retention analysis. */
export class ListenerRunner extends ReleaseObligationRunner {
    private readonly sourceRules: readonly ListenerRule[];
    constructor(
        private readonly listenerScene: Scene,
        rules?: readonly ListenerRule[],
        collectStatistics = false
    ) {
        const resolved = rules === undefined ? resolveListenerRules(listenerScene) : undefined;
        const selected = rules ?? resolved!.rules;
        super(listenerScene, listenerContracts(selected), collectStatistics, {
            label: 'Listener',
            scope: 'listener',
            unresolvedRuleIds: resolved?.unresolvedRuleIds ?? [],
            unsupportedApiFamilies: [
                ...UNSUPPORTED_LISTENER_API_FAMILIES,
                'ambiguous receiver/event/callback identity',
                'repeated registrations at one allocation site',
                'asynchronous cancellation scheduling',
            ],
        });
        this.sourceRules = selected;
    }
    override runWithDummyMain(entry: ArkMethod): ResourceAnalysisResult {
        const result = super.runWithDummyMain(entry);
        return {
            ...result,
            diagnostics: result.diagnostics.map(item => ({
                ...item,
                reason:
                    item.reason === 'unknown-ownership'
                        ? ('unknown-registration' as const)
                        : item.reason === 'unreleased'
                          ? ('unregistered' as const)
                          : item.reason,
            })),
        };
    }
    protected override createProblem(
        entry: Stmt,
        method: ArkMethod,
        _rules: readonly ResourceRule[],
        successors: (stmt: Stmt) => readonly Stmt[]
    ): ListenerProblem {
        return new ListenerProblem(entry, method, this.sourceRules, this.listenerScene, successors);
    }
}
