import emitter from '@ohos.events.emitter';
import EventHub from '@ohos.app.ability.EventHub';
const SHARED_EVENT = 42;
class Roots { static owner: Object | null = null; static buffer: ArrayBuffer | null = null; static items: Object[] = []; static map: Map<number, Object> = new Map(); static weak: WeakRef<Object> | null = null; static first: EventHub; static second: EventHub; static interval: number = 0; static other: number = 0; static PLAYER_EVENT = { eventId: 77 }; }
class EventLeak { value = 1; onCreate() { emitter.on({eventId: 1}, () => { this.value++; }); } onDestroy() {} }
class EventRelease { value = 1; listener = () => { this.value++; }; onCreate() { emitter.on({eventId: 1}, this.listener); } onDestroy() { emitter.off(1, this.listener); } }
class WrongEvent { value = 1; listener = () => { this.value++; }; onCreate() { emitter.on({eventId: 1}, this.listener); } onDestroy() { emitter.off(2, this.listener); } }
class WrongCallback { value = 1; listener = () => { this.value++; }; onCreate() { emitter.on({eventId: 1}, this.listener); } onDestroy() { emitter.off(1, () => { this.value++; }); } }
class OffAll { value = 1; onCreate() { emitter.on({eventId: 1}, () => { this.value++; }); } onDestroy() { emitter.off(1); } }
class NoCapture { onCreate() { emitter.on({eventId: 1}, () => { console.log('tick'); }); } onDestroy() {} }
class CapturedCellCleared { value = 1; onCreate() { let owner: CapturedCellCleared | null = this; emitter.on({eventId: 1}, () => { owner?.value; }); owner = null; } onDestroy() {} }
class IntervalLeak { value = 1; timer = 0; onCreate() { this.timer = setInterval(() => { this.value++; }, 1); } onDestroy() {} }
class IntervalRelease { value = 1; timer = 0; onCreate() { this.timer = setInterval(() => { this.value++; }, 1); } onDestroy() { const alias = this.timer; clearInterval(alias); } }
class TimerFieldHelper { timer = 0; other = 0; onCreate() { this.timer = setInterval(() => {}, 10); } unrelated() { this.other = 1; } cleanup() { clearInterval(this.timer); } cleanupWrapper() { this.cleanup(); } }
class CallbackCleanup { value = 1; listener = () => { this.value++; }; onCreate() { emitter.on({eventId: 1}, this.listener); } onDestroy() { Promise.resolve().then(() => { emitter.off(1, this.listener); }); } }
class WrongRegistrar { value = 1; listener = () => { this.value++; }; onCreate() { Roots.first.on('tick', this.listener); } onDestroy() { Roots.second.off('tick', this.listener); } }
class LocalRegistrar { value = 1; hub = new EventHub(); onCreate() { this.hub.on('tick', () => { this.value++; }); } onDestroy() {} }
class BoundIdentity { value = 1; callback() { this.value++; } onCreate() { emitter.on({eventId: 1}, this.callback.bind(this)); } onDestroy() { emitter.off(1, this.callback.bind(this)); } }
class StaticRetained { onCreate() { Roots.owner = this; } onDestroy() {} }
class StaticCleared { onCreate() { Roots.owner = this; } onDestroy() { Roots.owner = null; } }
class BufferRetained { onCreate() { const buffer = new ArrayBuffer(1024); Roots.buffer = buffer; } onDestroy() {} }
class BufferLocal { onCreate() { const buffer = new ArrayBuffer(1024); } onDestroy() {} }
class SelfCycle { cycle: SelfCycle; onCreate() { this.cycle = this; } onDestroy() {} }
class ContainerRetained { onCreate() { Roots.items.push(this); } onDestroy() {} }
class ContainerCleared { onCreate() { Roots.items.push(this); } onDestroy() { Roots.items = []; } }
class MapRetained { onCreate() { Roots.map.set(1, this); } onDestroy() {} }
class MapDeleted { onCreate() { Roots.map.set(1, this); } onDestroy() { Roots.map.delete(1); } }
class WeakRetained { onCreate() { Roots.weak = new WeakRef(this); } onDestroy() {} }
class PartialClear { onCreate() { Roots.owner = this; } onDestroy(clear: boolean) { if (clear) Roots.owner = null; } }
class CapturedCellRetained { value = 1; onCreate() { const owner = this; emitter.on({eventId: 1}, () => { owner.value; }); } onDestroy() {} }
class CapturedBuffer { onCreate() { const buffer = new ArrayBuffer(1024); emitter.on({eventId: 1}, () => { buffer.byteLength; }); } onDestroy() {} }
class DynamicThis { value = 1; onCreate() { emitter.on({eventId: 1}, function () { this.value++; }); } onDestroy() {} }
class OnceListener { value = 1; onCreate() { emitter.once({eventId: 1}, () => { this.value++; }); } onDestroy() {} }
class TimeoutListener { value = 1; onCreate() { setTimeout(() => { this.value++; }, 1); } onDestroy() {} }
class PartialOff { value = 1; listener = () => { this.value++; }; onCreate() { emitter.on({eventId: 1}, this.listener); } onDestroy(clear: boolean) { if (clear) emitter.off(1, this.listener); } }
class WrongTimer { value = 1; onCreate() { setInterval(() => { this.value++; }, 1); } onDestroy() { clearInterval(99); } }
class HelperRegistration { value = 1; listener = () => { this.value++; }; register(callback: () => void) { emitter.on({eventId: 1}, callback); } onCreate() { this.register(this.listener); } onDestroy() { emitter.off(1, this.listener); } }
class TwoListeners { value = 1; onCreate() { emitter.on({eventId: 1}, () => { this.value++; }); emitter.on({eventId: 2}, () => { this.value++; }); } onDestroy() {} }
class MethodIdentity { value = 1; callback() { this.value++; } onCreate() { emitter.on({eventId: 1}, this.callback); } onDestroy() { emitter.off(1, this.callback); } }
class UnknownCallback { onCreate() { emitter.on({eventId: 1}, undefined as (() => void)); Roots.owner = this; } onDestroy() {} }
class ThrowingCleanup { value = 1; listener = () => { this.value++; }; onCreate() { emitter.on({eventId: 1}, this.listener); } clean(stop: boolean) { if (stop) throw new Error('stop'); emitter.off(1, this.listener); } onDestroy() { try { this.clean(true); } catch (error) {} } }
class StableFieldListener {
  value = 1;
  listener: () => void = () => { this.value++; };
  callback = () => { this.value++; };
  onCreate() {
    this.listener = this.callback;
    emitter.on({eventId: 1}, this.listener);
  }
  onDestroy() {
    this.listener = this.callback;
    emitter.off(1, this.listener);
  }
}
class ReplacedFieldListener {
  value = 1;
  first = () => { this.value++; };
  second = () => { this.value += 2; };
  listener: () => void = this.first;
  onCreate() {
    this.listener = this.first;
    emitter.on({eventId: 1}, this.listener);
  }
  onDestroy() {
    this.listener = this.second;
    emitter.off(1, this.listener);
  }
}
class StaticEventIdentity {
  listener = () => {};
  onCreate() { emitter.on(Roots.PLAYER_EVENT, this.listener); }
  onDestroy() { emitter.off(Roots.PLAYER_EVENT.eventId, this.listener); }
}
class CrossTimerClear {
  timer = 0;
  onCreate() { this.timer = setInterval(() => {}, 10); }
  onDestroy() { clearTimeout(this.timer); }
}
class NullClearedListener {
  listener: (() => void) | null = null;
  onCreate() {
    this.listener = () => {};
    emitter.on({eventId: 1}, this.listener);
  }
  onDestroy() {
    if (this.listener) {
      emitter.off(1, this.listener);
    }
    this.listener = null;
  }
}
class TopLevelEventIdentity {
  listener = () => {};
  onCreate() { emitter.on({eventId: SHARED_EVENT}, this.listener); }
  onDestroy() { emitter.off(SHARED_EVENT, this.listener); }
}
class GuardedTimerMethodSummary {
  timer: number = -1;
  onCreate() { this.timer = setInterval(() => {}, 10); }
  clearTimer() {
    if (this.timer === -1) {
      return;
    }
    clearInterval(this.timer);
    this.timer = -1;
  }
  cleanup() { this.clearTimer(); }
  onDestroy() { this.cleanup(); }
}
class ConditionalTimerMethodSummary {
  timer: number = -1;
  onCreate() { this.timer = setInterval(() => {}, 10); }
  clearTimer() { clearInterval(this.timer); this.timer = -1; }
  onDestroy(shouldClear: boolean) {
    if (shouldClear) {
      this.clearTimer();
    }
  }
}
class PreclearedRepeatedTimer {
  timer: number = -1;
  start() {
    this.stop();
    this.timer = setInterval(() => {}, 10);
  }
  stop() {
    if (this.timer >= 0) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }
}
class OverwrittenRepeatedTimer {
  timer: number = -1;
  start() { this.timer = setInterval(() => {}, 10); }
  stop() {
    if (this.timer >= 0) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }
}
class GuardedRepeatedTimer {
  started: boolean = false;
  timer: number = -1;
  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.timer = setInterval(() => {}, 10);
  }
  stop() {
    if (this.timer >= 0) {
      clearInterval(this.timer);
      this.timer = -1;
    }
    this.started = false;
  }
}
class ResetGuardTimer {
  started: boolean = false;
  timer: number = -1;
  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.started = false;
    this.timer = setInterval(() => {}, 10);
  }
  stop() {
    if (this.timer >= 0) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }
}
class ForwardingEmitter {
  static on(callback: (data?: number) => void) {
    emitter.on({eventId: 88}, callback);
  }
  static off(callback: (data?: number) => void) {
    emitter.off(88, callback);
  }
}
class WrappingEmitter {
  static on(callback: (data?: number) => void) {
    emitter.on({eventId: 88}, (event) => callback(event.data as number));
  }
  static off(callback: (data?: number) => void) {
    emitter.off(88, callback);
  }
}
class RetainingEmitter {
  static callback: ((data?: number) => void) | undefined;
  static on(callback: (data?: number) => void) {
    RetainingEmitter.callback = callback;
    emitter.on({eventId: 88}, callback);
  }
  static off(callback: (data?: number) => void) {
    emitter.off(88, callback);
  }
}
class HelperEventRelease {
  listener = () => {};
  onCreate() { emitter.on({eventId: 89}, this.listener); }
  cleanup() { emitter.off(89, this.listener); }
  onDestroy() { this.cleanup(); }
}
class ConditionalEventRelease {
  listener = () => {};
  onCreate() { emitter.on({eventId: 90}, this.listener); }
  cleanup() { emitter.off(90, this.listener); }
  onDestroy(clear: boolean) {
    if (clear) {
      this.cleanup();
    }
  }
}
export class Cases {
 static EventLeakCase() {  const owner = new EventLeak(); owner.onCreate(); owner.onDestroy(); }
 static EventReleaseCase() {  const owner = new EventRelease(); owner.onCreate(); owner.onDestroy(); }
 static WrongEventCase() {  const owner = new WrongEvent(); owner.onCreate(); owner.onDestroy(); }
 static WrongCallbackCase() {  const owner = new WrongCallback(); owner.onCreate(); owner.onDestroy(); }
 static OffAllCase() {  const owner = new OffAll(); owner.onCreate(); owner.onDestroy(); }
 static NoCaptureCase() {  const owner = new NoCapture(); owner.onCreate(); owner.onDestroy(); }
 static CapturedCellClearedCase() {  const owner = new CapturedCellCleared(); owner.onCreate(); owner.onDestroy(); }
 static IntervalLeakCase() {  const owner = new IntervalLeak(); owner.onCreate(); owner.onDestroy(); }
 static IntervalReleaseCase() {  const owner = new IntervalRelease(); owner.onCreate(); owner.onDestroy(); }
 static TimerFieldHelperCase() { const owner = new TimerFieldHelper(); owner.onCreate(); owner.unrelated(); owner.cleanupWrapper(); }
 static CallbackCleanupCase() {  const owner = new CallbackCleanup(); owner.onCreate(); owner.onDestroy(); }
 static WrongRegistrarCase() { Roots.first = new EventHub(); Roots.second = new EventHub(); const owner = new WrongRegistrar(); owner.onCreate(); owner.onDestroy(); }
 static LocalRegistrarCase() {  const owner = new LocalRegistrar(); owner.onCreate(); owner.onDestroy(); }
 static BoundIdentityCase() {  const owner = new BoundIdentity(); owner.onCreate(); owner.onDestroy(); }
 static StaticRetainedCase() {  const owner = new StaticRetained(); owner.onCreate(); owner.onDestroy(); }
 static StaticClearedCase() {  const owner = new StaticCleared(); owner.onCreate(); owner.onDestroy(); }
 static BufferRetainedCase() {  const owner = new BufferRetained(); owner.onCreate(); owner.onDestroy(); }
 static BufferLocalCase() {  const owner = new BufferLocal(); owner.onCreate(); owner.onDestroy(); }
 static SelfCycleCase() {  const owner = new SelfCycle(); owner.onCreate(); owner.onDestroy(); }
 static ContainerRetainedCase() { Roots.items = []; Roots.map = new Map(); const owner = new ContainerRetained(); owner.onCreate(); owner.onDestroy(); }
 static ContainerClearedCase() { Roots.items = []; Roots.map = new Map(); const owner = new ContainerCleared(); owner.onCreate(); owner.onDestroy(); }
 static MapRetainedCase() { Roots.items = []; Roots.map = new Map(); const owner = new MapRetained(); owner.onCreate(); owner.onDestroy(); }
 static MapDeletedCase() { Roots.items = []; Roots.map = new Map(); const owner = new MapDeleted(); owner.onCreate(); owner.onDestroy(); }
 static WeakRetainedCase() {  const owner = new WeakRetained(); owner.onCreate(); owner.onDestroy(); }
 static PartialClearCase() {  const owner = new PartialClear(); owner.onCreate(); owner.onDestroy(); }
 static NoLifecycleEndCase() { const owner = new EventLeak(); owner.onCreate(); }
 static CapturedCellRetainedCase() { const owner = new CapturedCellRetained(); owner.onCreate(); owner.onDestroy(); }
 static CapturedBufferCase() { const owner = new CapturedBuffer(); owner.onCreate(); owner.onDestroy(); }
 static DynamicThisCase() { const owner = new DynamicThis(); owner.onCreate(); owner.onDestroy(); }
 static OnceListenerCase() { const owner = new OnceListener(); owner.onCreate(); owner.onDestroy(); }
 static TimeoutListenerCase() { const owner = new TimeoutListener(); owner.onCreate(); owner.onDestroy(); }
 static PartialOffCase() { const owner = new PartialOff(); owner.onCreate(); owner.onDestroy(); }
 static WrongTimerCase() { const owner = new WrongTimer(); owner.onCreate(); owner.onDestroy(); }
 static HelperRegistrationCase() { const owner = new HelperRegistration(); owner.onCreate(); owner.onDestroy(); }
 static TwoListenersCase() { const owner = new TwoListeners(); owner.onCreate(); owner.onDestroy(); }
 static MethodIdentityCase() { const owner = new MethodIdentity(); owner.onCreate(); owner.onDestroy(); }
 static UnknownCallbackCase() { const owner = new UnknownCallback(); owner.onCreate(); owner.onDestroy(); }
 static ThrowingCleanupCase() { const owner = new ThrowingCleanup(); owner.onCreate(); owner.onDestroy(); }
 static AliasListenerCase() {
     const callback = () => {};
     const alias = callback;
     emitter.on({eventId: 1}, callback); emitter.off(1, alias);
 }
 static cancelTimer(token: number) { clearInterval(token); }
 static TimerHelperCase() {
     const timer = setInterval(() => {}, 10);
     Cases.cancelTimer(timer);
 }
 static deepTimerOne(token: number) { Cases.deepTimerTwo(token); }
 static deepTimerTwo(token: number) { Cases.deepTimerThree(token); }
 static deepTimerThree(token: number) { Cases.deepTimerFour(token); }
 static deepTimerFour(token: number) { Cases.deepTimerFive(token); }
 static deepTimerFive(token: number) { clearInterval(token); }
 static DeepTimerHelperCase() { const token = setInterval(() => {}, 10); Cases.deepTimerOne(token); }
 static TwoTimerCallersCase() {
     const first = setInterval(() => {}, 10);
     const second = setInterval(() => {}, 10);
     Cases.cancelTimer(first);
 }
 static timerFactory(): number { return setInterval(() => {}, 10); }
 static TwoTimerFactoryCallersCase() {
     const first = Cases.timerFactory();
     const second = Cases.timerFactory();
     clearInterval(first);
 }
 static BothTimerFactoryCallersCase() {
     const first = Cases.timerFactory();
     const second = Cases.timerFactory();
     clearInterval(first); clearInterval(second);
 }
 static throwingTimerCleanup(token: number) { clearInterval(token); throw new Error('after cleanup'); }
 static ExceptionalTimerReturnCase() {
     const token = setInterval(() => {}, 10);
     try { Cases.throwingTimerCleanup(token); } catch (error) {}
 }
 static WrongTimerHelperCase() {
     const timer = setInterval(() => {}, 10);
     Cases.cancelTimer(99);
 }
 static opaqueWork() { console.log('unrelated work'); }
 static EventUnrelatedHelperCase() {
     emitter.on({eventId: 1}, () => {});
     Cases.opaqueWork();
 }
 static cancelEventAll() { emitter.off(1); }
 static cancelEventWrapper() { Cases.cancelEventAll(); }
 static EventOffAllHelperCase() {
     emitter.on({eventId: 1}, () => {});
     Cases.cancelEventWrapper();
 }
 static registerOtherEvent() { emitter.on({eventId: 2}, () => {}); }
 static EventNewRegistrationHelperCase() {
     emitter.on({eventId: 1}, () => {});
     Cases.registerOtherEvent();
 }
 static clearStaticTimer() { clearInterval(Roots.interval); }
 static clearStaticTimerWrapper() { Cases.clearStaticTimer(); }
 static replaceStaticTimer() { Roots.interval = 99; }
 static changeOtherField() { Roots.other = 1; console.log('unrelated'); }
 static StaticTimerReleaseCase() {
     Roots.interval = setInterval(() => {}, 10);
     Cases.clearStaticTimerWrapper();
 }
 static StaticTimerOverwriteCase() {
     Roots.interval = setInterval(() => {}, 10);
     Cases.replaceStaticTimer();
 }
 static StaticTimerUnrelatedCase() {
     Roots.interval = setInterval(() => {}, 10);
     Cases.changeOtherField();
 }
 static BoundAliasCase() {
     const owner = new MethodIdentity();
     const callback = owner.callback.bind(owner);
     emitter.on({eventId: 1}, callback); emitter.off(1, callback);
 }
 static UnknownEventCase(event: number) {
     const callback = () => {};
     emitter.on({eventId: event}, callback); emitter.off(1, callback);
 }
 static OneRemainingCase() {
     const first = () => {}; const second = () => {};
     emitter.on({eventId: 1}, first); emitter.on({eventId: 1}, second);
     emitter.off(1, first);
 }
 static RemoveAllSameEventCase() {
     emitter.on({eventId: 1}, () => {}); emitter.on({eventId: 1}, () => {});
     emitter.off(1);
 }
 static ReplacedRegistrarCase() {
     const callback = () => {};
     Roots.first = new EventHub(); Roots.first.on('tick', callback);
     Roots.first = new EventHub(); Roots.first.off('tick', callback);
 }
 static NestedCallbackRegistrationCase() {
     emitter.on({eventId: 1}, () => { emitter.on({eventId: 2}, () => {}); });
 }
 static StableFieldListenerCase() { const owner = new StableFieldListener(); owner.onCreate(); owner.onDestroy(); }
 static ReplacedFieldListenerCase() { const owner = new ReplacedFieldListener(); owner.onCreate(); owner.onDestroy(); }
 static StaticEventIdentityCase() { const owner = new StaticEventIdentity(); owner.onCreate(); owner.onDestroy(); }
 static CrossTimerClearCase() { const owner = new CrossTimerClear(); owner.onCreate(); owner.onDestroy(); }
 static NullClearedListenerCase() { const owner = new NullClearedListener(); owner.onCreate(); owner.onDestroy(); }
 static TopLevelEventIdentityCase() { const owner = new TopLevelEventIdentity(); owner.onCreate(); owner.onDestroy(); }
 static GuardedTimerMethodSummaryCase() {
     const owner = new GuardedTimerMethodSummary(); owner.onCreate(); owner.onDestroy();
 }
 static PreclearedRepeatedTimerCase() {
     const owner = new PreclearedRepeatedTimer(); owner.start(); owner.start(); owner.stop();
 }
 static OverwrittenRepeatedTimerCase() {
     const owner = new OverwrittenRepeatedTimer(); owner.start(); owner.start(); owner.stop();
 }
 static GuardedRepeatedTimerCase() {
     const owner = new GuardedRepeatedTimer(); owner.start(); owner.start(); owner.stop();
 }
 static ResetGuardTimerCase() {
     const owner = new ResetGuardTimer(); owner.start(); owner.start(); owner.stop();
 }
}
