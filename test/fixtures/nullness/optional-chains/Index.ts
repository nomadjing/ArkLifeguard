class Child { value: number = 1; touch(n: number = 0): number { return this.value + n; } }
class Owner { child: Child = new Child(); nullable: Child | undefined = undefined; }
function absent(): Owner | undefined { return undefined; }
function absentChild(): Child | null { return null; }
function indexEffect(): 'child' { return 'child'; }
function argumentEffect(): number { return 1; }
export function continuous(): number | undefined { return absent()?.child.value; }
export function multiple(): number | undefined { return absent()?.nullable?.value; }
export function indexed(): Child | undefined { return absent()?.[indexEffect()]; }
export function invoked(): number | undefined { return absent()?.child.touch(argumentEffect()); }
function absentCallback(): ((n: number) => number) | undefined { return undefined; }
export function optionalFunction(): number | undefined {
    const callback = absentCallback();
    return callback?.(argumentEffect());
}
export function optionalMethod(): number | undefined {
    const child = new Child();
    return child.touch?.(argumentEffect());
}
export function aigis(): number {
    const importer = absent();
    return importer?.child.value ? 1 : 0;
}
export function brokenByParentheses(): number { return (absent()?.child)!.value; }
export function nullableChild(): number | undefined {
    const owner = new Owner();
    return owner?.nullable!.value;
}
export function optionalResult(): number {
    const value = absent()?.child;
    return value!.value;
}
export function laterDirect(): number {
    const owner = absent();
    const value = owner?.child;
    return owner!.child.value;
}
export function assertedReturn(): number { return absentChild()!.value; }
export function guardThenMutation(): number {
    let owner = absent();
    const value = owner?.child;
    owner = undefined;
    return owner!.child.value;
}
export function assertedMatch(code: string): string { return code.match(/.{1,2}/g)!.join(' '); }
export function receiverEffect(): Owner | undefined { return undefined; }
export function evaluatedOnce(): number | undefined { return receiverEffect()?.child.value; }
export function optionalDelete(): boolean { return delete absent()?.nullable; }
export function optionalMatch(code: string): string | undefined { return code.match(/.{1,2}/g)?.join(' '); }
export function deletedStillUndefined(): number {
    const owner = absent();
    if (delete owner?.nullable) return owner!.child.value;
    return 0;
}
export function capturedMethodReceiver(): number | undefined {
    let child: Child | undefined = new Child();
    return child.touch?.((child = undefined, 1));
}
export function templateOptional(): string {
    const error = absentChild();
    return `code ${error?.value}, again ${error?.value}`;
}
export function templateNullish(): string {
    const value = absentChild();
    return `value ${value}`;
}
export function templateExplicitCall(): string {
    const value = absentChild();
    return `value ${value!.toString()}`;
}
