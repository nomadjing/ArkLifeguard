@Component
struct DetailsPage {
    aboutToAppear(): void {
        console.info('Details page appears');
    }

    handleDetailsTap(): void {
        console.info('Details-only action');
    }

    build() {
        Button('Details action')
            .onClick(this.handleDetailsTap)
    }
}

@Builder
export function DetailsPageBuilder() {
    DetailsPage()
}
