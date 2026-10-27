import { describe, expect, it } from 'vitest';
import 'arkanalyzer';
import { ArkAssignStmt, ArkIfStmt, ArkNewExpr, BasicBlock } from '../../src/adapter/arkanalyzer';
import {
    createLifecycleModelCreator,
    FlatLifecycleModelCreator,
} from '../../src/lifecycle';
import { buildLifecycleScene } from '../helpers/buildScene';

function hasCycle(blocks: BasicBlock[]): boolean {
    const visited = new Set<BasicBlock>();
    const active = new Set<BasicBlock>();

    const visit = (block: BasicBlock): boolean => {
        if (active.has(block)) return true;
        if (visited.has(block)) return false;
        visited.add(block);
        active.add(block);
        for (const successor of block.getSuccessors()) {
            if (visit(successor)) return true;
        }
        active.delete(block);
        return false;
    };

    return blocks.some(visit);
}

function invokedNames(block: BasicBlock): string[] {
    return block.getStmts().flatMap(stmt => {
        const invoke = stmt.getInvokeExpr();
        return invoke
            ? [invoke.getMethodSignature().getMethodSubSignature().getMethodName()]
            : [];
    });
}

describe('standard flat DummyMain generator', () => {
    it('uses the flat model by default and separates start, loop and end callbacks', () => {
        const creator = createLifecycleModelCreator(buildLifecycleScene('simple'));
        creator.create();

        expect(creator).toBeInstanceOf(FlatLifecycleModelCreator);
        const cfg = creator.getDummyMain().getCfg()!;
        expect(cfg.getStartingStmt()).toBeDefined();
        const blocks = [...cfg.getBlocks()];
        for (const block of blocks) {
            for (const stmt of block.getStmts()) {
                expect(stmt.getCfg()).toBe(cfg);
            }
        }
        expect(hasCycle(blocks)).toBe(true);

        const entryNames = invokedNames(blocks[0]);
        expect(entryNames).toEqual(expect.arrayContaining([
            'onCreate',
            'onWindowStageCreate',
            'aboutToAppear',
        ]));
        expect(entryNames).not.toContain('onForeground');

        const returnBlock = blocks.find(block => block.getSuccessors().length === 0)!;
        expect(invokedNames(returnBlock)).toEqual(expect.arrayContaining([
            'aboutToDisappear',
            'onDestroy',
        ]));

        const middleNames = blocks.slice(1).flatMap(invokedNames);
        expect(middleNames).toEqual(expect.arrayContaining([
            'onForeground',
            'onBackground',
            'build',
            'handleClick',
        ]));
    });

    it('excludes test-source abilities from the flat model', () => {
        const creator = createLifecycleModelCreator(
            buildLifecycleScene('ability-scope-nesting')
        );
        creator.create();

        expect(creator.getAbilities().map(ability => ability.name)).toEqual(
            expect.arrayContaining(['EntryAbility', 'SecondAbility', 'UnusedAbility'])
        );
        expect(creator.getAbilities().map(ability => ability.name)).not.toContain(
            'TestAbility'
        );
        expect(creator.getLifecycleModelStatistics().abilities.collected).toBe(creator.getAbilities().length);
    });

    it('uses one compact dispatcher and a unique continuation for every event', () => {
        const creator = createLifecycleModelCreator(buildLifecycleScene('simple'));
        creator.create();
        const cfg = creator.getDummyMain().getCfg()!;
        const blocks = [...cfg.getBlocks()];
        const heads = blocks.filter(block => block.getTail() instanceof ArkIfStmt);
        expect(heads).toHaveLength(1);
        const dispatcher = heads[0];
        const entry = cfg.getStartingBlock()!;
        const end = blocks.find(block => block.getSuccessors().length === 0)!;
        const events = blocks.filter(block => block !== entry && block !== end && block !== dispatcher);
        expect(events).toHaveLength(5);
        expect(blocks).toHaveLength(8);
        expect(blocks.reduce((count, block) => count + block.getSuccessors().length, 0)).toBe(12);
        expect(entry.getSuccessors()).toEqual([dispatcher]);
        expect(new Set(dispatcher.getSuccessors())).toEqual(new Set([...events, end]));
        for (const event of events) {
            expect(event.getPredecessors()).toEqual([dispatcher]);
            expect(event.getSuccessors()).toEqual([dispatcher]);
        }
        expect([...creator.getDummyMain().getBody()!.getLocals().keys()]).not.toContain('count');
    });

    it('creates all retained instances before the first Ability start callback', () => {
        const creator = createLifecycleModelCreator(buildLifecycleScene('ability-scope-nesting'));
        creator.create();
        const classes = new Set([...creator.getAbilities(), ...creator.getComponents()]
            .map(item => item.signature.toString()));
        const statements = creator.getDummyMain().getCfg()!.getStartingBlock()!.getStmts();
        const allocations = statements.flatMap((stmt, index) => {
            if (!(stmt instanceof ArkAssignStmt)) return [];
            const rhs = stmt.getRightOp();
            return rhs instanceof ArkNewExpr && classes.has(rhs.getClassType().getClassSignature().toString())
                ? [index] : [];
        });
        const firstCreate = statements.findIndex(stmt => stmt.getInvokeExpr()
            ?.getMethodSignature().getMethodSubSignature().getMethodName() === 'onCreate');
        expect(allocations).toHaveLength(classes.size);
        expect(firstCreate).toBeGreaterThan(Math.max(...allocations));
    });

    it('rejects model names passed through the retired factory argument', () => {
        expect(() => createLifecycleModelCreator(
            buildLifecycleScene('simple'),
            'hierarchical' as unknown as Parameters<typeof createLifecycleModelCreator>[1],
        )).toThrow('Lifecycle configuration must be an object');
    });
});
