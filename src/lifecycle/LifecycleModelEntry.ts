/*
 * Copyright (c) 2024-2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { Scene } from "../adapter/arkanalyzer";
import { FlatLifecycleModelCreator } from "./FlatLifecycleModelCreator";
import { LifecycleModelCreator } from "./LifecycleModelCreator";
import { LifecycleModelConfig } from "./LifecycleTypes";

/** Creates the standard compact flat DummyMain generator. */
export function createLifecycleModelCreator(
  scene: Scene,
  config?: Partial<LifecycleModelConfig>,
): LifecycleModelCreator {
  if (config !== undefined && (config === null || typeof config !== "object" || Array.isArray(config))) {
    throw new TypeError("Lifecycle configuration must be an object");
  }
  return new FlatLifecycleModelCreator(scene, config);
}
