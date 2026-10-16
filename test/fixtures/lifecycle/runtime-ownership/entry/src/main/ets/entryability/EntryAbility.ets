import UIAbility from '@ohos.app.ability.UIAbility';
export default class EntryAbility extends UIAbility {
 onWindowStageCreate(windowStage: any) { windowStage.loadContent('pages/Index'); }
}
