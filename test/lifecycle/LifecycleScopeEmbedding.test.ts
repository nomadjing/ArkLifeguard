import { describe, expect, it } from 'vitest';
import 'arkanalyzer';
import { AbilityCollector } from '../../src/lifecycle/AbilityCollector';
import { HierarchicalLifecycleModelCreator } from '../../src/lifecycle/HierarchicalLifecycleModelCreator';
import { FlatLifecycleModelCreator } from '../../src/lifecycle/FlatLifecycleModelCreator';
import type { BasicBlock } from '../../src/adapter/arkanalyzer';
import { buildLifecycleScene } from '../helpers/buildScene';

describe('lifecycle scope embedding', () => {
    it('links loaded components to their owning abilities', () => {
        const abilities = new AbilityCollector(buildLifecycleScene('ability-scope-nesting'))
            .collectAllAbilities();

        expect(abilities.find(ability => ability.name === 'EntryAbility')
            ?.components.map(component => component.name)).toContain('EntryPage');
        expect(abilities.find(ability => ability.name === 'SecondAbility')
            ?.components.map(component => component.name)).toContain('SecondPage');
    });

    it('keeps each UI callback inside its owning Ability scope in M1', () => {
        const creator = new HierarchicalLifecycleModelCreator(
            buildLifecycleScene('ability-scope-nesting')
        );
        creator.create();
        expect(creator.getAbilities().map(ability => ability.name)).toEqual([
            'EntryAbility',
            'SecondAbility',
        ]);
        const blocks = [...creator.getDummyMain().getCfg()!.getBlocks()];
        const findBlock = (text: string): BasicBlock => {
            const block = blocks.find(candidate => candidate.getStmts()
                .some(stmt => stmt.toString().includes(text)));
            expect(block, `missing block containing ${text}`).toBeDefined();
            return block!;
        };
        const canReachWithout = (
            start: BasicBlock,
            target: BasicBlock,
            forbidden: BasicBlock
        ): boolean => {
            const pending = [start];
            const visited = new Set<BasicBlock>();
            while (pending.length > 0) {
                const current = pending.pop()!;
                if (current === target) return true;
                if (current === forbidden || visited.has(current)) continue;
                visited.add(current);
                pending.push(...current.getSuccessors());
            }
            return false;
        };

        const entryForeground = findBlock('EntryAbility.onForeground');
        const secondForeground = findBlock('SecondAbility.onForeground');
        const entryTap = findBlock('EntryPage.handleEntryTap');
        const childTap = findBlock('EntryChild.handleChildTap');
        const secondTap = findBlock('SecondPage.handleSecondTap');

        expect(canReachWithout(entryForeground, entryTap, secondForeground)).toBe(true);
        expect(canReachWithout(entryForeground, childTap, secondForeground)).toBe(true);
        expect(canReachWithout(entryForeground, secondTap, secondForeground)).toBe(false);
        expect(canReachWithout(secondForeground, secondTap, entryForeground)).toBe(true);
        expect(canReachWithout(secondForeground, entryTap, entryForeground)).toBe(false);
    });

    it('reports ownership expansion and direct cross-Ability transition pruning', () => {
        const creator = new HierarchicalLifecycleModelCreator(
            buildLifecycleScene('ability-scope-nesting')
        );
        creator.create();
        const statistics = creator.getLifecycleModelStatistics();

        expect(statistics.ownership.directPageRoots).toBe(2);
        expect(statistics.ownership.viewTreeComponentEdges).toBeGreaterThan(0);
        expect(statistics.components.owned).toBe(3);
        expect(statistics.transitions.candidateCallbackTransitions)
            .toBeGreaterThan(statistics.transitions.retainedCallbackTransitions);
        expect(statistics.transitions.prunedCrossAbilityTransitions)
            .toBeGreaterThan(0);
    });

    it('keeps callbacks in one global scope in flat', () => {
        const creator = new FlatLifecycleModelCreator(
            buildLifecycleScene('ability-scope-nesting')
        );
        creator.create();
        const blocks = [...creator.getDummyMain().getCfg()!.getBlocks()];
        const findBlock = (text: string): BasicBlock => {
            const block = blocks.find(candidate => candidate.getStmts()
                .some(stmt => stmt.toString().includes(text)));
            expect(block, `missing block containing ${text}`).toBeDefined();
            return block!;
        };
        const canReach = (start: BasicBlock, target: BasicBlock): boolean => {
            const pending = [start];
            const visited = new Set<BasicBlock>();
            while (pending.length > 0) {
                const current = pending.pop()!;
                if (current === target) return true;
                if (visited.has(current)) continue;
                visited.add(current);
                pending.push(...current.getSuccessors());
            }
            return false;
        };

        expect(canReach(
            findBlock('EntryAbility.onForeground'),
            findBlock('SecondPage.handleSecondTap')
        )).toBe(true);
    });

});
