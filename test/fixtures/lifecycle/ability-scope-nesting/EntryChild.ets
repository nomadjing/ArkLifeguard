@Component
export struct EntryChild {
    handleChildTap(): void {
        console.info('EntryChild tap');
    }

    build() {
        Button('Child')
            .onClick(this.handleChildTap)
    }
}
