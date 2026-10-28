import { UIAbility } from '@kit.AbilityKit';

class Session {
  close(): void {}
}

class LifecycleState {
  static session: Session | null = new Session();
}

export default class EntryAbility extends UIAbility {
  onCreate(): void {
    LifecycleState.session = null;
  }

  onDestroy(): void {
    LifecycleState.session!.close();
  }
}
