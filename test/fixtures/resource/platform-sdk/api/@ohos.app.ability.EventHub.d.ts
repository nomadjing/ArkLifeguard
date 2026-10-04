export default class EventHub { on(event: string, callback: () => void): void; off(event: string, callback?: () => void): void; }
