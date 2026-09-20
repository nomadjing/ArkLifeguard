/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import {
  ArkBody,
  ArkConditionExpr,
  ArkIfStmt,
  ArkMethod,
  ArkReturnVoidStmt,
  BasicBlock,
  Cfg,
  Local,
  RelationalBinaryOperator,
  ValueUtil,
} from "../adapter/arkanalyzer";
import { LifecycleModelCreator } from "./LifecycleModelCreator";
import {
  AbilityInfo,
  AbilityLifecycleMethodStage,
  AbilityLifecycleStage,
  ComponentInfo,
  ComponentLifecycleStage,
  LifecycleModelStatistics,
  PageInfo,
  UICallbackInfo,
} from "./LifecycleTypes";

const ABILITY_START_STAGES = new Set<AbilityLifecycleMethodStage>([
  AbilityLifecycleStage.CREATE,
  AbilityLifecycleStage.WINDOW_STAGE_CREATE,
]);
const ABILITY_END_STAGES = new Set<AbilityLifecycleMethodStage>([
  AbilityLifecycleStage.WINDOW_STAGE_WILL_DESTROY,
  AbilityLifecycleStage.WINDOW_STAGE_DESTROY,
  AbilityLifecycleStage.DESTROY,
]);
const COMPONENT_LOOP_STAGES: ComponentLifecycleStage[] = [
  ComponentLifecycleStage.WILL_APPLY_THEME,
  ComponentLifecycleStage.BUILD,
  ComponentLifecycleStage.DID_BUILD,
  ComponentLifecycleStage.PAGE_SHOW,
  ComponentLifecycleStage.BACK_PRESS,
  ComponentLifecycleStage.KEY_EVENT,
  ComponentLifecycleStage.PAGE_HIDE,
  ComponentLifecycleStage.ABOUT_TO_RECYCLE,
  ComponentLifecycleStage.ABOUT_TO_REUSE,
];

interface PageScope {
  page: PageInfo;
  components: ComponentInfo[];
  head: BasicBlock;
  eventHead: BasicBlock;
}

interface CallbackRegistration {
  component: ComponentInfo;
  callback: UICallbackInfo;
  pageId?: string;
}

/**
 * Canonical Ability/Page hierarchical model. Ability ownership establishes
 * lifecycle entry boundaries; unambiguous Page ownership then constrains
 * callback transitions. Unknown and ambiguous callbacks stay conservative.
 */
export class HierarchicalLifecycleModelCreator extends LifecycleModelCreator {
  private pageIdByComponent = new Map<string, string>();

  protected override buildDummyMainCfg(): void {
    this.retainReachableModelElements();
    this.pageIdByComponent.clear();

    const cfg = new Cfg();
    cfg.setDeclaringMethod(this.dummyMain);
    const entryBlock = new BasicBlock();
    cfg.addBlock(entryBlock);
    this.addStaticInitialization(cfg, entryBlock);
    this.addClassInstances(entryBlock);
    this.addAbilityStages(entryBlock, ABILITY_START_STAGES);
    this.addComponentStage(entryBlock, ComponentLifecycleStage.ABOUT_TO_APPEAR);

    const abilityHead = this.createDispatchHead(cfg, entryBlock);
    const pageGroups = this.collectUnambiguousPageGroups();
    const scopes = new Map<string, PageScope>();
    for (const ability of this.abilities) {
      const foreground = ability.lifecycleMethods.get(AbilityLifecycleStage.FOREGROUND);
      const scopeEntry = foreground
        ? this.addScopeEntryDispatch(cfg, abilityHead, [[
          this.getOrCreateClassInstance(ability.arkClass), foreground,
        ]])
        : abilityHead;
      let emittedScope = false;
      for (const group of pageGroups.filter(item =>
        item.page.abilityNames.includes(ability.name)
      )) {
        const scope = this.createPageScope(cfg, scopeEntry, group.page, group.components);
        scopes.set(group.page.id, scope);
        emittedScope = true;
      }
      if (scopeEntry !== abilityHead && !emittedScope) {
        this.linkBlocks(scopeEntry, abilityHead);
      }
      this.addAbilityStageDispatch(
        cfg, abilityHead, ability, AbilityLifecycleStage.BACKGROUND,
      );
      for (const invocation of this.otherAbilityMethods(ability)) {
        this.addReturningMethodDispatch(cfg, abilityHead, [invocation]);
      }
    }

    const assigned = new Set(this.pageIdByComponent.keys());
    const fallbackComponents = this.uniqueComponents().filter(component =>
      !assigned.has(component.signature.toString())
    );
    const fallbackHead = this.createDispatchHead(cfg, abilityHead);
    const fallbackReturnHead = this.createDetachedDispatchHead(cfg);
    this.addLifecycleDispatches(cfg, fallbackHead, fallbackComponents);

    for (const scope of scopes.values()) {
      // A fallback callback may belong to any active Page, but crossing through
      // it is observable and is not counted as a direct Page-to-Page pair.
      this.linkBlocks(scope.eventHead, fallbackHead);
      this.linkBlocks(fallbackReturnHead, scope.head);
    }
    this.linkBlocks(fallbackReturnHead, fallbackHead);

    for (const scope of scopes.values()) {
      this.populatePageCallbacks(cfg, scope, scopes, fallbackHead);
    }
    this.populateFallbackCallbacks(
      cfg, fallbackHead, fallbackReturnHead, fallbackComponents,
    );

    const returnBlock = new BasicBlock();
    this.addComponentStage(returnBlock, ComponentLifecycleStage.ABOUT_TO_DISAPPEAR);
    this.addAbilityStages(returnBlock, ABILITY_END_STAGES);
    returnBlock.addStmt(new ArkReturnVoidStmt());
    cfg.addBlock(returnBlock);
    this.linkBlocks(abilityHead, returnBlock);

    this.dummyMain.setBody(new ArkBody(new Set(this.classInstanceMap.values()), cfg));
    this.linkStmtsToCfg(cfg);
    this.setPageTransitionStatistics(this.computePageTransitionStatistics(scopes));
  }

  private collectUnambiguousPageGroups(): Array<{
    page: PageInfo;
    components: ComponentInfo[];
  }> {
    const reachable = new Set(
      this.components.map(component => component.signature.toString()),
    );
    const reachableAbilities = new Set(this.abilities.map(ability => ability.name));
    const pages = this.getAbilityCollector().getPageInfos().filter(page =>
      page.abilityNames.filter(name => reachableAbilities.has(name)).length === 1
    );
    const pagesByComponent = new Map<string, PageInfo[]>();
    for (const page of pages) {
      for (const component of page.components) {
        const signature = component.signature.toString();
        if (!reachable.has(signature)) continue;
        const owners = pagesByComponent.get(signature) ?? [];
        owners.push(page);
        pagesByComponent.set(signature, owners);
      }
    }
    const groups = new Map<string, { page: PageInfo; components: ComponentInfo[] }>();
    for (const component of this.components) {
      const signature = component.signature.toString();
      const pageOwners = pagesByComponent.get(signature) ?? [];
      if (pageOwners.length !== 1) continue;
      const page = pageOwners[0];
      let group = groups.get(page.id);
      if (!group) {
        group = { page, components: [] };
        groups.set(page.id, group);
      }
      group.components.push(component);
      this.pageIdByComponent.set(signature, page.id);
    }
    return [...groups.values()].filter(group => this.hasScopeWork(group.components));
  }

  private createPageScope(
    cfg: Cfg,
    predecessor: BasicBlock,
    page: PageInfo,
    components: ComponentInfo[],
  ): PageScope {
    const head = this.createDispatchHead(cfg, predecessor);
    const pageShow = this.componentStageInvocations(
      components, ComponentLifecycleStage.PAGE_SHOW,
    );
    let eventHead = head;
    if (pageShow.length > 0) {
      const pageShowBlock = this.createInvocationBlock(cfg, pageShow, head);
      eventHead = this.createDispatchHead(cfg, pageShowBlock);
    }
    // Re-entering an already known Page may legitimately trigger another
    // onPageShow. Keep that repetition inside this Page scope rather than
    // returning to a global callback pool.
    if (eventHead !== head) this.linkBlocks(eventHead, head);
    this.addLifecycleDispatches(cfg, head, components, false);
    return { page, components, head, eventHead };
  }

  private populatePageCallbacks(
    cfg: Cfg,
    scope: PageScope,
    scopes: ReadonlyMap<string, PageScope>,
    fallbackHead: BasicBlock,
  ): void {
    if (!this.config.enableFineGrainedUICallbacks) return;
    for (const component of scope.components) {
      for (const callback of component.uiCallbacks) {
        const targetScopes = this.getAbilityCollector()
          .getNavigationTargetPages(callback.callbackMethod)
          .map(page => scopes.get(page.id))
          .filter((target): target is PageScope => target !== undefined &&
            target.page.abilityNames.some(name => scope.page.abilityNames.includes(name)));
        const hasPageNavigation = this.getAbilityCollector()
          .hasPageNavigation(callback.callbackMethod);
        const callbackBlock = this.createCallbackBlock(cfg, component, callback);
        this.linkSelectableDispatch(cfg, scope.eventHead, callbackBlock);
        if (targetScopes.length > 0) {
          // Static target resolution does not prove that navigation succeeds
          // at runtime. Conservatively keep the local continuation as well as
          // every resolved target instead of assuming a mandatory transition.
          this.linkBlocks(callbackBlock, scope.eventHead);
          for (const target of targetScopes) this.linkBlocks(callbackBlock, target.head);
        } else {
          this.linkBlocks(
            callbackBlock,
            hasPageNavigation ? fallbackHead : scope.eventHead,
          );
        }
      }
    }
  }

  private populateFallbackCallbacks(
    cfg: Cfg,
    fallbackHead: BasicBlock,
    fallbackReturnHead: BasicBlock,
    components: readonly ComponentInfo[],
  ): void {
    if (!this.config.enableFineGrainedUICallbacks) return;
    for (const component of components) {
      for (const callback of component.uiCallbacks) {
        const callbackBlock = this.createCallbackBlock(cfg, component, callback);
        this.linkSelectableDispatch(cfg, fallbackHead, callbackBlock);
        this.linkBlocks(callbackBlock, fallbackReturnHead);
      }
    }
  }

  private createCallbackBlock(
    cfg: Cfg,
    component: ComponentInfo,
    callback: UICallbackInfo,
  ): BasicBlock {
    const block = new BasicBlock();
    this.addUICallbackInvocation(
      block, this.getOrCreateClassInstance(component.arkClass), callback,
    );
    cfg.addBlock(block);
    return block;
  }

  private addLifecycleDispatches(
    cfg: Cfg,
    dispatcher: BasicBlock,
    components: readonly ComponentInfo[],
    includePageShow: boolean = true,
  ): void {
    for (const component of components) {
      const instance = this.getOrCreateClassInstance(component.arkClass);
      for (const stage of COMPONENT_LOOP_STAGES) {
        if (!includePageShow && stage === ComponentLifecycleStage.PAGE_SHOW) continue;
        const method = component.lifecycleMethods.get(stage);
        if (method) this.addReturningMethodDispatch(cfg, dispatcher, [[instance, method]]);
      }
    }
  }

  private addClassInstances(entryBlock: BasicBlock): void {
    for (const ability of this.abilities) {
      const local = this.getOrCreateClassInstance(ability.arkClass);
      this.addInstanceCreation(entryBlock, local, ability.arkClass);
    }
    for (const component of this.uniqueComponents()) {
      const local = this.getOrCreateClassInstance(component.arkClass);
      this.addInstanceCreation(entryBlock, local, component.arkClass);
    }
  }

  private addAbilityStages(
    block: BasicBlock,
    stages: ReadonlySet<AbilityLifecycleMethodStage>,
  ): void {
    for (const stage of this.config.lifecycleOrder) {
      if (!stages.has(stage)) continue;
      for (const ability of this.abilities) {
        const method = ability.lifecycleMethods.get(stage);
        if (method) {
          this.addMethodInvocation(
            block, this.getOrCreateClassInstance(ability.arkClass), method,
          );
        }
      }
    }
  }

  private addComponentStage(block: BasicBlock, stage: ComponentLifecycleStage): void {
    for (const [instance, method] of this.componentStageInvocations(
      this.uniqueComponents(), stage,
    )) {
      this.addMethodInvocation(block, instance, method);
    }
  }

  private componentStageInvocations(
    components: readonly ComponentInfo[],
    stage: ComponentLifecycleStage,
  ): Array<[Local, ArkMethod]> {
    const invocations: Array<[Local, ArkMethod]> = [];
    for (const component of components) {
      const method = component.lifecycleMethods.get(stage);
      if (method) {
        invocations.push([this.getOrCreateClassInstance(component.arkClass), method]);
      }
    }
    return invocations;
  }

  private addAbilityStageDispatch(
    cfg: Cfg,
    dispatcher: BasicBlock,
    ability: AbilityInfo,
    stage: AbilityLifecycleMethodStage,
  ): void {
    const method = ability.lifecycleMethods.get(stage);
    if (method) {
      this.addReturningMethodDispatch(cfg, dispatcher, [[
        this.getOrCreateClassInstance(ability.arkClass), method,
      ]]);
    }
  }

  private otherAbilityMethods(ability: AbilityInfo): Array<[Local, ArkMethod]> {
    const invocations: Array<[Local, ArkMethod]> = [];
    const emitted = new Set<string>();
    const instance = this.getOrCreateClassInstance(ability.arkClass);
    for (const stage of this.config.lifecycleOrder) {
      if (ABILITY_START_STAGES.has(stage) || ABILITY_END_STAGES.has(stage) ||
        stage === AbilityLifecycleStage.FOREGROUND ||
        stage === AbilityLifecycleStage.BACKGROUND) continue;
      const method = ability.lifecycleMethods.get(stage);
      const signature = method?.getSignature().toString();
      if (!method || !signature || emitted.has(signature)) continue;
      emitted.add(signature);
      invocations.push([instance, method]);
    }
    return invocations;
  }

  private addReturningMethodDispatch(
    cfg: Cfg,
    dispatcher: BasicBlock,
    invocations: Array<[Local, ArkMethod]>,
  ): void {
    if (invocations.length === 0) return;
    const invokeBlock = this.createInvocationBlock(cfg, invocations);
    this.linkSelectableDispatch(cfg, dispatcher, invokeBlock);
    this.linkBlocks(invokeBlock, dispatcher);
  }

  private addScopeEntryDispatch(
    cfg: Cfg,
    dispatcher: BasicBlock,
    invocations: Array<[Local, ArkMethod]>,
  ): BasicBlock {
    const invokeBlock = this.createInvocationBlock(cfg, invocations);
    this.linkSelectableDispatch(cfg, dispatcher, invokeBlock);
    return invokeBlock;
  }

  private linkSelectableDispatch(
    cfg: Cfg,
    dispatcher: BasicBlock,
    invocation: BasicBlock,
  ): void {
    if (this.config.optimizations.compactDispatcher) {
      this.linkBlocks(dispatcher, invocation);
      return;
    }
    const condition = this.createDispatchHead(cfg, dispatcher);
    this.linkBlocks(condition, invocation);
    this.linkBlocks(condition, dispatcher);
  }

  private createInvocationBlock(
    cfg: Cfg,
    invocations: Array<[Local, ArkMethod]>,
    predecessor?: BasicBlock,
  ): BasicBlock {
    const block = new BasicBlock();
    for (const [instance, method] of invocations) {
      this.addMethodInvocation(block, instance, method);
    }
    cfg.addBlock(block);
    if (predecessor) this.linkBlocks(predecessor, block);
    return block;
  }

  private computePageTransitionStatistics(
    scopes: ReadonlyMap<string, PageScope>,
  ): LifecycleModelStatistics['pageTransitions'] {
    const collector = this.getAbilityCollector();
    const registrations: CallbackRegistration[] = this.components.flatMap(component =>
      component.uiCallbacks.map(callback => ({
        component,
        callback,
        pageId: this.pageIdByComponent.get(component.signature.toString()),
      }))
    );
    let retainedCallbackTransitions = 0;
    let prunedCrossPageTransitions = 0;
    let conservativeFallbackTransitions = 0;
    let legalNavigationTransitions = 0;
    for (const source of registrations) {
      const navigationTargets = new Set(
        collector.getNavigationTargetPages(source.callback.callbackMethod)
          .map(page => page.id)
          .filter(pageId => scopes.has(pageId)),
      );
      const unresolvedNavigation = collector.hasPageNavigation(
        source.callback.callbackMethod,
      ) && navigationTargets.size === 0;
      for (const target of registrations) {
        if (!source.pageId || !target.pageId || unresolvedNavigation) {
          retainedCallbackTransitions++;
          conservativeFallbackTransitions++;
        } else if (source.pageId === target.pageId) {
          retainedCallbackTransitions++;
        } else if (navigationTargets.has(target.pageId)) {
          retainedCallbackTransitions++;
          legalNavigationTransitions++;
        } else {
          prunedCrossPageTransitions++;
        }
      }
    }
    const boundCallbacks = registrations.filter(item => item.pageId).length;
    return {
      discoveredPages: collector.getPageInfos().length,
      boundCallbacks,
      fallbackCallbacks: registrations.length - boundCallbacks,
      candidateCallbackTransitions: registrations.length ** 2,
      retainedCallbackTransitions,
      prunedCrossPageTransitions,
      conservativeFallbackTransitions,
      legalNavigationTransitions,
    };
  }

  private createDispatchHead(cfg: Cfg, predecessor: BasicBlock): BasicBlock {
    const head = this.createDetachedDispatchHead(cfg);
    this.linkBlocks(predecessor, head);
    return head;
  }

  private createDetachedDispatchHead(cfg: Cfg): BasicBlock {
    const head = new BasicBlock();
    head.addStmt(new ArkIfStmt(new ArkConditionExpr(
      ValueUtil.getBooleanConstant(true),
      ValueUtil.getBooleanConstant(false),
      RelationalBinaryOperator.InEquality,
    )));
    cfg.addBlock(head);
    return head;
  }

  private uniqueComponents(
    components: readonly ComponentInfo[] = this.components,
  ): ComponentInfo[] {
    const seen = new Set<string>();
    return components.filter(component => {
      const signature = component.signature.toString();
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
  }

  private hasScopeWork(components: readonly ComponentInfo[]): boolean {
    if (this.config.enableFineGrainedUICallbacks &&
      components.some(component => component.uiCallbacks.length > 0)) return true;
    return components.some(component => COMPONENT_LOOP_STAGES.some(stage =>
      component.lifecycleMethods.has(stage)
    ));
  }

  private linkBlocks(from: BasicBlock, to: BasicBlock): void {
    from.addSuccessorBlock(to);
    to.addPredecessorBlock(from);
  }
}
