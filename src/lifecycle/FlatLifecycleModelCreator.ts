/*
 * Copyright (c) 2024-2026 Huawei Device Co., Ltd.
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
  ABILITY_START_STAGES,
  ABILITY_END_STAGES,
  COMPONENT_LOOP_STAGES,
  ComponentInfo,
  ComponentLifecycleStage,
} from "./LifecycleTypes";

/**
 * Flat lifecycle model with one compact global event dispatcher.
 *
 * The generated CFG is finite, but contains a back edge around lifecycle and
 * UI callback branches. Object collection, initialization order and event
 * grouping are independent of this structural compaction:
 *
 * entry(create/appear) -> loop -> one callback branch -> loop
 *                           |                            |
 *                           +------> destroy/return <----+
 */
export class FlatLifecycleModelCreator extends LifecycleModelCreator {
  protected override buildDummyMainCfg(): void {
    const cfg = new Cfg();
    cfg.setDeclaringMethod(this.dummyMain);

    const entryBlock = new BasicBlock();
    cfg.addBlock(entryBlock);
    this.addStaticInitialization(cfg, entryBlock);

    this.addClassInstances(entryBlock);
    this.addAbilityStartInvocations(entryBlock);
    this.addComponentStartInvocations(entryBlock);

    const loopBlock = new BasicBlock();
    const loopCondition = new ArkConditionExpr(
      ValueUtil.getBooleanConstant(true),
      ValueUtil.getBooleanConstant(false),
      RelationalBinaryOperator.InEquality,
    );
    loopBlock.addStmt(new ArkIfStmt(loopCondition));
    cfg.addBlock(loopBlock);
    this.linkBlocks(entryBlock, loopBlock);

    for (const ability of this.abilities) {
      const instance = this.getOrCreateClassInstance(ability.arkClass);
      const emitted = new Set<string>();
      for (const stage of this.config.lifecycleOrder) {
        if (ABILITY_START_STAGES.has(stage) || ABILITY_END_STAGES.has(stage)) {
          continue;
        }
        const method = ability.lifecycleMethods.get(stage);
        const signature = method?.getSignature().toString();
        if (!method || !signature || emitted.has(signature)) {
          continue;
        }
        emitted.add(signature);
        this.addMethodDispatch(
          cfg,
          loopBlock,
          [[instance, method]],
        );
      }
    }

    for (const component of this.uniqueComponents()) {
      const instance = this.getOrCreateClassInstance(component.arkClass);
      for (const stage of COMPONENT_LOOP_STAGES) {
        if (stage === ComponentLifecycleStage.ABOUT_TO_RECYCLE ||
            stage === ComponentLifecycleStage.ABOUT_TO_REUSE) continue;
        const method = component.lifecycleMethods.get(stage);
        if (!method) {
          continue;
        }
        this.addMethodDispatch(
          cfg,
          loopBlock,
          [[instance, method]],
        );
      }

      const recycle = component.lifecycleMethods.get(
        ComponentLifecycleStage.ABOUT_TO_RECYCLE,
      );
      const reuse = component.lifecycleMethods.get(
        ComponentLifecycleStage.ABOUT_TO_REUSE,
      );
      const reusePair: Array<[Local, ArkMethod]> = [];
      if (recycle) reusePair.push([instance, recycle]);
      if (reuse) reusePair.push([instance, reuse]);
      if (reusePair.length > 0) {
        this.addMethodDispatch(
          cfg,
          loopBlock,
          reusePair,
        );
      }

      if (this.config.enableFineGrainedUICallbacks) {
        for (const callback of component.uiCallbacks) {
          this.addCallbackDispatch(
            cfg,
            loopBlock,
            instance,
            callback,
          );
        }
      }
    }

    const returnBlock = new BasicBlock();
    this.addEndInvocations(returnBlock);
    returnBlock.addStmt(new ArkReturnVoidStmt());
    cfg.addBlock(returnBlock);
    this.linkBlocks(loopBlock, returnBlock);

    this.dummyMain.setBody(
      new ArkBody(new Set(this.classInstanceMap.values()), cfg),
    );
    this.linkStmtsToCfg(cfg);
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

  private addAbilityStartInvocations(entryBlock: BasicBlock): void {
    for (const ability of this.abilities) {
      const instance = this.getOrCreateClassInstance(ability.arkClass);
      for (const stage of this.config.lifecycleOrder) {
        if (!ABILITY_START_STAGES.has(stage)) {
          continue;
        }
        const method = ability.lifecycleMethods.get(stage);
        if (method) this.addMethodInvocation(entryBlock, instance, method);
      }
    }
  }

  private addComponentStartInvocations(entryBlock: BasicBlock): void {
    for (const component of this.uniqueComponents()) {
      const method = component.lifecycleMethods.get(
        ComponentLifecycleStage.ABOUT_TO_APPEAR,
      );
      if (method) {
        this.addMethodInvocation(
          entryBlock,
          this.getOrCreateClassInstance(component.arkClass),
          method,
        );
      }
    }
  }

  private addMethodDispatch(
    cfg: Cfg,
    dispatcher: BasicBlock,
    invocations: Array<[Local, ArkMethod]>,
  ): void {
    const invokeBlock = new BasicBlock();
    for (const [instance, method] of invocations) {
      this.addMethodInvocation(invokeBlock, instance, method);
    }
    this.addEventBlock(cfg, dispatcher, invokeBlock);
  }

  private addCallbackDispatch(
    cfg: Cfg,
    dispatcher: BasicBlock,
    instance: Local,
    callback: ComponentInfo["uiCallbacks"][number],
  ): void {
    const invokeBlock = new BasicBlock();
    this.addUICallbackInvocation(invokeBlock, instance, callback);
    this.addEventBlock(cfg, dispatcher, invokeBlock);
  }

  private addEventBlock(cfg: Cfg, dispatcher: BasicBlock, event: BasicBlock): void {
    cfg.addBlock(event);
    this.linkBlocks(dispatcher, event);
    this.linkBlocks(event, dispatcher);
  }

  private uniqueComponents(): ComponentInfo[] {
    const seen = new Set<string>();
    return this.components.filter((component) => {
      const signature = component.signature.toString();
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
  }

  private linkBlocks(from: BasicBlock, to: BasicBlock): void {
    from.addSuccessorBlock(to);
    to.addPredecessorBlock(from);
  }
}
