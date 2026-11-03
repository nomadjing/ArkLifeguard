class Config { visible: boolean = true }
abstract class SafeBase {
  config?: Config = undefined
  read(): boolean { return this.config!.visible }
}
class Initialized extends SafeBase {
  constructor() { super(); this.config = new Config() }
}
abstract class UnsafeBase {
  config?: Config = undefined
  read(): boolean { return this.config!.visible }
}
class Uninitialized extends UnsafeBase {}
@Entry
@Component
struct Page {
  aboutToAppear(): void {
    const safe = new Initialized()
    safe.read()
    const unsafe = new Uninitialized()
    unsafe.read()
  }
  build() { Column() {} }
}
