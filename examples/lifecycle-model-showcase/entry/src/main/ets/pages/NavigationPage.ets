@Entry
@Component
struct NavigationPage {
  private pathStack: NavPathStack = new NavPathStack();

  aboutToAppear(): void {
    console.info('NavigationPage: aboutToAppear');
  }

  onPageShow(): void {
    console.info('NavigationPage: onPageShow');
  }

  onPageHide(): void {
    console.info('NavigationPage: onPageHide');
  }

  aboutToDisappear(): void {
    console.info('NavigationPage: aboutToDisappear');
  }

  private openProfile(): void {
    this.pathStack.pushPathByName('ProfileDestination', {
      userId: 7
    });
  }

  private openSettings(): void {
    this.pathStack.pushPath({
      name: 'SettingsDestination',
      param: { source: 'NavigationPage' }
    });
  }

  build() {
    Navigation(this.pathStack) {
      Column({ space: 16 }) {
        Text('Navigation root')
          .fontSize(24)
        Button('Push profile by name')
          .onClick(() => this.openProfile())
        Button('Push settings by NavPathInfo')
          .onClick(() => this.openSettings())
      }
      .width('100%')
      .padding(24)
    }
    .title('Navigation showcase')
    .mode(NavigationMode.Stack)
  }
}
