import UIAbility from '@ohos.app.ability.UIAbility';

class Handle {
    static open(): Handle { return new Handle(); }
    release(): void {}
}

export default class EntryAbility extends UIAbility {
    private handle?: Handle;

    onCreate(): void {
        this.handle = Handle.open();
    }

    onDestroy(): void {
        this.handle?.release();
    }
}
