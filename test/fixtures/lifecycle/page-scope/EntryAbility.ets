import UIAbility from '@ohos.app.ability.UIAbility';
import window from '@ohos.window';

export default class EntryAbility extends UIAbility {
    onCreate(want: Want, launchParam: LaunchParam): void {
        console.info('EntryAbility create');
    }

    onWindowStageCreate(windowStage: window.WindowStage): void {
        windowStage.loadContent('pages/HomePage', () => {});
    }

    onForeground(): void {
        console.info('EntryAbility foreground');
    }
}
