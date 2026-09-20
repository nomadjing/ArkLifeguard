import path from 'node:path';
import { describe, expect, it } from 'vitest';
import 'arkanalyzer';
import { Scene, SceneConfig } from 'arkanalyzer';
import type { Sdk } from 'arkanalyzer/lib/Config';
import { AbilityCollector } from '../../src/lifecycle/AbilityCollector';
import { NavigationAnalyzer } from '../../src/lifecycle/NavigationAnalyzer';
import { NavigationType } from '../../src/lifecycle/LifecycleTypes';

const PROJECT_DIR = path.resolve(__dirname, '../../examples/lifecycle-model-showcase');
const SDK_DIR = path.resolve(__dirname, '../fixtures/sdk');

function buildShowcaseScene(): Scene {
  const sdk: Sdk = { name: 'test-sdk', path: SDK_DIR, moduleName: '' };
  const config = new SceneConfig();
  config.buildConfig(PROJECT_DIR, PROJECT_DIR, [sdk]);
  config.buildFromProjectDir(PROJECT_DIR);
  const scene = new Scene();
  scene.buildSceneFromProjectDir(config);
  scene.inferTypes();
  return scene;
}

function getClass(scene: Scene, name: string) {
  const arkClass = scene.getClasses().find(candidate => candidate.getName() === name);
  expect(arkClass, `Expected class ${name}`).toBeDefined();
  return arkClass!;
}

describe('lifecycle model showcase project', () => {
  it('exposes multi-Ability ownership and Want communication edges', () => {
    const collector = new AbilityCollector(buildShowcaseScene());
    const abilities = collector.collectAllAbilities();

    expect(abilities.map(ability => ability.name)).toEqual(
      expect.arrayContaining(['EntryAbility', 'FeatureAbility'])
    );

    const entry = abilities.find(ability => ability.name === 'EntryAbility');
    const feature = abilities.find(ability => ability.name === 'FeatureAbility');
    expect(entry?.isEntry).toBe(true);
    expect(entry?.components.map(component => component.name)).toEqual(
      expect.arrayContaining([
        'HomePage',
        'LifecycleCard',
        'RouterDetailPage',
        'NavigationPage',
      ])
    );
    expect(feature?.components.map(component => component.name)).toContain('FeaturePage');
    expect(entry?.navigationTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetAbilityName: 'FeatureAbility',
        navigationType: NavigationType.START_ABILITY,
      }),
    ]));
    expect(feature?.navigationTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetAbilityName: 'EntryAbility',
        navigationType: NavigationType.START_ABILITY,
      }),
    ]));
  });

  it('contains router and Navigation page edges', () => {
    const scene = buildShowcaseScene();
    const analyzer = new NavigationAnalyzer(scene);

    const routerTargets = analyzer.analyzeClass(getClass(scene, 'HomePage'))
      .navigationTargets.map(target => target.targetAbilityName);
    expect(routerTargets).toEqual(expect.arrayContaining([
      'pages/RouterDetailPage',
      'pages/NavigationPage',
      'FeatureAbility',
    ]));

    const navigationTargets = analyzer.analyzeClass(getClass(scene, 'NavigationPage'))
      .navigationTargets.map(target => target.targetAbilityName);
    expect(navigationTargets).toEqual(expect.arrayContaining([
      'ProfileDestination',
      'SettingsDestination',
    ]));

    const backTargets = analyzer.analyzeClass(getClass(scene, 'RouterDetailPage'))
      .navigationTargets.map(target => target.targetAbilityName);
    expect(backTargets).toContain('__BACK__');
  });
});
