import type { Stmt } from '../../adapter/arkanalyzer';

export interface HeapObject {
    readonly id: string;
    readonly kind: 'object' | 'closure' | 'external' | 'weak';
    readonly label: string;
    readonly allocation: Stmt;
    readonly lifetimeOwner?: string;
    readonly classSignature?: string;
}
export interface ReferencePathEdge {
    readonly from: string;
    readonly via: string;
    readonly to: string;
    readonly location?: Stmt;
}
export interface ReferencePath {
    readonly root: string;
    readonly edges: readonly ReferencePathEdge[];
}

/** Allocation-site abstract heap. Local bindings are NOT GC roots.
 * Closures reference live binding cells; weak edges are excluded from strong reachability.
 */
export class HeapState {
    readonly objects = new Map<string, HeapObject>();
    readonly slots = new Map<string, readonly string[]>();
    readonly initializedSlots = new Set<string>();
    readonly locations = new Map<string, Stmt>();
    readonly roots = new Set<string>();
    readonly endedOwners = new Map<string, Stmt>();
    readonly uncertainties = new Set<string>();

    clone(): HeapState { return this.copyTo(new HeapState()); }

    protected copyTo<T extends HeapState>(target: T): T {
        for (const [id, object] of this.objects) target.objects.set(id, object);
        for (const [slot, values] of this.slots) target.slots.set(slot, values);
        for (const slot of this.initializedSlots) target.initializedSlots.add(slot);
        for (const [slot, site] of this.locations) target.locations.set(slot, site);
        for (const root of this.roots) target.roots.add(root);
        for (const [owner, site] of this.endedOwners) target.endedOwners.set(owner, site);
        for (const reason of this.uncertainties) target.uncertainties.add(reason);
        return target;
    }

    set(slot: string, values: readonly string[], site?: Stmt, weakUpdate = false): void {
        this.initializedSlots.add(slot);
        const merged = weakUpdate ? [...(this.slots.get(slot) ?? []), ...values] : values;
        const unique = [...new Set(merged)].sort();
        if (unique.length) this.slots.set(slot, unique);
        else this.slots.delete(slot);
        if (site) this.locations.set(slot, site);
    }

    signature(): string {
        return JSON.stringify([
            [...this.objects.values()].map(object => [object.id, object.kind, object.lifetimeOwner]).sort(),
            [...this.slots].sort(([a], [b]) => a.localeCompare(b)), [...this.roots].sort(),
            [...this.initializedSlots].sort(),
            [...this.endedOwners.keys()].sort(), [...this.uncertainties].sort(),
        ]);
    }

    /** Shortest strong path; reference cells are dereferenced at observation time. */
    pathTo(target: string, includeRoot: (root: string) => boolean = () => true,
        through: readonly string[] = [], throughSlots: readonly string[] = []): ReferencePath | undefined {
        const queue: Array<{ value: string; path: ReferencePath }> = [];
        for (const root of [...this.roots].sort()) {
            if (!includeRoot(root)) continue;
            for (const value of this.slots.get(root) ?? []) queue.push({ value,
                path: { root, edges: [{ from: root, via: root, to: value, location: this.locations.get(root) }] } });
        }
        const visited = new Set<string>();
        for (let index = 0; index < queue.length; index++) {
            const { value, path } = queue[index];
            const passed = !through.length || path.edges.some(edge => through.includes(edge.to));
            const passedSlot = !throughSlots.length || path.edges.some(edge => throughSlots.includes(edge.via));
            if (value === target && passed && passedSlot) return path;
            const visitKey = `${value}:${passed}:${passedSlot}`;
            if (visited.has(visitKey)) continue;
            visited.add(visitKey);
            const entries = value.startsWith('ref:')
                ? [[value.slice(4), this.slots.get(value.slice(4)) ?? []] as const]
                : [...this.slots].filter(([slot]) => slot.startsWith(`field:${value}:`) &&
                    !slot.startsWith(`field:${value}:[[weak]]`));
            for (const [slot, values] of entries) {
                for (const child of values) queue.push({ value: child, path: { root: path.root,
                    edges: [...path.edges, { from: value, via: slot, to: child, location: this.locations.get(slot) }] } });
            }
        }
        return undefined;
    }
}
