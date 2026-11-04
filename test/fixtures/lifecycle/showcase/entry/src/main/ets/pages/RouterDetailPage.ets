import router from '@ohos.router';

@Entry
@Component
struct RouterDetailPage {
  aboutToAppear(): void {
    console.info('RouterDetailPage: aboutToAppear');
  }

  onPageShow(): void {
    console.info('RouterDetailPage: onPageShow');
  }

  onPageHide(): void {
    console.info('RouterDetailPage: onPageHide');
  }

  aboutToDisappear(): void {
    console.info('RouterDetailPage: aboutToDisappear');
  }

  private goBack(): void {
    router.back();
  }

  build() {
    Column({ space: 16 }) {
      Text('router.pushUrl destination')
        .fontSize(24)
      Button('router.back')
        .onClick(() => this.goBack())
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
