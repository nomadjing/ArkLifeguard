import { beforeAll, describe, expect, it, vi } from 'vitest';
import 'arkanalyzer';
import { AbilityCollector } from '../../src/lifecycle/AbilityCollector';
import {
    AbilityLifecycleStage,
    ComponentLifecycleStage,
    NavigationType,
} from '../../src/lifecycle/LifecycleTypes';
import { buildLifecycleScene } from '../helpers/buildScene';

describe('AbilityCollector', () => {
    describe('simple project', () => {
        let collector: AbilityCollector;

        beforeAll(() => {
            collector = new AbilityCollector(buildLifecycleScene('simple'));
        });

        it('collects entry metadata from module.json5', () => {
            const abilities = collector.collectAllAbilities();
            const entryAbility = abilities.find(ability => ability.name === 'EntryAbility');

            expect(entryAbility?.isEntry).toBe(true);
            expect(collector.getEntryAbilityNames()).toContain('EntryAbility');
            expect(collector.getModuleConfigs().some(config =>
                config.mainElement === 'EntryAbility'
            )).toBe(true);
        });

        it('collects ability and component lifecycle methods', () => {
            const entryAbility = collector.collectAllAbilities()
                .find(ability => ability.name === 'EntryAbility');
            const indexComponent = collector.collectAllComponents()
                .find(component => component.name === 'Index');

            expect(entryAbility).toBeDefined();
            expect(entryAbility?.lifecycleMethods.has(AbilityLifecycleStage.CREATE)).toBe(true);
            expect(entryAbility?.lifecycleMethods.has(AbilityLifecycleStage.WINDOW_STAGE_CREATE)).toBe(true);
            expect(entryAbility?.lifecycleMethods.has(AbilityLifecycleStage.FOREGROUND)).toBe(true);
            expect(entryAbility?.lifecycleMethods.has(AbilityLifecycleStage.BACKGROUND)).toBe(true);
            expect(entryAbility?.lifecycleMethods.has(AbilityLifecycleStage.DESTROY)).toBe(true);

            expect(indexComponent?.isEntry).toBe(true);
            expect(indexComponent?.lifecycleMethods.has(ComponentLifecycleStage.ABOUT_TO_APPEAR)).toBe(true);
            expect(indexComponent?.lifecycleMethods.has(ComponentLifecycleStage.BUILD)).toBe(true);
            expect(indexComponent?.lifecycleMethods.has(ComponentLifecycleStage.ABOUT_TO_DISAPPEAR)).toBe(true);
        });

        it('supports signature lookups', () => {
            const entryAbility = collector.collectAllAbilities()
                .find(ability => ability.name === 'EntryAbility');
            const indexComponent = collector.collectAllComponents()
                .find(component => component.name === 'Index');

            expect(entryAbility).toBeDefined();
            expect(indexComponent).toBeDefined();
            expect(collector.getAbilityBySignature(entryAbility!.signature)?.name).toBe('EntryAbility');
            expect(collector.getComponentBySignature(indexComponent!.signature)?.name).toBe('Index');
        });
    });

    it('distinguishes entry and secondary abilities', () => {
        const collector = new AbilityCollector(buildLifecycleScene('multi-ability'));
        const abilities = collector.collectAllAbilities();

        expect(abilities.map(ability => ability.name)).toEqual(
            expect.arrayContaining(['EntryAbility', 'SecondAbility'])
        );
        expect(abilities.find(ability => ability.name === 'EntryAbility')?.isEntry).toBe(true);
        expect(abilities.find(ability => ability.name === 'SecondAbility')?.isEntry).toBe(false);
    });

    it('excludes ohosTest abilities from application lifecycle collection', () => {
        const abilities = new AbilityCollector(
            buildLifecycleScene('ability-scope-nesting')
        ).collectAllAbilities();

        expect(abilities.map(ability => ability.name)).not.toContain('TestAbility');
        expect(abilities.map(ability => ability.name)).toContain('UnusedAbility');
    });

    it('attributes component startAbility targets to the owning ability', () => {
        const abilities = new AbilityCollector(
            buildLifecycleScene('ability-scope-nesting')
        ).collectAllAbilities();
        const entry = abilities.find(ability => ability.name === 'EntryAbility');
        const target = entry?.navigationTargets.find(candidate =>
            candidate.navigationType === NavigationType.START_ABILITY
        );

        expect(target?.targetAbilityName).toBe('SecondAbility');
        expect(target?.sourceMethod.getDeclaringArkClass().getName()).toBe('EntryPage');
    });

    it('expands Page ownership through custom-component ViewTree edges', () => {
        const collector = new AbilityCollector(
            buildLifecycleScene('ability-scope-nesting')
        );
        const entry = collector.collectAllAbilities()
            .find(ability => ability.name === 'EntryAbility');

        expect(entry?.pageComponents.map(component => component.name))
            .toContain('EntryPage');
        expect(entry?.components.map(component => component.name))
            .toEqual(expect.arrayContaining(['EntryPage', 'EntryChild']));
        expect(collector.getOwnershipExpansionStatistics().viewTreeComponentEdges)
            .toBeGreaterThan(0);
    });
    describe('runtime source and module ownership', () => {
        let collector: AbilityCollector;
        beforeAll(() => {
            collector = new AbilityCollector(buildLifecycleScene('runtime-ownership'));
            collector.collectAllAbilities();
        });

        it('uses declared module roots to exclude test and arbitrary template sources', () => {
            expect(collector.collectAllAbilities().map(ability => ability.name).sort())
                .toEqual(['EntryAbility', 'FeatureAbility']);
            const files = collector.collectAllComponents().map(component =>
                component.arkClass.getDeclaringArkFile().getFilePath()
            );
            expect(files.some(file => /ohosTest|\.agents|support-materials/.test(file))).toBe(false);
            expect(collector.getModuleConfigs().map(module => module.moduleName).sort())
                .toEqual(['entry', 'feature']);
            expect(collector.collectAllComponents().some(component =>
                component.name === 'RuntimeTemplate'
            )).toBe(true);
        });

        it('resolves identical page paths within each declaring module', () => {
            const abilities = collector.collectAllAbilities();
            for (const [name, module] of [['EntryAbility', 'entry'], ['FeatureAbility', 'feature']]) {
                const ability = abilities.find(item => item.name === name)!;
                expect(ability.pageComponents).toHaveLength(1);
                expect(ability.components.map(component => component.name).sort())
                    .toEqual(['Child', 'Index']);
                expect(ability.components.every(component => component.arkClass
                    .getDeclaringArkFile().getFilePath().replace(/\\/g, '/')
                    .includes(`/${module}/src/main/`))).toBe(true);
            }
            const pages = collector.getPageInfos();
            expect(pages).toHaveLength(2);
            expect(new Set(pages.map(page => page.id)).size).toBe(2);
            expect(pages.every(page => page.abilityNames.length === 1)).toBe(true);
            expect(collector.resolvePageTarget('pages/Index')).toHaveLength(2);
        });
    });

    it('recovers render component ownership when ViewTree construction fails', () => {
        const scene = buildLifecycleScene('ability-scope-nesting');
        const page = scene.getClasses().find(item => item.getName() === 'EntryPage')!;
        const spy = vi.spyOn(page.getViewTree()!, 'getRoot').mockImplementation(() => {
            throw new RangeError('synthetic ViewTree failure');
        });
        try {
            const collector = new AbilityCollector(scene);
            const entry = collector.collectAllAbilities()
                .find(ability => ability.name === 'EntryAbility')!;
            expect(entry.components.map(component => component.name))
                .toEqual(expect.arrayContaining(['EntryPage', 'EntryChild']));
            expect(collector.getOwnershipExpansionStatistics().renderIRComponentEdges)
                .toBeGreaterThan(0);
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
    });

});
