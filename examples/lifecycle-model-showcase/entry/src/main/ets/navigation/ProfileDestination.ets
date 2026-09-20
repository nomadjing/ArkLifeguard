@Builder
export function ProfileDestinationBuilder() {
  ProfileDestination();
}

@Component
export struct ProfileDestination {
  aboutToAppear(): void {
    console.info('ProfileDestination: aboutToAppear');
  }

  aboutToDisappear(): void {
    console.info('ProfileDestination: aboutToDisappear');
  }

  build() {
    NavDestination() {
      Column({ space: 12 }) {
        Text('Profile NavDestination')
          .fontSize(22)
        Text('Created through NavPathStack.pushPathByName')
      }
      .width('100%')
      .padding(24)
    }
    .title('Profile')
  }
}
