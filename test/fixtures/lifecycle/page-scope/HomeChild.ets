@Component
export struct HomeChild {
    handleChildTap(): void {
        console.info('HomeChild tap');
    }

    build() {
        Button('Child action')
            .onClick(this.handleChildTap)
    }
}
