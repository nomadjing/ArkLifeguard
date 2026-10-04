import UIAbility from '@ohos.app.ability.UIAbility';
import http from '@ohos.net.http';

export default class EntryAbility extends UIAbility {
    onCreate(): void {
        const request = http.createHttp();
    }

    onForeground(): void {
        const request = http.createHttp();
        request.destroy();
    }

    onDestroy(): void {}
}
