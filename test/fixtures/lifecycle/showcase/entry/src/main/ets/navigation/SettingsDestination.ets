@Builder
export function SettingsDestinationBuilder() {
  SettingsDestination();
}

@Component
export struct SettingsDestination {
  aboutToAppear(): void {
    console.info('SettingsDestination: aboutToAppear');
  }

  aboutToDisappear(): void {
    console.info('SettingsDestination: aboutToDisappear');
  }

  build() {
    NavDestination() {
      Column({ space: 12 }) {
        Text('Settings NavDestination')
          .fontSize(22)
        Text('Created through NavPathStack.pushPath')
      }
      .width('100%')
      .padding(24)
    }
    .title('Settings')
  }
}
