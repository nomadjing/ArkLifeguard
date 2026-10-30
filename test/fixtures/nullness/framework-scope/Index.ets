class Account { name: string = 'account'; touch(): void {} }
declare function external(callback: () => void): void;
@Entry
@Component
struct FrameworkScope {
  @State account: Account | null = null
  aboutToAppear(): void {
    external(() => {
      const callbackLocal: Account | null = null
      callbackLocal!.touch() // callback-local check, no registration-time execution assumption
    })
  }
  build() {
    Column() {
      Text(this.account!.name) // excluded: depends on framework state initialization
      Button('local').onClick(() => {
        const local: Account | null = null
        local!.touch() // retained: local defect, independent of framework order
      })
      Button('write').onClick(() => {
        this.account = null
        this.account!.touch() // retained: concrete write in this callback
      })
    }
  }
}
