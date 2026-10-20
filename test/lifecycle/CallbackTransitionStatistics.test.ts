import { expect, it } from 'vitest';
import { LifecycleModelCreator } from '../../src/lifecycle/LifecycleModelCreator';

it('matches pair enumeration with shared owners, duplicate navigation and unknown ownership', () => {
    // Exhaust all two-Page ownership subsets, including repeated groups and empty components.
    const subsets = [[], ['A'], ['B'], ['A', 'B'], ['B', 'A']];
    for (let seed = 0; seed < 20; seed++) {
        const components = subsets.map((pages, index) => ({
            signature: { toString: () => String(index) },
            pages,
            uiCallbacks: Array.from({ length: (index + seed) % 4 }, (_, n) => ({
                callbackMethod: { targets: subsets[(n + index + seed) % subsets.length] },
            })),
        }));
        const abilities = ['A', 'B'].map(id => ({
            signature: { toString: () => id },
            components: components.filter(component => component.pages.includes(id)),
        }));
        let ownershipQueries = 0;
        const collector = {
            getPagesForComponent: (component: typeof components[number]) => {
                ownershipQueries++;
                return component.pages.map(id => ({ id }));
            },
            getNavigationTargetPages: (method: { targets: string[] }) =>
                [...method.targets, ...method.targets].map(id => ({ id })),
            getPageInfos: () => [{ id: 'A' }, { id: 'B' }],
        };
        // Exercise the production methods without building a Scene or a CFG.
        const creator = Object.assign(Object.create(LifecycleModelCreator.prototype), {
            abilities, abilityCollector: collector,
        });
        const registrations = components.flatMap(component =>
            component.uiCallbacks.map(callback => ({ component, callback })));
        let fallback = 0;
        let navigation = 0;
        let pruned = 0;
        for (const source of registrations) {
            for (const target of registrations) {
                const sourcePages = source.component.pages;
                const targetPages = target.component.pages;
                const shared = sourcePages.some(page => targetPages.includes(page));
                if (!sourcePages.length || !targetPages.length) fallback++;
                else if (!shared) pruned++;
                if (targetPages.some(page => source.callback.callbackMethod.targets.includes(page)) && !shared) {
                    navigation++;
                }
            }
        }
        const candidate = registrations.length ** 2;
        const bound = registrations.filter(item => item.component.pages.length).length;
        expect(creator.computeDefaultPageTransitionStatistics(components)).toEqual({
            discoveredPages: 2, boundCallbacks: bound, fallbackCallbacks: registrations.length - bound,
            candidateCallbackTransitions: candidate, retainedCallbackTransitions: candidate,
            prunedCrossPageTransitions: 0, conservativeFallbackTransitions: fallback,
            legalNavigationTransitions: navigation,
        });
        expect(ownershipQueries).toBe(components.length);
        expect(creator.computeCallbackTransitionStatistics(components)).toEqual({
            candidateCallbackTransitions: candidate, retainedCallbackTransitions: candidate - pruned,
            prunedCrossAbilityTransitions: pruned, conservativeFallbackTransitions: fallback,
        });
    }
});
