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
 * @file LifecycleTypes.ts
 * @description 生命周期建模相关的类型定义
 *
 * 本文件定义了扩展 DummyMain 所需的核心数据结构，包括：
 * - Ability 信息结构
 * - 页面跳转关系
 * - UI 组件回调信息
 * - 生命周期阶段枚举
 */

import {
  ArkClass,
  ArkMethod,
  ClassSignature,
  ArkField,
  ViewTreeNode,
} from "../adapter/arkanalyzer";

// ============================================================================
// 第一部分：生命周期阶段定义
// ============================================================================

/**
 * Ability 生命周期阶段枚举
 *
 * 鸿蒙 UIAbility 的完整生命周期：
 * Create -> WindowStageCreate -> Foreground <-> Background -> WindowStageDestroy -> Destroy
 */
export enum AbilityLifecycleStage {
  /** Ability 实例创建 */
  CREATE = "onCreate",
  /** 窗口创建（UI 可用） */
  WINDOW_STAGE_CREATE = "onWindowStageCreate",
  /** WindowStage 销毁前，仍可访问 WindowStage 对象 */
  WINDOW_STAGE_WILL_DESTROY = "onWindowStageWillDestroy",
  /** WindowStage 恢复 */
  WINDOW_STAGE_RESTORE = "onWindowStageRestore",
  /** 进入前台（可见） */
  FOREGROUND = "onForeground",
  WILL_FOREGROUND = "onWillForeground",
  DID_FOREGROUND = "onDidForeground",
  /** 进入后台（不可见） */
  BACKGROUND = "onBackground",
  WILL_BACKGROUND = "onWillBackground",
  DID_BACKGROUND = "onDidBackground",
  /** 跨设备迁移 */
  CONTINUE = "onContinue",
  /** 已存在 Ability 收到新 Want */
  NEW_WANT = "onNewWant",
  /** 输出 Ability 调试信息 */
  DUMP = "onDump",
  /** 保存 Ability 状态 */
  SAVE_STATE = "onSaveState",
  SAVE_STATE_ASYNC = "onSaveStateAsync",
  COLLABORATE = "onCollaborate",
  CONFIGURATION_UPDATE = "onConfigurationUpdate",
  /** 分享事件 */
  SHARE = "onShare",
  /** 终止前同步准备 */
  PREPARE_TO_TERMINATE = "onPrepareToTerminate",
  /** 终止前异步准备 */
  PREPARE_TO_TERMINATE_ASYNC = "onPrepareToTerminateAsync",
  /** Ability 回退事件 */
  BACK_PRESSED = "onBackPressed",
  /** 窗口销毁 */
  WINDOW_STAGE_DESTROY = "onWindowStageDestroy",
  /** Ability 销毁 */
  DESTROY = "onDestroy",
}

/** BackupExtensionAbility 的备份与恢复生命周期。 */
export enum BackupExtensionLifecycleStage {
  BACKUP = "onBackup",
  BACKUP_EX = "onBackupEx",
  RESTORE = "onRestore",
  RESTORE_EX = "onRestoreEx",
  PROCESS = "onProcess",
}

/** FormExtensionAbility 中表单创建与后续更新的系统回调。 */
export enum FormExtensionLifecycleStage {
  ADD_FORM = "onAddForm",
  UPDATE_FORM = "onUpdateForm",
  CAST_TO_NORMAL_FORM = "onCastToNormalForm",
  CHANGE_FORM_VISIBILITY = "onChangeFormVisibility",
  FORM_EVENT = "onFormEvent",
  REMOVE_FORM = "onRemoveForm",
  ACQUIRE_FORM_STATE = "onAcquireFormState",
}

export enum UIExtensionLifecycleStage {
  SESSION_CREATE = "onSessionCreate",
  SESSION_DESTROY = "onSessionDestroy",
  /** Compatibility with HomeFlow's installed lifecycle method table. */
  SESSION_DESTORY = "onSessionDestory",
}

export type AbilityLifecycleMethodStage =
  | AbilityLifecycleStage
  | BackupExtensionLifecycleStage
  | FormExtensionLifecycleStage
  | UIExtensionLifecycleStage;

/**
 * Component 生命周期阶段枚举
 *
 * 鸿蒙 @Component 组件的生命周期
 */
export enum ComponentLifecycleStage {
  /** 组件即将出现 */
  ABOUT_TO_APPEAR = "aboutToAppear",
  /** 构建 UI */
  BUILD = "build",
  /** 首次 build 完成 */
  DID_BUILD = "onDidBuild",
  /** 组件即将消失 */
  ABOUT_TO_DISAPPEAR = "aboutToDisappear",
  /** 页面显示 */
  PAGE_SHOW = "onPageShow",
  /** 页面隐藏 */
  PAGE_HIDE = "onPageHide",
  /** 页面回退 */
  BACK_PRESS = "onBackPress",
  /** 可复用组件被重新加入组件树 */
  ABOUT_TO_REUSE = "aboutToReuse",
  /** 可复用组件被回收 */
  ABOUT_TO_RECYCLE = "aboutToRecycle",
  /** 主题应用前回调 */
  WILL_APPLY_THEME = "onWillApplyTheme",
  /** 组件按键事件入口 */
  KEY_EVENT = "onKeyEvent",
  NEW_PARAM = "onNewParam",
  DETACHED = "onDetached",
  PAGE_TRANSITION = "pageTransition",
  FORM_RECYCLE = "onFormRecycle",
  FORM_RECOVER = "onFormRecover",
  LAYOUT = "onLayout",
  PLACE_CHILDREN = "onPlaceChildren",
  MEASURE = "onMeasure",
  MEASURE_SIZE = "onMeasureSize",
}

/** Shared classification keeps collection and all three CFG generators aligned. */
export const ABILITY_START_STAGES = new Set<AbilityLifecycleMethodStage>([
  AbilityLifecycleStage.CREATE,
  AbilityLifecycleStage.WINDOW_STAGE_CREATE,
  UIExtensionLifecycleStage.SESSION_CREATE,
]);

export const ABILITY_END_STAGES = new Set<AbilityLifecycleMethodStage>([
  AbilityLifecycleStage.WINDOW_STAGE_WILL_DESTROY,
  AbilityLifecycleStage.WINDOW_STAGE_DESTROY,
  UIExtensionLifecycleStage.SESSION_DESTROY,
  UIExtensionLifecycleStage.SESSION_DESTORY,
  AbilityLifecycleStage.DESTROY,
]);

export const COMPONENT_LOOP_STAGES = Object.values(ComponentLifecycleStage).filter(
  stage => stage !== ComponentLifecycleStage.ABOUT_TO_APPEAR &&
    stage !== ComponentLifecycleStage.ABOUT_TO_DISAPPEAR &&
    stage !== ComponentLifecycleStage.DETACHED,
);

// ============================================================================
// 第二部分：Ability 信息结构
// ============================================================================

/**
 * Ability 信息接口
 *
 * 存储单个 Ability 的完整信息，包括：
 * - 类信息
 * - 生命周期方法
 * - 关联的 Component
 * - 可跳转的目标 Ability
 */
export interface AbilityInfo {
  /** Ability 的类 */
  arkClass: ArkClass;

  /** 类签名（唯一标识） */
  signature: ClassSignature;

  /** Ability 名称 */
  name: string;

  /** 生命周期方法映射：阶段 -> 方法 */
  lifecycleMethods: Map<AbilityLifecycleMethodStage, ArkMethod>;

  /** 该 Ability 关联的 UI Component 列表 */
  components: ComponentInfo[];

  /** 由 loadContent/router 直接解析到的 Page 根组件。 */
  pageComponents: ComponentInfo[];

  /** 可跳转到的目标 Ability 列表 */
  navigationTargets: AbilityNavigationTarget[];

  /** 是否是入口 Ability（在 module.json5 中配置） */
  isEntry: boolean;

}

/**
 * Component 信息接口
 *
 * 存储单个 @Component 组件的信息
 */
export interface ComponentInfo {
  /** Component 的类 */
  arkClass: ArkClass;

  /** 类签名 */
  signature: ClassSignature;

  /** Component 名称 */
  name: string;

  /** 生命周期方法映射 */
  lifecycleMethods: Map<ComponentLifecycleStage, ArkMethod>;

  /** 该 Component 中的 UI 控件回调列表 */
  uiCallbacks: UICallbackInfo[];

  /** 是否是 @Entry 组件 */
  isEntry: boolean;
}

/**
 * A declarative ArkUI Page root and the custom-component closure rendered
 * below it.  `routeNames` comes from `router_map.json`; `id` is the canonical
 * source path used by `main_pages.json` (for example, `pages/Detail`).
 */
export interface PageInfo {
  id: string;
  root: ComponentInfo;
  components: ComponentInfo[];
  routeNames: string[];
  abilityNames: string[];
}

// ============================================================================
// 第三部分：页面跳转关系
// ============================================================================

/**
 * Ability 跳转目标
 *
 * 表示一个 Ability 可以跳转到另一个 Ability 的关系
 */
export interface AbilityNavigationTarget {
  /** 目标 Ability 的名称（从 Want 中解析） */
  targetAbilityName: string;

  /** 目标 Ability 的类签名（如果能解析到） */
  targetSignature?: ClassSignature;

  /** 触发跳转的语句所在方法 */
  sourceMethod: ArkMethod;

  /** 跳转类型 */
  navigationType: NavigationType;
}

/**
 * 跳转类型枚举
 */
export enum NavigationType {
  /** startAbility - 启动新 Ability */
  START_ABILITY = "startAbility",
  /** router.pushUrl - 页面路由跳转 */
  ROUTER_PUSH = "router.pushUrl",
  /** router.replaceUrl - 页面路由替换 */
  ROUTER_REPLACE = "router.replaceUrl",
  /** 返回上一页 */
  ROUTER_BACK = "router.back",
}

// ============================================================================
// 第四部分：UI 回调信息
// ============================================================================

/**
 * UI 回调信息接口
 *
 * 表示一个 UI 控件上的事件回调
 *
 * 例如：Button().onClick(() => { ... })
 */
export interface UICallbackInfo {
  /** 控件类型（Button, Text, Image 等） */
  componentType: string;

  /** 回调事件类型（onClick, onTouch 等） */
  eventType: UIEventType;

  /** 回调方法 */
  callbackMethod: ArkMethod;

  /** 该回调依赖的状态变量 */
  relatedStateValues: ArkField[];

  /** 来自 ViewTree 的节点引用（可选） */
  viewTreeNode?: ViewTreeNode;
}

/**
 * UI 事件类型枚举
 *
 * 对应 ArkUI 中常见的交互事件
 */
export enum UIEventType {
  /** 点击事件 */
  ON_CLICK = "onClick",
  /** 触摸事件 */
  ON_TOUCH = "onTouch",
  /** 值变化事件 (TextInput, Slider, Toggle 等) */
  ON_CHANGE = "onChange",
  /** 出现事件 */
  ON_APPEAR = "onAppear",
  /** 消失事件 */
  ON_DISAPPEAR = "onDisAppear",
  /** 拖拽开始 */
  ON_DRAG_START = "onDragStart",
  ON_DRAG_ENTER = "onDragEnter",
  ON_DRAG_MOVE = "onDragMove",
  ON_DRAG_LEAVE = "onDragLeave",
  /** 拖拽释放 */
  ON_DROP = "onDrop",
  /** 获取焦点 */
  ON_FOCUS = "onFocus",
  /** 失去焦点 */
  ON_BLUR = "onBlur",
  /** 区域变化 */
  ON_AREA_CHANGE = "onAreaChange",
  /** 选择事件 (Select, Menu 等) */
  ON_SELECT = "onSelect",
  /** 提交事件 (Search, TextInput 等) */
  ON_SUBMIT = "onSubmit",
  /** 滚动事件 (List, Scroll 等) */
  ON_SCROLL = "onScroll",
  ON_KEY_EVENT = "onKeyEvent",
  ON_HOVER = "onHover",
  ON_MOUSE = "onMouse",
  ON_VISIBLE_AREA_CHANGE = "onVisibleAreaChange",
}

// ============================================================================
// 第五部分：DummyMain 构建配置
// ============================================================================

/**
 * 扩展 DummyMain 的配置选项
 */
export interface LifecycleModelConfig {
  /** 是否精细化建模 UI 回调（按控件实例化） */
  enableFineGrainedUICallbacks: boolean;

  /** 是否解析 ViewTree 提取回调 */
  enableViewTreeParsing: boolean;

  /** 生命周期方法调用顺序（可自定义） */
  lifecycleOrder: AbilityLifecycleMethodStage[];
}

/** Counts of declarations included in the standard flat model. */
export interface LifecycleModelStatistics {
  abilities: { collected: number };
  components: { collected: number };
  callbacks: { collected: number };
}

/**
 * 默认配置
 */
export const DEFAULT_LIFECYCLE_CONFIG: LifecycleModelConfig = {
  enableFineGrainedUICallbacks: true,
  enableViewTreeParsing: true,
  lifecycleOrder: [
    AbilityLifecycleStage.CREATE,
    AbilityLifecycleStage.WINDOW_STAGE_CREATE,
    UIExtensionLifecycleStage.SESSION_CREATE,
    AbilityLifecycleStage.WINDOW_STAGE_RESTORE,
    AbilityLifecycleStage.WILL_FOREGROUND,
    AbilityLifecycleStage.FOREGROUND,
    AbilityLifecycleStage.DID_FOREGROUND,
    AbilityLifecycleStage.CONTINUE,
    AbilityLifecycleStage.NEW_WANT,
    AbilityLifecycleStage.DUMP,
    AbilityLifecycleStage.SAVE_STATE,
    AbilityLifecycleStage.SAVE_STATE_ASYNC,
    AbilityLifecycleStage.COLLABORATE,
    AbilityLifecycleStage.CONFIGURATION_UPDATE,
    AbilityLifecycleStage.SHARE,
    AbilityLifecycleStage.BACK_PRESSED,
    AbilityLifecycleStage.WILL_BACKGROUND,
    AbilityLifecycleStage.BACKGROUND,
    AbilityLifecycleStage.DID_BACKGROUND,
    AbilityLifecycleStage.PREPARE_TO_TERMINATE,
    AbilityLifecycleStage.PREPARE_TO_TERMINATE_ASYNC,
    AbilityLifecycleStage.WINDOW_STAGE_WILL_DESTROY,
    AbilityLifecycleStage.WINDOW_STAGE_DESTROY,
    UIExtensionLifecycleStage.SESSION_DESTROY,
    UIExtensionLifecycleStage.SESSION_DESTORY,
    AbilityLifecycleStage.DESTROY,
    BackupExtensionLifecycleStage.BACKUP,
    BackupExtensionLifecycleStage.BACKUP_EX,
    BackupExtensionLifecycleStage.RESTORE,
    BackupExtensionLifecycleStage.RESTORE_EX,
    BackupExtensionLifecycleStage.PROCESS,
    ...Object.values(FormExtensionLifecycleStage),
  ],
};
