import { describe, expect, it } from 'vitest';
import { SourceSinkManager, HARMONYOS_SOURCES } from '../../src/analysis/resource/SourceSinkManager';
import { legacyRuleMigration } from '../../src/analysis/shared/RuleOwnership';

describe('mechanism-based legacy rule migration', () => {
    it('accounts for every legacy default rule with a reason and support status', () => {
        const migration = legacyRuleMigration(HARMONYOS_SOURCES);
        expect(migration).toHaveLength(HARMONYOS_SOURCES.length);
        expect(new Set(migration.map(rule => rule.legacyId)).size).toBe(HARMONYOS_SOURCES.length);
        expect(migration.every(rule => rule.reason && rule.status)).toBe(true);
        expect(migration.find(rule => rule.legacyId === 'sensor.on')).toMatchObject({ domain: 'closure', status: 'unsupported-registration' });
        expect(migration.find(rule => rule.legacyId === 'new.Worker')).toMatchObject({ domain: 'resource' });
        expect(migration.find(rule => rule.legacyId === 'ArrayBuffer.new')).toMatchObject({ domain: 'removed' });
        expect(migration.find(rule => rule.legacyId === 'distributedDataObject.create')).toMatchObject({ domain: 'removed' });
        expect(migration.find(rule => rule.legacyId === 'camera.getCameraManager')).toMatchObject({ domain: 'removed' });
    });
    it('loads only resource obligations by default and removes duplicate memory labels', () => {
        const manager = new SourceSinkManager();
        expect(manager.getAllSources().every(source => source.category === 'resource')).toBe(true);
        expect(manager.getAllSinks().every(sink => sink.category === 'resource_release')).toBe(true);
        for (const id of ['setInterval', 'emitter.on', 'sensor.on', 'CommonEventManager.subscribe', 'ArrayBuffer.new', 'image.createPixelMap.memory']) {
            expect(manager.getSourceById(id), id).toBeNull();
        }
        expect(manager.getSourceById('image.createPixelMap')).not.toBeNull();
        expect(manager.getSourceById('new.Worker')?.category).toBe('resource');
    });
    it('retains the archive only by explicit opt-in', () => {
        const manager = new SourceSinkManager(true);
        expect(manager.getAllSources()).toHaveLength(HARMONYOS_SOURCES.length);
        expect(manager.getSourceById('ArrayBuffer.new')?.category).toBe('memory');
    });
});
