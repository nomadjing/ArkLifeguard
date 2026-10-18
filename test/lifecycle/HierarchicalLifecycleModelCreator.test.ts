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

function creatorFor(model: 'flat' | 'hierarchical') {
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
        const flat = creatorFor('flat');
        const hierarchical = creatorFor('hierarchical');
        const pageScope = creatorFor('hierarchical');
        const expectedCallbacks = [...HANDLERS].sort();

        expect(callbackNames(flat)).toEqual(expectedCallbacks);
        expect(callbackNames(hierarchical)).toEqual(expectedCallbacks);
        expect(callbackNames(pageScope)).toEqual(expectedCallbacks);

        expect(nextCallbackPairs(flat)).toHaveLength(16);
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

        for (const creator of [flat]) {
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
        const flat = creatorFor('flat');
        const hierarchical = creatorFor('hierarchical');

        expect(cfgShape(flat)).toEqual({
            blocks: 11,
            edges: 18,
            dispatchBlocks: 1,
        });
        expect(cfgShape(hierarchical)).toEqual({
            blocks: 17,
            edges: 28,
            dispatchBlocks: 7,
        });
        expect(callbackNames(hierarchical)).toEqual(callbackNames(flat));
        expect(nextCallbackPairs(hierarchical)).toHaveLength(11);
    });

});
