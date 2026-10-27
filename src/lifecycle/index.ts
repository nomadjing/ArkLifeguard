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

/** Standard compact flat DummyMain generation and shared collection utilities. */

// ============================================================================
// 导出类型定义
// ============================================================================

export {
    // 生命周期阶段枚举
    AbilityLifecycleStage,
    BackupExtensionLifecycleStage,
    FormExtensionLifecycleStage,
    UIExtensionLifecycleStage,
    AbilityLifecycleMethodStage,
    ComponentLifecycleStage,
    
    // 信息接口
    AbilityInfo,
    ComponentInfo,
    PageInfo,
    UICallbackInfo,
    
    // 导航相关
    AbilityNavigationTarget,
    NavigationType,
    
    // 事件类型
    UIEventType,
    
    // 配置
    LifecycleModelConfig,
    LifecycleModelStatistics,
    DEFAULT_LIFECYCLE_CONFIG,
} from './LifecycleTypes';

export { AbilityCollector } from './AbilityCollector';
export { ViewTreeCallbackExtractor, extractUICallbacks } from './ViewTreeCallbackExtractor';
export { LifecycleModelCreator } from './LifecycleModelCreator';
export {
    FlatLifecycleModelCreator,
} from './FlatLifecycleModelCreator';
export {
    createLifecycleModelCreator,
} from './LifecycleModelEntry';
export { NavigationAnalyzer, analyzeNavigation, NavigationAnalysisResult } from './NavigationAnalyzer';
