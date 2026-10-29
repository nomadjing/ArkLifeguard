declare class EventHub {
    on(event: string, callback: Function): void;
    off(event: string, callback?: Function): void;
}
export default EventHub;
