/*
 * Copyright (c) 2024-2025 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file LifecycleModelCreator.ts
 * @description 扩展版 DummyMain 创建器的共享基础
 *
 * 本模块是对原有 DummyMainCreater 的扩展，主要增强功能：
 *
 * 1. **多 Ability 支持**
 *    - 收集项目中所有 Ability
 *    - 按启动顺序/跳转关系建模
 *
 * 2. **精细化 UI 回调**
 *    - 利用 ViewTree 提取控件信息
 *    - 按控件实例化后调用对应回调
 *
 * 3. **页面跳转建模**
 *    - 分析 startAbility/router.pushUrl 等调用
 *    - 在 CFG 中体现跳转关系
 *
 * 具体的 DummyMain CFG 由循环生命周期模型实现。
 */
import {
  Scene,
  ArkClass,
  ArkMethod,
  ArkFile,
  Language,
  Local,
  ClassType,
  ArkThisRef,
  ArkAssignStmt,
  ArkInvokeStmt,
  ArkInstanceInvokeExpr,
  ArkNewExpr,
  ArkStaticInvokeExpr,
  BasicBlock,
  Cfg,
  ClassSignature,
  FileSignature,
  MethodSignature,
  ArkSignatureBuilder,
  Type,
  CONSTRUCTOR_NAME,
  checkAndUpdateMethod,
} from "../adapter/arkanalyzer";

// 导入自定义模块
import { AbilityCollector } from "./AbilityCollector";
import { ViewTreeCallbackExtractor } from "./ViewTreeCallbackExtractor";
import {
  AbilityInfo,
  ComponentInfo,
  ComponentLifecycleStage,
  AbilityLifecycleStage,
  AbilityLifecycleMethodStage,
  ABILITY_END_STAGES,
  UICallbackInfo,
  UIEventType,
  LifecycleModelConfig,
  LifecycleModelStatistics,
  DEFAULT_LIFECYCLE_CONFIG,
  NavigationType,
  ScopeModelInfo,
} from "./LifecycleTypes";

// ============================================================================
// LifecycleModelCreator 类
// ============================================================================

/**
 * 扩展版生命周期模型创建器
 *
 * 使用方式：
 * ```typescript
 * const scene = ...; // 已构建的 Scene
 * const creator = new LifecycleModelCreator(scene);
 * creator.create();
 * const dummyMain = creator.getDummyMain();
 * ```
 */
export abstract class LifecycleModelCreator {
  // ========================================================================
  // 成员变量
  // ========================================================================

  /** 分析场景 */
  protected scene: Scene;

  /** 配置选项 */
  protected config: LifecycleModelConfig;

  /** Ability 收集器 */
  private abilityCollector: AbilityCollector;

  /** ViewTree 回调提取器 */
  private callbackExtractor: ViewTreeCallbackExtractor;

  /** 收集到的所有 Ability */
  protected abilities: AbilityInfo[] = [];

  /** 收集到的所有 Component */
  protected components: ComponentInfo[] = [];

  /** 生成的 DummyMain 方法 */
  protected dummyMain: ArkMethod = new ArkMethod();

  /** 临时变量索引（用于生成唯一名称） */
  private tempLocalIndex: number = 0;

  /** 类实例 Local 映射：类签名 -> Local 变量 */
  protected classInstanceMap: Map<string, Local> = new Map();

  /** DummyMain 的 scope 结构信息（仅分层模型在 buildDummyMainCfg 中填充）。 */
  protected scopeModelInfo?: ScopeModelInfo;

  /** Collected/effective hierarchy counts used by RQ1.5 reports. */
  private lifecycleModelStatistics: LifecycleModelStatistics = {
    abilities: { collected: 0, reachable: 0, pruned: 0 },
    pages: { owned: 0, unknown: 0 },
    components: { owned: 0, reachable: 0, fallback: 0 },
    callbacks: { bound: 0, fallback: 0 },
    ownership: {
      directPageRoots: 0,
      viewTreeComponentEdges: 0,
      navigationPageEdges: 0,
      viewTreeFailures: 0,
    },
    transitions: {
      candidateCallbackTransitions: 0,
      retainedCallbackTransitions: 0,
      prunedCrossAbilityTransitions: 0,
      conservativeFallbackTransitions: 0,
    },
    pageTransitions: {
      discoveredPages: 0,
      boundCallbacks: 0,
      fallbackCallbacks: 0,
      candidateCallbackTransitions: 0,
      retainedCallbackTransitions: 0,
      prunedCrossPageTransitions: 0,
      conservativeFallbackTransitions: 0,
      legalNavigationTransitions: 0,
    },
  };

  private collectedAbilitiesCount = 0;
  private collectedComponents: ComponentInfo[] = [];
  private collectedPageComponentSignatures = new Set<string>();
  private collectedOwnedComponentSignatures = new Set<string>();

  // ========================================================================
  // 构造函数
  // ========================================================================

  /**
   * 创建 LifecycleModelCreator 实例
   *
   * @param scene 分析场景
   * @param config 配置选项（可选，使用默认配置）
   */
  constructor(scene: Scene, config?: Partial<LifecycleModelConfig>) {
    this.scene = scene;
    this.config = {
      ...DEFAULT_LIFECYCLE_CONFIG,
      ...config,
      optimizations: {
        ...DEFAULT_LIFECYCLE_CONFIG.optimizations,
        ...(config?.optimizations ?? {}),
      },
    };

    // 初始化收集器
    this.abilityCollector = new AbilityCollector(scene);
    this.callbackExtractor = new ViewTreeCallbackExtractor(scene);
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 创建扩展版 DummyMain
   *
   * 这是主入口方法，执行完整的构建流程
   */
  public create(): void {
    console.log("[LifecycleModelCreator] Starting creation...");

    // Step 1: 收集所有 Ability 和 Component
    this.collectAbilitiesAndComponents();

    // Step 2: 提取 UI 回调（如果启用）
    if (this.config.enableViewTreeParsing) {
      this.extractUICallbacks();
    }

    // Step 3: 创建 DummyMain 方法的容器（File、Class）
    this.createDummyMainContainer();

    // Step 4: 构建 DummyMain 的 CFG
    this.buildDummyMainCfg();

    // Step 5: 注册到 Scene
    this.scene.addToMethodsMap(this.dummyMain);

    console.log("[LifecycleModelCreator] Creation completed.");
    this.printSummary();
  }

  /**
   * 获取生成的 DummyMain 方法
   */
  public getDummyMain(): ArkMethod {
    return this.dummyMain;
  }

  /**
   * 获取收集到的 Ability 列表
   */
  public getAbilities(): AbilityInfo[] {
    return this.abilities;
  }

  /**
   * 获取收集到的 Component 列表
   */
  public getComponents(): ComponentInfo[] {
    return this.components;
  }

  /** Return a defensive copy of hierarchy statistics for reports. */
  public getLifecycleModelStatistics(): LifecycleModelStatistics {
    return {
      abilities: { ...this.lifecycleModelStatistics.abilities },
      pages: { ...this.lifecycleModelStatistics.pages },
      components: { ...this.lifecycleModelStatistics.components },
      callbacks: { ...this.lifecycleModelStatistics.callbacks },
      ownership: { ...this.lifecycleModelStatistics.ownership },
      transitions: { ...this.lifecycleModelStatistics.transitions },
      pageTransitions: { ...this.lifecycleModelStatistics.pageTransitions },
    };
  }

  /**
   * DummyMain 的 scope 结构信息，供 profiling / 调试使用。
   * 仅分层模型返回非 undefined；Flat 返回 undefined。
   */
  public getScopeModelInfo(): ScopeModelInfo | undefined {
    return this.scopeModelInfo;
  }

  /** Page-scope subclasses use the shared collector after callbacks are filled. */
  protected getAbilityCollector(): AbilityCollector {
    return this.abilityCollector;
  }

  /** Record model-specific Page transition counts after its CFG is built. */
  protected setPageTransitionStatistics(
    statistics: LifecycleModelStatistics['pageTransitions'],
  ): void {
    this.lifecycleModelStatistics.pageTransitions = { ...statistics };
  }

  // ========================================================================
  // Step 1: 收集 Ability 和 Component
  // ========================================================================

  /**
   * 收集所有 Ability 和 Component
   */
  private collectAbilitiesAndComponents(): void {
    console.log(
      "[LifecycleModelCreator] Collecting Abilities and Components...",
    );

    // 收集 Ability（AbilityCollector 已分析 onWindowStageCreate 中的 loadContent，建立 ability.components 关联）
    this.abilities = this.abilityCollector.collectAllAbilities();
    // 阶段四：Entry Ability 优先 - 确保入口 Ability（onCreate/onWindowStageCreate）在 DummyMain 中先执行
    this.abilities.sort((a, b) => (b.isEntry ? 1 : 0) - (a.isEntry ? 1 : 0)); // entry 排前面
    console.log(`  Found ${this.abilities.length} Abilities (entry first)`);

    // 收集 Component
    this.components = this.abilityCollector.collectAllComponents();
    // 阶段四：@Entry Component 优先 - loadContent 通常加载入口页，入口组件先执行更符合实际流程
    this.components.sort((a, b) => (b.isEntry ? 1 : 0) - (a.isEntry ? 1 : 0)); // @Entry 排前面
    console.log(`  Found ${this.components.length} Components (@Entry first)`);
    this.collectedAbilitiesCount = this.abilities.length;
    this.collectedComponents = [...this.components];
    this.collectedPageComponentSignatures = new Set(
      this.abilities.flatMap(ability =>
        ability.pageComponents.map(component => component.signature.toString())
      ),
    );
    this.collectedOwnedComponentSignatures = new Set(
      this.abilities.flatMap(ability =>
        ability.components.map(component => component.signature.toString())
      ),
    );
    this.refreshLifecycleModelStatistics();
  }

  // ========================================================================
  // Step 2: 提取 UI 回调
  // ========================================================================

  /**
   * 提取所有 Component 的 UI 回调
   */
  private extractUICallbacks(): void {
    console.log(
      "[LifecycleModelCreator] Extracting UI callbacks from ViewTree...",
    );

    this.callbackExtractor.fillAllComponentCallbacks(this.components);

    let totalCallbacks = 0;
    for (const component of this.components) {
      totalCallbacks += component.uiCallbacks.length;
    }
    console.log(`  Extracted ${totalCallbacks} UI callbacks`);
    this.refreshLifecycleModelStatistics();
  }

  /**
   * Apply hierarchical Ability reachability pruning. An unresolved
   * startAbility target conservatively retains every collected Ability.
   */
  protected retainReachableModelElements(): void {
    const allAbilities = this.abilities;
    if (!this.config.optimizations.pruneUnreachableAbilities) {
      this.refreshLifecycleModelStatistics();
      return;
    }
    const entries = allAbilities.filter(ability => ability.isEntry);
    if (entries.length === 0) {
      this.refreshLifecycleModelStatistics();
      return;
    }

    const byName = new Map(
      allAbilities.map(ability => [ability.name.toLowerCase(), ability]),
    );
    const reachable = new Set<AbilityInfo>();
    const pending = [...entries];
    while (pending.length > 0) {
      const ability = pending.pop()!;
      if (reachable.has(ability)) continue;
      reachable.add(ability);
      if (ability.hasUnresolvedAbilityNavigation) {
        this.refreshLifecycleModelStatistics();
        return;
      }
      for (const target of ability.navigationTargets) {
        if (target.navigationType !== NavigationType.START_ABILITY) continue;
        const targetName = target.targetAbilityName
          .split(/[/.]/)
          .filter(Boolean)
          .at(-1)
          ?.toLowerCase();
        const targetAbility = targetName ? byName.get(targetName) : undefined;
        if (targetAbility && !reachable.has(targetAbility)) {
          pending.push(targetAbility);
        }
      }
    }

    const allOwned = new Set(
      allAbilities.flatMap(ability =>
        ability.components.map(component => component.signature.toString())
      ),
    );
    const reachableOwned = new Set(
      [...reachable].flatMap(ability =>
        ability.components.map(component => component.signature.toString())
      ),
    );
    this.abilities = allAbilities.filter(ability => reachable.has(ability));
    this.components = this.components.filter(component => {
      const signature = component.signature.toString();
      return !allOwned.has(signature) || reachableOwned.has(signature);
    });
    this.refreshLifecycleModelStatistics();
  }

  private refreshLifecycleModelStatistics(): void {
    const collectedComponents = new Map(
      this.collectedComponents.map(component => [
        component.signature.toString(),
        component,
      ]),
    );
    const reachableComponents = new Map(
      this.components.map(component => [component.signature.toString(), component]),
    );
    const ownedComponents = [...collectedComponents.entries()]
      .filter(([signature]) =>
        this.collectedOwnedComponentSignatures.has(signature)
      )
      .map(([, component]) => component);
    const reachableOwnedComponents = ownedComponents.filter(component =>
      reachableComponents.has(component.signature.toString())
    );
    const fallbackComponents = [...collectedComponents.entries()]
      .filter(([signature]) =>
        !this.collectedOwnedComponentSignatures.has(signature)
      )
      .map(([, component]) => component);
    const transitionStatistics = this.computeCallbackTransitionStatistics(
      [...reachableComponents.values()],
    );
    const ownershipExpansion = this.abilityCollector
      .getOwnershipExpansionStatistics();
    this.lifecycleModelStatistics = {
      abilities: {
        collected: this.collectedAbilitiesCount,
        reachable: this.abilities.length,
        pruned: Math.max(
          0,
          this.collectedAbilitiesCount - this.abilities.length,
        ),
      },
      pages: {
        owned: this.collectedPageComponentSignatures.size,
        unknown: this.collectedComponents.filter(component =>
          component.isEntry &&
          !this.collectedPageComponentSignatures.has(component.signature.toString())
        ).length,
      },
      components: {
        owned: ownedComponents.length,
        reachable: reachableComponents.size,
        fallback: fallbackComponents.length,
      },
      callbacks: {
        bound: reachableOwnedComponents.reduce(
          (sum, component) => sum + component.uiCallbacks.length,
          0,
        ),
        fallback: fallbackComponents.reduce(
          (sum, component) => sum + component.uiCallbacks.length,
          0,
        ),
      },
      ownership: {
        directPageRoots: this.collectedPageComponentSignatures.size,
        ...ownershipExpansion,
      },
      transitions: transitionStatistics,
      pageTransitions: this.computeDefaultPageTransitionStatistics(
        [...reachableComponents.values()],
      ),
    };
  }

  /**
   * Flat and Ability-scoped models deliberately retain the global/cross-Page
   * callback pairs.  The Page-scope creator replaces these with its actual
   * retained/pruned counts after constructing the CFG.
   */
  private computeDefaultPageTransitionStatistics(
    components: readonly ComponentInfo[],
  ): LifecycleModelStatistics['pageTransitions'] {
    const collector = this.abilityCollector;
    // Resolve ownership once per component and count targets with identical Page sets.
    const pagesByComponent = new Map(components.map(component => [
      component, new Set(collector.getPagesForComponent(component).map(page => page.id)),
    ]));
    const targetGroups = new Map<string, { pages: Set<string>; count: number }>();
    let totalCallbacks = 0;
    let boundCallbacks = 0;
    for (const component of components) {
      const pages = pagesByComponent.get(component)!;
      const count = component.uiCallbacks.length;
      totalCallbacks += count;
      if (pages.size > 0) boundCallbacks += count;
      if (count === 0) continue;
      const key = JSON.stringify([...pages].sort());
      const group = targetGroups.get(key);
      if (group) group.count += count;
      else targetGroups.set(key, { pages, count });
    }
    const candidateCallbackTransitions = totalCallbacks ** 2;
    const fallbackCallbacks = totalCallbacks - boundCallbacks;
    const conservativeFallbackTransitions = candidateCallbackTransitions - boundCallbacks ** 2;
    let legalNavigationTransitions = 0;
    for (const component of components) {
      const sourcePages = pagesByComponent.get(component)!;
      for (const callback of component.uiCallbacks) {
        const navigationPages = new Set(
          collector.getNavigationTargetPages(callback.callbackMethod).map(page => page.id),
        );
        if (navigationPages.size === 0) continue;
        for (const { pages, count } of targetGroups.values()) {
          if ([...pages].some(page => navigationPages.has(page)) &&
              ![...sourcePages].some(page => pages.has(page))) {
            legalNavigationTransitions += count;
          }
        }
      }
    }
    return {
      discoveredPages: collector.getPageInfos().length,
      boundCallbacks,
      fallbackCallbacks,
      candidateCallbackTransitions,
      retainedCallbackTransitions: candidateCallbackTransitions,
      prunedCrossPageTransitions: 0,
      conservativeFallbackTransitions,
      legalNavigationTransitions,
    };
  }

  private computeCallbackTransitionStatistics(
    components: readonly ComponentInfo[],
  ): LifecycleModelStatistics['transitions'] {
    const ownersByComponent = new Map<string, Set<string>>();
    for (const ability of this.abilities) {
      const abilityKey = ability.signature.toString();
      for (const component of ability.components) {
        const componentKey = component.signature.toString();
        let owners = ownersByComponent.get(componentKey);
        if (!owners) {
          owners = new Set<string>();
          ownersByComponent.set(componentKey, owners);
        }
        owners.add(abilityKey);
      }
    }
    const groups = new Map<string, { owners: Set<string>; count: number }>();
    let totalCallbacks = 0;
    let boundCallbacks = 0;
    for (const component of components) {
      const owners = ownersByComponent.get(component.signature.toString()) ?? new Set<string>();
      const count = component.uiCallbacks.length;
      totalCallbacks += count;
      if (owners.size > 0) boundCallbacks += count;
      if (owners.size === 0 || count === 0) continue;
      const key = JSON.stringify([...owners].sort());
      const group = groups.get(key);
      if (group) group.count += count;
      else groups.set(key, { owners, count });
    }
    const candidateCallbackTransitions = totalCallbacks ** 2;
    const conservativeFallbackTransitions = candidateCallbackTransitions - boundCallbacks ** 2;
    let prunedCrossAbilityTransitions = 0;
    for (const source of groups.values()) {
      for (const target of groups.values()) {
        if (![...source.owners].some(owner => target.owners.has(owner))) {
          prunedCrossAbilityTransitions += source.count * target.count;
        }
      }
    }
    return {
      candidateCallbackTransitions,
      retainedCallbackTransitions:
        candidateCallbackTransitions - prunedCrossAbilityTransitions,
      prunedCrossAbilityTransitions,
      conservativeFallbackTransitions,
    };
  }

  // ========================================================================
  // Step 3: 创建 DummyMain 容器
  // ========================================================================

  /**
   * 创建 DummyMain 方法的容器结构
   *
   * 创建：
   * - @extendedDummyFile 虚拟文件
   * - @extendedDummyClass 虚拟类
   * - @extendedDummyMain 方法
   */
  private createDummyMainContainer(): void {
    // 创建虚拟文件
    const dummyFile = new ArkFile(Language.JAVASCRIPT);
    dummyFile.setScene(this.scene);
    const fileSignature = new FileSignature(
      this.scene.getProjectName(),
      "@extendedDummyFile",
    );
    dummyFile.setFileSignature(fileSignature);
    this.scene.setFile(dummyFile);

    // 创建虚拟类
    const dummyClass = new ArkClass();
    dummyClass.setDeclaringArkFile(dummyFile);
    const classSignature = new ClassSignature(
      "@extendedDummyClass",
      dummyFile.getFileSignature(),
      null,
    );
    dummyClass.setSignature(classSignature);
    dummyFile.addArkClass(dummyClass);

    // 创建 DummyMain 方法
    this.dummyMain = new ArkMethod();
    this.dummyMain.setDeclaringArkClass(dummyClass);
    const methodSubSignature =
      ArkSignatureBuilder.buildMethodSubSignatureFromMethodName(
        "@extendedDummyMain",
      );
    const methodSignature = new MethodSignature(
      dummyClass.getSignature(),
      methodSubSignature,
    );
    this.dummyMain.setImplementationSignature(methodSignature);
    this.dummyMain.setLineCol(0);
    this.dummyMain.setIsGeneratedFlag(true);
    checkAndUpdateMethod(this.dummyMain, dummyClass);
    dummyClass.addMethod(this.dummyMain);
  }

  protected abstract buildDummyMainCfg(): void;

  /** Window teardown starts before component cleanup and ends before Ability destruction. */
  protected addEndInvocations(block: BasicBlock): void {
    const invokeAbilityStage = (stage: AbilityLifecycleMethodStage) => {
      for (const ability of this.abilities) {
        const method = ability.lifecycleMethods.get(stage);
        if (method) this.addMethodInvocation(
          block, this.getOrCreateClassInstance(ability.arkClass), method,
        );
      }
    };
    if (this.config.lifecycleOrder.includes(AbilityLifecycleStage.WINDOW_STAGE_WILL_DESTROY)) {
      invokeAbilityStage(AbilityLifecycleStage.WINDOW_STAGE_WILL_DESTROY);
    }
    for (const stage of [
      ComponentLifecycleStage.ABOUT_TO_DISAPPEAR,
      ComponentLifecycleStage.DETACHED,
    ]) {
      for (const component of this.components) {
        const method = component.lifecycleMethods.get(stage);
        if (method) this.addMethodInvocation(
          block, this.getOrCreateClassInstance(component.arkClass), method,
        );
      }
    }
    for (const stage of this.config.lifecycleOrder) {
      if (ABILITY_END_STAGES.has(stage) &&
          stage !== AbilityLifecycleStage.WINDOW_STAGE_WILL_DESTROY) {
        invokeAbilityStage(stage);
      }
    }
  }

  protected addStaticInitialization(cfg: Cfg, entryBlock: BasicBlock): void {
    const classType = new ClassType(this.dummyMain.getDeclaringArkClass().getSignature());
    const localThis = new Local("this", classType);
    const startingStmt = new ArkAssignStmt(localThis, new ArkThisRef(classType));
    localThis.setDeclaringStmt(startingStmt);
    entryBlock.addStmt(startingStmt);
    cfg.setStartingStmt(startingStmt);
    for (const method of this.scene.getStaticInitMethods()) {
      entryBlock.addStmt(new ArkInvokeStmt(new ArkStaticInvokeExpr(method.getSignature(), [])));
    }
  }

  // ========================================================================
  // 辅助方法：语句生成
  // ========================================================================

  /**
   * 获取或创建类实例的 Local 变量
   */
  protected getOrCreateClassInstance(arkClass: ArkClass): Local {
    const key = arkClass.getSignature().toString();

    if (this.classInstanceMap.has(key)) {
      return this.classInstanceMap.get(key)!;
    }

    const local = new Local(
      `%${this.tempLocalIndex++}`,
      new ClassType(arkClass.getSignature()),
    );
    this.classInstanceMap.set(key, local);

    return local;
  }

  /**
   * 添加类实例化语句
   */
  protected addInstanceCreation(
    block: BasicBlock,
    local: Local,
    arkClass: ArkClass,
  ): void {
    // local = new ClassName()
    const classType = local.getType() as ClassType;
    const newExpr = new ArkNewExpr(classType);
    const assignStmt = new ArkAssignStmt(local, newExpr);
    block.addStmt(assignStmt);
    local.setDeclaringStmt(assignStmt);

    // 调用构造函数
    const constructor = arkClass.getMethodWithName(CONSTRUCTOR_NAME);
    if (constructor) {
      const invokeExpr = new ArkInstanceInvokeExpr(
        local,
        constructor.getSignature(),
        [],
      );
      const invokeStmt = new ArkInvokeStmt(invokeExpr);
      block.addStmt(invokeStmt);
    }
  }

  /**
   * 添加方法调用语句（含参数生成）
   *
   * 工作流程：
   * ```
   * ┌─────────────────────────────────────────────────────────────────┐
   * │                addMethodInvocation() 流程                       │
   * ├─────────────────────────────────────────────────────────────────┤
   * │                                                                 │
   * │  输入: method (如 onCreate)                                     │
   * │         │                                                       │
   * │         ▼                                                       │
   * │  获取参数列表: method.getParameters()                           │
   * │         │                                                       │
   * │         ▼                                                       │
   * │  为每个参数创建 Local 和初始化语句:                             │
   * │  ┌─────────────────────────────────────────────┐               │
   * │  │  %temp0 = new Want()         // ClassType   │               │
   * │  │  %temp1 = new LaunchParam()  // ClassType   │               │
   * │  └─────────────────────────────────────────────┘               │
   * │         │                                                       │
   * │         ▼                                                       │
   * │  生成调用语句:                                                   │
   * │  ┌─────────────────────────────────────────────┐               │
   * │  │  ability.onCreate(%temp0, %temp1)           │               │
   * │  └─────────────────────────────────────────────┘               │
   * │                                                                 │
   * └─────────────────────────────────────────────────────────────────┘
   * ```
   */
  protected addMethodInvocation(
    block: BasicBlock,
    instanceLocal: Local,
    method: ArkMethod,
    eventType?: UIEventType,
  ): void {
    // Step 1: 为方法参数创建 Local 变量并初始化
    const paramLocals = this.createParameterLocals(method, block, eventType);

    // Step 2: 生成方法调用语句
    const invokeExpr = method.isStatic() || method.getDeclaringArkClass().isDefaultArkClass()
      ? new ArkStaticInvokeExpr(method.getSignature(), paramLocals)
      : new ArkInstanceInvokeExpr(instanceLocal, method.getSignature(), paramLocals);
    const invokeStmt = new ArkInvokeStmt(invokeExpr);
    block.addStmt(invokeStmt);

    // 打印调试信息
    if (paramLocals.length > 0) {
      console.log(
        `[LifecycleModelCreator] ${method.getName()}(${paramLocals.map((l) => l.getName()).join(", ")})`,
      );
    }
  }

  /** Preserve every argument slot, even when ArkAnalyzer has no parameter type. */
  private createParameterLocals(
    method: ArkMethod,
    block: BasicBlock,
    eventType?: UIEventType,
  ): Local[] {
    return method.getParameters().map((param, index) => {
      const paramType = param.getType() ??
        this.getParamTypeFromSuperClass(method, index) ??
        (index === 0 && eventType ? this.inferEventParamType(eventType) : undefined);
      const local = new Local(`%param${this.tempLocalIndex++}`, paramType ?? undefined);
      if (paramType instanceof ClassType) {
        const assignment = new ArkAssignStmt(local, new ArkNewExpr(paramType));
        local.setDeclaringStmt(assignment);
        block.addStmt(assignment);
        this.tryInvokeConstructor(block, local, paramType);
      }
      return local;
    });
  }

  /**
   * 从父类方法获取参数类型
   *
   * 当子类方法的参数类型未知时（常见于 SDK 继承场景），
   * 尝试从父类的同名方法获取参数类型
   */
  private getParamTypeFromSuperClass(
    method: ArkMethod,
    paramIndex: number,
  ): Type | null {
    const declaringClass = method.getDeclaringArkClass();
    const superClass = declaringClass.getSuperClass();

    if (!superClass) {
      return null;
    }

    // 在父类中查找同名方法
    const superMethod = superClass.getMethodWithName(method.getName());
    if (!superMethod) {
      return null;
    }

    const superParams = superMethod.getParameters();
    if (paramIndex < superParams.length) {
      return superParams[paramIndex].getType();
    }

    return null;
  }

  /**
   * 尝试调用对象的构造函数
   *
   * 对于 new Xxx() 创建的对象，如果有构造函数，
   * 生成对应的构造函数调用语句
   */
  private tryInvokeConstructor(
    block: BasicBlock,
    local: Local,
    classType: ClassType,
  ): void {
    // 从 Scene 获取类
    const arkClass = this.scene.getClass(classType.getClassSignature());
    if (!arkClass) {
      return;
    }

    // 查找构造函数
    const constructor = arkClass.getMethodWithName(CONSTRUCTOR_NAME);
    if (!constructor) {
      return;
    }

    // 生成构造函数调用（无参数版本）
    const invokeExpr = new ArkInstanceInvokeExpr(
      local,
      constructor.getSignature(),
      [],
    );
    const invokeStmt = new ArkInvokeStmt(invokeExpr);
    block.addStmt(invokeStmt);
  }

  /** UI and lifecycle calls share argument construction and invocation rules. */
  protected addUICallbackInvocation(
    block: BasicBlock,
    componentLocal: Local,
    callback: UICallbackInfo,
  ): void {
    this.addMethodInvocation(block, componentLocal, callback.callbackMethod, callback.eventType);
  }

  /**
   * 根据事件类型推断参数类型
   *
   * 当回调方法的参数类型未知时，根据事件类型名称推断可能的参数类型
   *
   * @param eventType 事件类型（如 'onClick', 'onTouch'）
   * @returns 推断的参数类型（ClassType）或 null
   */
  private inferEventParamType(eventType: UIEventType): ClassType | null {
    // 事件类型到参数类名的映射
    const eventParamMap: Record<string, string> = {
      onClick: "ClickEvent",
      onTouch: "TouchEvent",
      onAppear: "", // 无参数
      onDisAppear: "", // 无参数
      onChange: "string", // 基本类型，不创建对象
      onFocus: "FocusEvent",
      onBlur: "BlurEvent",
      onAreaChange: "Area",
    };

    const paramClassName = eventParamMap[eventType];

    // 无参数或基本类型的情况
    if (!paramClassName || paramClassName === "string") {
      return null;
    }

    // 尝试从 Scene 中查找对应的类
    for (const arkClass of this.scene.getClasses()) {
      if (arkClass.getName() === paramClassName) {
        return new ClassType(arkClass.getSignature());
      }
    }

    // 如果找不到类，返回 null（跳过该参数）
    console.log(
      `[LifecycleModelCreator] Event class not found: ${paramClassName}`,
    );
    return null;
  }

  /**
   * 为所有语句设置 CFG 引用
   */
  protected linkStmtsToCfg(cfg: Cfg): void {
    for (const block of cfg.getBlocks()) {
      cfg.updateStmt2BlockMap(block);
      for (const stmt of block.getStmts()) {
        stmt.setCfg(cfg);
        for (const value of [stmt.getDef(), ...stmt.getUses()]) {
          if (value instanceof Local) {
            this.dummyMain.getBody()!.addLocal(value.getName(), value);
          }
        }
        for (const value of new Set(stmt.getUses())) {
          if (value instanceof Local) value.addUsedStmt(stmt);
        }
      }
    }
  }

  // ========================================================================
  // 调试输出
  // ========================================================================

  /**
   * 打印构建摘要
   */
  private printSummary(): void {
    console.log("\n========== LifecycleModelCreator Summary ==========");
    console.log(`Abilities: ${this.abilities.length}`);
    for (const ability of this.abilities) {
      console.log(
        `  - ${ability.name} (${ability.lifecycleMethods.size} lifecycle methods)`,
      );
    }

    console.log(`Components: ${this.components.length}`);
    for (const component of this.components) {
      console.log(
        `  - ${component.name} (${component.uiCallbacks.length} UI callbacks)`,
      );
    }

    console.log(`DummyMain: ${this.dummyMain.getSignature().toString()}`);
    console.log("===================================================\n");
  }
}
