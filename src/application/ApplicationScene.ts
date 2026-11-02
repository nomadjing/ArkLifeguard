import fs from 'node:fs';
import path from 'node:path';
import { Scene, SceneConfig, type Sdk } from '../adapter/arkanalyzer';
import {
    APPLICATION_IGNORE_FILE_NAMES,
    isApplicationSource,
} from './SourceScanRules';

/** Build ArkAnalyzer's input set from application source files only. */
export function createApplicationSceneConfig(
    projectName: string,
    projectPath: string,
    sdks: Sdk[]
): SceneConfig {
    const config = new SceneConfig({
        ignoreFileNames: [...APPLICATION_IGNORE_FILE_NAMES],
    });
    config.buildConfig(projectName, projectPath, sdks);

    const realProjectPath = fs.realpathSync(projectPath);
    const files = config.getProjectFiles();
    const applicationFiles = files.filter(file =>
        isApplicationSource(realProjectPath, file)
    );
    files.splice(0, files.length, ...applicationFiles);
    return config;
}

export function buildApplicationScene(
    projectName: string,
    projectPath: string,
    sdks: Sdk[],
    inferTypes = true
): Scene {
    const config = createApplicationSceneConfig(projectName, projectPath, sdks);
    const scene = new Scene();
    scene.buildSceneFromProjectDir(config);
    if (inferTypes) scene.inferTypes();
    return scene;
}
