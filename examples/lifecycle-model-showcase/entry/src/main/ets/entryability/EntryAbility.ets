import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

const TAG: string = 'EntryAbility';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    console.info(`${TAG}: onCreate`);
    this.publishMessage(want, 'EntryAbility created without a message');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    console.info(`${TAG}: onWindowStageCreate`);
    windowStage.loadContent('pages/HomePage', (error) => {
      if (error.code) {
        console.error(`${TAG}: failed to load HomePage: ${error.message}`);
      }
    });
  }

  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    console.info(`${TAG}: onNewWant`);
    this.publishMessage(want, 'EntryAbility received a new Want');
  }

  onForeground(): void {
    console.info(`${TAG}: onForeground`);
  }

  onBackground(): void {
    console.info(`${TAG}: onBackground`);
  }

  onDestroy(): void {
    console.info(`${TAG}: onDestroy`);
  }

  private publishMessage(want: Want, fallback: string): void {
    const message = want.parameters?.message as string | undefined;
    AppStorage.setOrCreate<string>('entryMessage', message ?? fallback);
  }
}
