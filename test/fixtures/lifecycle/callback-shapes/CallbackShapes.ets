function globalTap(): void {}

@Entry
@Component
struct CallbackShapes {
  handleDrag(): void {}
  handleMouse(): void {}
  handleVisible(): void {}

  build() {
    Button('events')
      .onClick(globalTap)
      .onDragEnter(this.handleDrag)
      .onMouse(this.handleMouse)
      .onVisibleAreaChange([0, 1], this.handleVisible)
  }
}
