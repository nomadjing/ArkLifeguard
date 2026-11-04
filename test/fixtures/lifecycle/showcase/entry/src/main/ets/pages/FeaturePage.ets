import { common, Want } from '@kit.AbilityKit';

@Entry
@Component
struct FeaturePage {
  @StorageProp('featureMessage') featureMessage: string = 'No message from EntryAbility';

  aboutToAppear(): void {
    console.info('FeaturePage: aboutToAppear');
  }

  onPageShow(): void {
    console.info('FeaturePage: onPageShow');
  }

  onPageHide(): void {
    console.info('FeaturePage: onPageHide');
  }

  aboutToDisappear(): void {
    console.info('FeaturePage: aboutToDisappear');
  }

  private replyToEntryAbility(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const want: Want = {
      bundleName: 'com.example.lifecycle.showcase',
      abilityName: 'EntryAbility',
      parameters: {
        message: 'Reply from FeatureAbility/FeaturePage'
      }
    };
    context.startAbility(want);
  }

  build() {
    Column({ space: 16 }) {
      Text('FeatureAbility Page')
        .fontSize(24)
      Text(this.featureMessage)
      Button('Send Want back to EntryAbility')
        .onClick(() => this.replyToEntryAbility())
    }
    .width('100%')
    .height('100%')
    .padding(24)
    .justifyContent(FlexAlign.Center)
  }
}
