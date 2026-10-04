declare namespace emitter {
 interface InnerEvent { eventId: number; }
 function on(event: InnerEvent, callback: () => void): void;
 function once(event: InnerEvent, callback: () => void): void;
 function off(eventId: number, callback?: () => void): void;
} export default emitter;
