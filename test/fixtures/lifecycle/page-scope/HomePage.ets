import router from '@ohos.router';
import { HomeChild } from './HomeChild';

@Component
struct HomePage {
    aboutToAppear(): void {
        console.info('Home page appears');
    }

    handleHomeTap(): void {
        console.info('Home-only action');
    }

    navigateToDetails(): void {
        router.pushUrl({ url: 'pages/DetailsPage' });
    }

    build() {
        Column() {
            Button('Home action')
                .onClick(this.handleHomeTap)
            Button('Open details')
                .onClick(this.navigateToDetails)
            HomeChild()
        }
    }
}
