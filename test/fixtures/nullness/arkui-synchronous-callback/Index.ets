@Component
struct Card {
  @Builder
  empty() {
  }

  @BuilderParam
  content: () => void = this.empty

  build() {
    Column() {
      this.content()
    }
  }
}

@Component
struct Plain {
  build() {
    Text('plain')
  }
}

@Component
struct Owner {
  build() {
    Card() {
      Text('content')
    }
    Plain()
  }
}
