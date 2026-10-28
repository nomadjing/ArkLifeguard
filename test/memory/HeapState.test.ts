import { describe, expect, it } from 'vitest';
import { HeapState } from '../../src/analysis/shared/HeapState';

describe('heap state identity', () => {
    const encoder = () => {
        const symbols = new Map<string, number>();
        return (value: string) => {
            if (!symbols.has(value)) symbols.set(value, symbols.size + 1);
            return symbols.get(value)!;
        };
    };

    it('canonicalizes equivalent heaps regardless of insertion order', () => {
        const first = new HeapState();
        first.set('a,b', ['c']);
        first.set('a', ['b', 'c']);
        first.roots.add('a');
        first.roots.add('a,b');
        const second = new HeapState();
        second.roots.add('a,b');
        second.roots.add('a');
        second.set('a', ['c', 'b']);
        second.set('a,b', ['c']);
        const encode = encoder();
        expect(first.signature()).toBe(second.signature());
        expect(first.signature(encode)).toBe(second.signature(encode));
    });

    it('keeps absent, cleared, weak, and strong bindings distinct', () => {
        const absent = new HeapState();
        const cleared = new HeapState();
        cleared.set('field:owner:child', []);
        const weak = new HeapState();
        weak.set('field:owner:[[weak]]', ['child']);
        const strong = new HeapState();
        strong.set('field:owner:child', ['child']);
        const encode = encoder();
        expect(new Set([absent, cleared, weak, strong].map(state => state.signature(encode))).size).toBe(4);
    });

    it('keeps branch snapshots independent and observes updates after encoding', () => {
        const initial = new HeapState();
        initial.set('static:root', ['owner']);
        initial.roots.add('static:root');
        const cleared = initial.clone();
        const retained = initial.clone();
        const encode = encoder();
        const before = initial.signature(encode);
        cleared.set('static:root', []);
        expect(retained.signature(encode)).toBe(before);
        expect(initial.signature(encode)).toBe(before);
        expect(cleared.signature(encode)).not.toBe(before);
    });
});
