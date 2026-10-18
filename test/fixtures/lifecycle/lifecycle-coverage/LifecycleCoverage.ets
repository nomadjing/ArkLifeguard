class UIAbility {
}

class BackupExtensionAbility {
}

class FormExtensionAbility {}
class UIExtensionAbility {}
class LifecycleEvent {}

class FullUIAbility extends UIAbility {
  onCreate(): void {}
  onWindowStageCreate(): void {}
  onWindowStageWillDestroy(): void {}
  onWindowStageDestroy(): void {}
  onWindowStageRestore(): void {}
  onForeground(): void {}
  onWillForeground(): void {}
  onDidForeground(): void {}
  onBackground(): void {}
  onWillBackground(): void {}
  onDidBackground(): void {}
  onContinue(): void {}
  onNewWant(): void {}
  onDump(): void {}
  onSaveState(): void {}
  onSaveStateAsync(): void {}
  onCollaborate(): void {}
  onConfigurationUpdate(): void {}
  onShare(): void {}
  onPrepareToTerminate(): void {}
  onPrepareToTerminateAsync(): void {}
  onBackPressed(): void {}
  onDestroy(): void {}
}

class FullBackupAbility extends BackupExtensionAbility {
  onBackup(): void {}
  onBackupEx(): void {}
  onRestore(): void {}
  onRestoreEx(): void {}
  onProcess(): void {}
}

class FullFormAbility extends FormExtensionAbility {
  onAddForm(): void {}
  onCastToNormalForm(): void {}
  onUpdateForm(): void {}
  onChangeFormVisibility(): void {}
  onFormEvent(): void {}
  onRemoveForm(): void {}
  onAcquireFormState(): void {}
}

class FullUIExtensionAbility extends UIExtensionAbility {
  onSessionCreate(): void {}
  onSessionDestroy(): void {}
  onSessionDestory(): void {}
}

@Entry
@Component
struct FullComponent {
  aboutToAppear(): void {}
  onWillApplyTheme(): void {}
  build(): void {}
  onDidBuild(): void {}
  onPageShow(): void {}
  onBackPress(): void {}
  onNewParam(first: unknown, second: LifecycleEvent): void {}
  onKeyEvent(): void {}
  aboutToRecycle(): void {}
  aboutToReuse(): void {}
  onPageHide(): void {}
  aboutToDisappear(): void {}
  onDetached(): void {}
  pageTransition(): void {}
  onFormRecycle(): void {}
  onFormRecover(): void {}
  onLayout(): void {}
  onPlaceChildren(): void {}
  onMeasure(): void {}
  onMeasureSize(): void {}
}
