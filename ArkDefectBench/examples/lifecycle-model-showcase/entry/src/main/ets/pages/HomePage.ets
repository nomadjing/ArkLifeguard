import { common, Want } from '@kit.AbilityKit';
import router from '@ohos.router';
import { LifecycleCard } from '../components/LifecycleCard';

@Entry
@Component
struct HomePage {
  @StorageProp('entryMessage') entryMessage: string = 'No Ability message yet';

  aboutToAppear(): void {
    console.info('HomePage: aboutToAppear');
  }

  onPageShow(): void {
    console.info('HomePage: onPageShow');
  }

  onPageHide(): void {
    console.info('HomePage: onPageHide');
  }

  aboutToDisappear(): void {
    console.info('HomePage: aboutToDisappear');
  }

  private openRouterDetail(): void {
    router.pushUrl({
      url: 'pages/RouterDetailPage',
      params: { source: 'HomePage' }
    });
  }

  private openNavigationDemo(): void {
    router.pushUrl({ url: 'pages/NavigationPage' });
  }

  private openFeatureAbility(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const want: Want = {
      bundleName: 'com.example.lifecycle.showcase',
      abilityName: 'FeatureAbility',
      parameters: {
        message: 'Hello from EntryAbility/HomePage'
      }
    };
    context.startAbility(want);
  }

  build() {
    Scroll() {
      Column({ space: 12 }) {
        Text('Lifecycle Model Showcase')
          .fontSize(26)
          .fontWeight(FontWeight.Bold)
        Text(this.entryMessage)
        LifecycleCard({ title: 'Nested custom component' })
        Button('Open router page')
          .onClick(() => this.openRouterDetail())
        Button('Open Navigation page')
          .onClick(() => this.openNavigationDemo())
        Button('Start FeatureAbility with Want')
          .onClick(() => this.openFeatureAbility())
      }
      .width('100%')
      .padding(24)
    }
  }
}
