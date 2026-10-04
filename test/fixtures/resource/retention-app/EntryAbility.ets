import UIAbility from '@ohos.app.ability.UIAbility';
import emitter from '@ohos.events.emitter';
class Cache { static owner: Object | null = null; }
export default class EntryAbility extends UIAbility {
    value = 1;
    onCreate(): void {
        emitter.on({eventId: 1}, () => { this.value++; });
        Cache.owner = this;
    }
    onDestroy(): void {}
}
