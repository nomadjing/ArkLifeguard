import { describe, expect, it } from 'vitest';
import 'arkanalyzer';
import type { BasicBlock } from '../../src/adapter/arkanalyzer';
import {
    AbilityCollector,
    createLifecycleModelCreator,
    LifecycleModelCreator,
} from '../../src/lifecycle';
import { buildLifecycleScene } from '../helpers/buildScene';

const PROJECT = 'page-scope';
const HANDLERS = [
    'handleHomeTap',
    'navigateToDetails',
    'handleChildTap',
    'handleDetailsTap',
];

function blocks(creator: LifecycleModelCreator): BasicBlock[] {
    return [...creator.getDummyMain().getCfg()!.getBlocks()];
}

function invokes(block: BasicBlock, methodName: string): boolean {
    return block.getStmts().some(stmt => stmt.getInvokeExpr()
        ?.getMethodSignature().getMethodSubSignature().getMethodName() === methodName);
}

function callbackNames(creator: LifecycleModelCreator): string[] {
    return blocks(creator).flatMap(block => HANDLERS.filter(handler =>
        invokes(block, handler)
    )).sort();
}

/** Reach target without passing through any different UI callback block. */
function hasNextCallback(
    creator: LifecycleModelCreator,
    from: string,
    to: string,
): boolean {
    const modelBlocks = blocks(creator);
    const source = modelBlocks.find(block => invokes(block, from));
    const target = modelBlocks.find(block => invokes(block, to));
    expect(source, `missing ${from}`).toBeDefined();
    expect(target, `missing ${to}`).toBeDefined();
    const callbackBlocks = new Set(modelBlocks.filter(block =>
        HANDLERS.some(handler => invokes(block, handler))
    ));
    const pending = [...source!.getSuccessors()];
    const visited = new Set<BasicBlock>();
    while (pending.length > 0) {
        const current = pending.pop()!;
        if (current === target) return true;
        if (visited.has(current) || callbackBlocks.has(current)) continue;
        visited.add(current);
        pending.push(...current.getSuccessors());
    }
    return false;
}

function nextCallbackPairs(creator: LifecycleModelCreator): string[] {
    return HANDLERS.flatMap(from => HANDLERS
        .filter(to => hasNextCallback(creator, from, to))
        .map(to => `${from}->${to}`)
    ).sort();
}

function cfgShape(creator: LifecycleModelCreator) {
    const modelBlocks = blocks(creator);
    return {
        blocks: modelBlocks.length,
        edges: modelBlocks.reduce(
            (sum, block) => sum + block.getSuccessors().length,
            0
        ),
        dispatchBlocks: modelBlocks.filter(block => block.getStmts().some(stmt =>
            stmt.constructor.name === 'ArkIfStmt'
        )).length,
    };
}

function creatorFor(model: 'opt-flat' | 'hierarchical') {
    const creator = createLifecycleModelCreator(buildLifecycleScene(PROJECT), model);
    creator.create();
    return creator;
}

describe('unified hierarchical lifecycle model', () => {
    it('builds Page -> Component closure and resolves router_map aliases', () => {
        const collector = new AbilityCollector(buildLifecycleScene(PROJECT));
        const pages = collector.getPageInfos();

        expect(pages.map(page => page.id).sort()).toEqual([
            'pages/DetailsPage',
            'pages/HomePage',
        ]);
        expect(pages.find(page => page.id === 'pages/HomePage')?.components
            .map(component => component.name)).toContain('HomeChild');
        expect(collector.resolvePageTarget('DetailsRoute')
            .map(page => page.id)).toEqual(['pages/DetailsPage']);
        expect(pages.every(page => page.abilityNames.includes('EntryAbility'))).toBe(true);
    });

    it('keeps the callback set fixed while pruning only illegal direct cross-Page transitions', () => {
        const optFlat = creatorFor('opt-flat');
        const hierarchical = creatorFor('hierarchical');
        const pageScope = creatorFor('hierarchical');
        const expectedCallbacks = [...HANDLERS].sort();

        expect(callbackNames(optFlat)).toEqual(expectedCallbacks);
        expect(callbackNames(hierarchical)).toEqual(expectedCallbacks);
        expect(callbackNames(pageScope)).toEqual(expectedCallbacks);

        expect(nextCallbackPairs(optFlat)).toHaveLength(16);
        const hierarchicalPairs = nextCallbackPairs(hierarchical);
        expect(nextCallbackPairs(pageScope)).toEqual(hierarchicalPairs);
        expect(hierarchicalPairs).toEqual([
            'handleChildTap->handleChildTap',
            'handleChildTap->handleHomeTap',
            'handleChildTap->navigateToDetails',
            'handleDetailsTap->handleDetailsTap',
            'handleHomeTap->handleChildTap',
            'handleHomeTap->handleHomeTap',
            'handleHomeTap->navigateToDetails',
            'navigateToDetails->handleChildTap',
            'navigateToDetails->handleDetailsTap',
            'navigateToDetails->handleHomeTap',
            'navigateToDetails->navigateToDetails',
        ]);

        for (const creator of [optFlat]) {
            expect(creator.getLifecycleModelStatistics().pageTransitions).toMatchObject({
                candidateCallbackTransitions: 16,
                retainedCallbackTransitions: 16,
                prunedCrossPageTransitions: 0,
            });
        }
        const statistics = pageScope.getLifecycleModelStatistics().pageTransitions;
        expect(hierarchical.getLifecycleModelStatistics().pageTransitions)
            .toEqual(statistics);
        expect(statistics.discoveredPages).toBe(2);
        expect(statistics.boundCallbacks).toBe(4);
        expect(statistics.fallbackCallbacks).toBe(0);
        expect(statistics.candidateCallbackTransitions).toBe(16);
        expect(statistics.prunedCrossPageTransitions).toBe(5);
        expect(statistics.legalNavigationTransitions).toBe(1);
        expect(statistics.retainedCallbackTransitions).toBe(11);
        expect(statistics.retainedCallbackTransitions).toBe(hierarchicalPairs.length);
    });

    it('audits raw and callback-normalized compact CFG structure', () => {
        const optFlat = creatorFor('opt-flat');
        const hierarchical = creatorFor('hierarchical');

        expect(cfgShape(optFlat)).toEqual({
            blocks: 11,
            edges: 18,
            dispatchBlocks: 1,
        });
        expect(cfgShape(hierarchical)).toEqual({
            blocks: 15,
            edges: 26,
            dispatchBlocks: 5,
        });
        expect(callbackNames(hierarchical)).toEqual(callbackNames(optFlat));
        expect(nextCallbackPairs(hierarchical)).toHaveLength(11);
    });

    it('supports compact-dispatcher ablation without changing Page semantics', () => {
        const compact = createLifecycleModelCreator(
            buildLifecycleScene(PROJECT), 'hierarchical'
        );
        const expanded = createLifecycleModelCreator(
            buildLifecycleScene(PROJECT),
            'hierarchical',
            { optimizations: { compactDispatcher: false } } as any
        );
        compact.create();
        expanded.create();

        expect(blocks(expanded).length).toBeGreaterThan(blocks(compact).length);
        expect(callbackNames(expanded)).toEqual(callbackNames(compact));
        expect(expanded.getLifecycleModelStatistics().pageTransitions)
            .toEqual(compact.getLifecycleModelStatistics().pageTransitions);
        expect(hasNextCallback(expanded, 'handleHomeTap', 'handleDetailsTap')).toBe(false);
        expect(hasNextCallback(expanded, 'navigateToDetails', 'handleDetailsTap')).toBe(true);
    });

});
