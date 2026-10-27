import { describe, expect, it, vi } from 'vitest';
import 'arkanalyzer';
import { ArkInstanceInvokeExpr, ArkThisRef, Local } from '../../src/adapter/arkanalyzer';
import { createLifecycleModelCreator, DEFAULT_LIFECYCLE_CONFIG } from '../../src/lifecycle';
import { NULLNESS_LIFECYCLE_ORDER } from '../../src/analysis/nullness/NullnessAnalysisRunner';
import { AbilityCollector } from '../../src/lifecycle/AbilityCollector';
import { buildLifecycleScene } from '../helpers/buildScene';

describe('DummyMain generation contracts', () => {
    it(
        'emits every lifecycle declaration in the HomeFlow coverage fixture', () => {
            const scene = buildLifecycleScene('lifecycle-coverage');
            // The fixture deliberately includes HomeFlow's extra method names, plus
            // ArkLifeguard's backup/key-event entries and corrected onSessionDestroy.
            const declarations = scene.getClasses()
                .filter(cls => cls.getName().startsWith('Full'))
                .flatMap(cls => cls.getMethods())
                .filter(method => method.getName() !== 'constructor' && !method.getName().startsWith('%'));
            const creator = createLifecycleModelCreator(scene);
            creator.create();
            const main = creator.getDummyMain();
            const cfg = main.getCfg()!;
            const invoked = cfg.getStmts().flatMap(stmt => {
                const sig = stmt.getInvokeExpr()?.getMethodSignature();
                return sig ? [sig.toString()] : [];
            });
            expect(declarations).toHaveLength(58);
            for (const method of declarations) {
                expect(invoked, method.getSignature().toString())
                    .toContain(method.getSignature().toString());
            }

            const entry = cfg.getStartingBlock()!;
            const entryNames = entry.getStmts().flatMap(stmt =>
                stmt.getInvokeExpr()?.getMethodSignature().getMethodSubSignature().getMethodName() ?? []
            );
            expect(entryNames).toContain('onSessionCreate');
            const end = [...cfg.getBlocks()].find(block => block.getSuccessors().length === 0)!;
            const endNames = end.getStmts().flatMap(stmt =>
                stmt.getInvokeExpr()?.getMethodSignature().getMethodSubSignature().getMethodName() ?? []
            );
            expect(endNames).toEqual([
                'onWindowStageWillDestroy', 'aboutToDisappear', 'onDetached',
                'onWindowStageDestroy', 'onSessionDestroy', 'onSessionDestory', 'onDestroy',
            ]);
            expect(main.isGenerated()).toBe(true);
            expect(cfg.getStartingStmt().getUses().some(value => value instanceof ArkThisRef)).toBe(true);
            const locals = main.getBody()!.getLocals();
            for (const stmt of cfg.getStmts()) {
                expect(stmt.getCfg()).toBe(cfg);
                expect(cfg.getStmtToBlock().has(stmt)).toBe(true);
                for (const value of [stmt.getDef(), ...stmt.getUses()]) {
                    if (value instanceof Local) expect(locals.get(value.getName())).toBe(value);
                }
            }
        }
    );

    it('keeps unknown argument slots before typed arguments', () => {
        const scene = buildLifecycleScene('lifecycle-coverage');
        const method = scene.getClasses().find(cls => cls.getName() === 'FullComponent')!
            .getMethodWithName('onNewParam')!;
        const typeSpy = vi.spyOn(method.getParameters()[0], 'getType')
            .mockReturnValue(undefined as any);
        try {
            const creator = createLifecycleModelCreator(scene);
            creator.create();
            const call = creator.getDummyMain().getCfg()!.getStmts()
                .map(stmt => stmt.getInvokeExpr())
                .find(invoke => invoke?.getMethodSignature().toString() === method.getSignature().toString())!;
            expect(call.getArgs()).toHaveLength(2);
            expect(call.getArgs()[1].getType().toString()).toContain('LifecycleEvent');
            expect(call).toBeInstanceOf(ArkInstanceInvokeExpr);
        } finally {
            typeSpy.mockRestore();
        }
    });

    it('keeps nullness callback coverage aligned with the shared lifecycle order', () => {
        expect(new Set(NULLNESS_LIFECYCLE_ORDER)).toEqual(new Set(DEFAULT_LIFECYCLE_CONFIG.lifecycleOrder));
        expect(NULLNESS_LIFECYCLE_ORDER.filter(name => name === 'onForeground')).toHaveLength(2);
    });

    it('terminates collection when an application superclass points back to itself', () => {
        const scene = buildLifecycleScene('simple');
        const ability = scene.getClasses().find(cls => cls.getName() === 'EntryAbility')!;
        const component = scene.getClasses().find(cls => cls.getName() === 'Index')!;
        const superSpy = vi.spyOn(ability, 'getSuperClass').mockReturnValue(ability);
        const componentSuperSpy = vi.spyOn(component, 'getSuperClass').mockReturnValue(component);
        try {
            const collected = new AbilityCollector(scene).collectAllAbilities();
            expect(collected.find(item => item.name === 'EntryAbility')!.lifecycleMethods.size)
                .toBeGreaterThan(0);
        } finally {
            superSpy.mockRestore();
            componentSuperSpy.mockRestore();
        }
    });
});
