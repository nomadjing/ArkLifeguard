@Component
export struct LifecycleCard {
  @Prop title: string;
  @State tapCount: number = 0;

  aboutToAppear(): void {
    console.info(`LifecycleCard(${this.title}): aboutToAppear`);
  }

  aboutToDisappear(): void {
    console.info(`LifecycleCard(${this.title}): aboutToDisappear`);
  }

  private handleTap(): void {
    this.tapCount += 1;
    console.info(`LifecycleCard(${this.title}): onClick ${this.tapCount}`);
  }

  build() {
    Column({ space: 8 }) {
      Text(this.title)
        .fontSize(18)
      Text(`tap count: ${this.tapCount}`)
      Button('Component callback')
        .onClick(() => this.handleTap())
    }
    .padding(16)
    .border({ width: 1, color: Color.Gray })
  }
}
