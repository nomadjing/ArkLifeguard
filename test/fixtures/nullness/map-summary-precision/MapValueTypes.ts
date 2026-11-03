class MapAccount { refresh(): void {} }
type AccountAlias = MapAccount;
type NullableAlias = MapAccount | null;
export function guardedNonNull(): void {
    const map = new Map<string, MapAccount>();
    const value = map.get('missing');
    if (value === undefined) return;
    value!.refresh();
}
export function guardedAlias(): void {
    const map = new Map<string, AccountAlias>();
    const value = map.get('missing');
    if (value === undefined) return;
    value!.refresh();
}
export function storedNull(): void {
    const map = new Map<string, NullableAlias>();
    map.set('key', null);
    const value = map.get('key');
    if (value === undefined) return;
    value!.refresh();
}
export function unknownValues(): void {
    const map = new Map<string, unknown>();
    map.set('key', null);
    const value = map.get('key');
    if (value === undefined) return;
    (value as MapAccount).refresh();
}
export function anyValues(): void {
    const map = new Map<string, any>();
    map.set('key', null);
    const value = map.get('key');
    if (value === undefined) return;
    value.refresh();
}
export function genericValues<T>(map: Map<string, T>): void {
    const value = map.get('key');
    if (value === undefined) return;
    (value as MapAccount).refresh();
}
export function castReceiver(): void {
    const nullable = new Map<string, MapAccount | null>();
    nullable.set('key', null);
    const map = nullable as Map<string, MapAccount>;
    const value = map.get('key');
    if (value === undefined) return;
    value!.refresh();
}
export function rawMap(): void {
    const map = new Map();
    map.set('key', null);
    const value = map.get('key');
    if (value === undefined) return;
    value.refresh();
}
export function guardedNullable(): void {
    const map = new Map<string, MapAccount | null>();
    const value = map.get('key');
    if (value === undefined || value === null) return;
    value.refresh();
}
