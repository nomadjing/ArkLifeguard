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
 * @file ViewTreeCallbackExtractor.ts
 * @description 从 ViewTree 中提取 UI 回调信息
 *
 * 本模块负责：
 * - 遍历 Component 的 ViewTree
 * - 提取每个 UI 控件上的事件回调（onClick, onTouch 等）
 * - 建立控件与回调方法的精确关联
 *
 * 这是对原有 DummyMainCreater.getCallbackMethods() 的精细化扩展
 */

import {
  Scene,
  ArkClass,
  ArkMethod,
  ViewTreeNode,
  ClassSignature,
  MethodSignature,
  ArkInstanceFieldRef,
  Constant,
  FunctionType,
  AliasType,
  Stmt,
} from "../adapter/arkanalyzer";
//自定义模块导入
import { UICallbackInfo, UIEventType, ComponentInfo } from "./LifecycleTypes";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * UI 事件方法名称列表
 */
const UI_EVENT_METHODS = new Set<string>(Object.values(UIEventType));

// ============================================================================
// ViewTreeCallbackExtractor 类
// ============================================================================

/**
 * ViewTree 回调提取器
 *
 * 功能：从 ViewTree 中精细化提取 UI 回调信息
 *
 * 与原有 getCallbackMethods 的区别：
 * - 原方法：直接收集所有 onClick 等方法，不区分控件
 * - 本方法：按控件提取，保留控件类型、状态变量依赖等上下文
 *
 * 使用方式：
 * ```typescript
 * const extractor = new ViewTreeCallbackExtractor(scene);
 * const callbacks = extractor.extractFromComponent(componentClass);
 * ```
 */
export class ViewTreeCallbackExtractor {
  /** 分析场景 */
  private scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 从 Component 类中提取所有 UI 回调
   *
   * @param componentClass Component 类
   * @returns UI 回调信息数组
   */
  public extractFromComponent(componentClass: ArkClass): UICallbackInfo[] {
    try {
      return this.extractFromComponentUnsafe(componentClass);
    } catch (error) {
      // ArkAnalyzer 1.0.90 may fail while resolving a ViewTree method whose
      // signature contains mutually recursive generic types. Skip that tree
      // rather than abort the project; its UI callbacks remain unavailable.
      if (!(error instanceof RangeError)) {
        throw error;
      }
      console.warn(
        `[ViewTreeCallbackExtractor] Skipping ViewTree for ${componentClass.getName()}: ${error.message}`,
      );
      return [];
    }
  }

  private extractFromComponentUnsafe(componentClass: ArkClass): UICallbackInfo[] {
    const callbacks: UICallbackInfo[] = [];

    // 获取 Component 的 ViewTree
    const viewTree = componentClass.getViewTree();
    if (!viewTree) {
      console.log(
        `[ViewTreeCallbackExtractor] No ViewTree for ${componentClass.getName()}`,
      );
      return callbacks;
    }

    // 获取根节点
    const root = viewTree.getRoot();
    if (!root) {
      console.log(
        `[ViewTreeCallbackExtractor] Empty ViewTree for ${componentClass.getName()}`,
      );
      return callbacks;
    }

    // 遍历 ViewTree，提取回调
    this.walkViewTree(root, callbacks, componentClass);

    return callbacks;
  }

  /**
   * 为 ComponentInfo 填充 UI 回调
   *
   * @param componentInfo Component 信息（会被修改）
   */
  public fillComponentCallbacks(componentInfo: ComponentInfo): void {
    const callbacks = this.extractFromComponent(componentInfo.arkClass);
    componentInfo.uiCallbacks = callbacks;
  }

  /**
   * 批量提取多个 Component 的回调
   *
   * @param components Component 信息数组
   */
  public fillAllComponentCallbacks(components: ComponentInfo[]): void {
    for (const component of components) {
      this.fillComponentCallbacks(component);
    }
  }

  // ========================================================================
  // 私有方法：ViewTree 遍历
  // ========================================================================

  /**
   * 递归遍历 ViewTree 节点
   *
   * @param node 当前节点
   * @param callbacks 回调收集数组
   * @param componentClass 所属 Component 类
   */
  private walkViewTree(
    node: ViewTreeNode,
    callbacks: UICallbackInfo[],
    componentClass: ArkClass,
    visited: Set<ViewTreeNode> = new Set(),
  ): void {
    // 防止 @Builder 自引用（如 .bindMenu(this.SortMenu) 在 SortMenu 内部）导致无限递归
    if (visited.has(node)) return;
    visited.add(node);

    // 提取当前节点的回调
    const nodeCallbacks = this.extractNodeCallbacks(node, componentClass);
    callbacks.push(...nodeCallbacks);

    // Expanded custom-component trees are collected separately with their own
    // receiver and Page ownership. Attributes on this node still belong here.
    if (node.signature instanceof ClassSignature &&
        node.signature.toString() !== componentClass.getSignature().toString()) return;

    // 递归处理子节点
    for (const child of node.children) {
      this.walkViewTree(child, callbacks, componentClass, visited);
    }
  }

  /**
   * 从单个 ViewTree 节点提取回调
   *
   * @param node ViewTree 节点
   * @param componentClass 所属 Component 类
   * @returns 该节点的回调信息数组
   */
  private extractNodeCallbacks(
    node: ViewTreeNode,
    componentClass: ArkClass,
  ): UICallbackInfo[] {
    const callbacks: UICallbackInfo[] = [];

    // 遍历节点的 attributes（属性和事件）
    for (const [attributeName, attributeValue] of node.attributes) {
      // 检查是否是事件属性
      if (!this.isEventAttribute(attributeName)) {
        continue;
      }

      // 尝试解析回调方法
      for (const callbackMethod of this.resolveCallbackMethods(attributeValue, componentClass)) {
        callbacks.push({
          componentType: node.name,
          eventType: attributeName as UIEventType,
          callbackMethod,
          relatedStateValues: [...node.stateValues],
          viewTreeNode: node,
        });
      }
    }

    return callbacks;
  }

  // ========================================================================
  // 私有方法：辅助函数
  // ========================================================================

  /**
   * 判断属性名是否是事件属性
   */
  private isEventAttribute(attributeName: string): boolean {
    return UI_EVENT_METHODS.has(attributeName);
  }

  /** Resolve all targets, including typed function arguments retained in registration IR. */
  private resolveCallbackMethods(
    [stmt, values]: [Stmt, (Constant | ArkInstanceFieldRef | MethodSignature)[]],
    componentClass: ArkClass,
  ): ArkMethod[] {
    const methods = new Map<string, ArkMethod>();
    const add = (method: ArkMethod | null) => {
      if (method) methods.set(method.getSignature().toString(), method);
    };
    for (const value of values) add(this.resolveFromSingleValue(value, componentClass));
    for (const arg of stmt.getInvokeExpr()?.getArgs() ?? []) {
      let type = arg.getType();
      const visited = new Set<AliasType>();
      while (type instanceof AliasType && !visited.has(type)) {
        visited.add(type);
        type = type.getOriginalType();
      }
      if (type instanceof FunctionType) add(this.scene.getMethod(type.getMethodSignature()));
    }
    return [...methods.values()];
  }

  /**
   * 从单个值解析回调方法
   *
   * @param value 关联值（MethodSignature | ArkInstanceFieldRef | Constant）
   * @param componentClass 所属 Component 类
   * @returns 解析到的方法
   */
  private resolveFromSingleValue(
    value: MethodSignature | ArkInstanceFieldRef | Constant,
    componentClass: ArkClass,
  ): ArkMethod | null {
    // 情况 1: 直接是方法签名
    // 代码形式: Button().onClick(this.handleClick)
    // ArkAnalyzer 可能将 this.handleClick 解析为 MethodSignature
    if (value instanceof MethodSignature) {
      return this.resolveFromMethodSignature(value, componentClass);
    }

    // 情况 2: 实例字段引用
    // 代码形式: Button().onClick(this.handleClick)
    // 其中 this.handleClick 可能被表示为 ArkInstanceFieldRef
    if (value instanceof ArkInstanceFieldRef) {
      return this.resolveFromFieldRef(value, componentClass);
    }

    // 情况 3: 字符串常量（方法名）
    // 代码形式: Button().onClick('handleClick')（较少见）
    if (value instanceof Constant) {
      return this.resolveFromConstant(value, componentClass);
    }

    return null;
  }

  /**
   * 从方法签名解析回调方法
   *
   * 处理形式: onClick(this.handleClick) 其中 handleClick 已解析为 MethodSignature
   */
  private resolveFromMethodSignature(
    sig: MethodSignature,
    componentClass: ArkClass,
  ): ArkMethod | null {
    // 方法 1: 从 Scene 全局查找
    const methodFromScene = this.scene.getMethod(sig);
    if (methodFromScene) {
      return methodFromScene;
    }

    // 方法 2: 从当前类中按签名查找
    const methodFromClass = componentClass.getMethod(sig);
    if (methodFromClass) {
      return methodFromClass;
    }

    // 方法 3: 从当前类中按名称查找（签名匹配失败时的后备方案）
    const methodName = sig.getMethodSubSignature().getMethodName();
    const methodByName = componentClass.getMethodWithName(methodName);
    if (methodByName) {
      return methodByName;
    }

    // 方法 4: 检查父类
    const superClass = this.getSuperClass(componentClass);
    if (superClass) {
      const methodFromSuper = superClass.getMethodWithName(methodName);
      if (methodFromSuper) {
        return methodFromSuper;
      }
    }

    return null;
  }

  /**
   * 从字段引用解析回调方法
   *
   * 处理形式: onClick(this.handleClick) 其中 this.handleClick 是 ArkInstanceFieldRef
   */
  private resolveFromFieldRef(
    fieldRef: ArkInstanceFieldRef,
    componentClass: ArkClass,
  ): ArkMethod | null {
    const fieldName = fieldRef.getFieldName();

    // 尝试将字段名作为方法名查找
    // 因为 this.handleClick 中的 handleClick 可能是方法名
    const method = componentClass.getMethodWithName(fieldName);
    if (method) {
      return method;
    }

    // 检查父类
    const superClass = this.getSuperClass(componentClass);
    if (superClass) {
      const methodFromSuper = superClass.getMethodWithName(fieldName);
      if (methodFromSuper) {
        return methodFromSuper;
      }
    }

    // 如果找不到方法，可能是真正的字段（存储了函数引用）
    // 这种情况较复杂，暂时不处理
    console.log(
      `[ViewTreeCallbackExtractor] Field ref '${fieldName}' is not a method`,
    );
    return null;
  }

  /**
   * 从常量解析回调方法
   *
   * 处理形式: onClick('handleClick')（字符串形式的方法名）
   */
  private resolveFromConstant(
    constant: Constant,
    componentClass: ArkClass,
  ): ArkMethod | null {
    const value = constant.getValue();

    // 检查是否是字符串类型
    if (typeof value !== "string") {
      return null;
    }

    // 将字符串作为方法名查找
    const method = componentClass.getMethodWithName(value);
    if (method) {
      return method;
    }

    // 检查父类
    const superClass = this.getSuperClass(componentClass);
    if (superClass) {
      return superClass.getMethodWithName(value);
    }

    return null;
  }

  /**
   * 获取父类
   */
  private getSuperClass(arkClass: ArkClass): ArkClass | null {
    return arkClass.getSuperClass();
  }

}

// ============================================================================
// 导出辅助函数
// ============================================================================

/**
 * 快速提取 Component 的所有 UI 回调
 *
 * @param scene 分析场景
 * @param componentClass Component 类
 * @returns UI 回调信息数组
 */
export function extractUICallbacks(
  scene: Scene,
  componentClass: ArkClass,
): UICallbackInfo[] {
  const extractor = new ViewTreeCallbackExtractor(scene);
  return extractor.extractFromComponent(componentClass);
}
