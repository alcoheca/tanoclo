'use strict';

const assert = require('assert');

describe('valve-reported overlays are stored as the valve reported them', () => {
    const dbBase = require('../lib/db-base');
    const overlaysPath = require.resolve('../lib/db-zones/overlays');
    const realGetPool = dbBase.getPool;
    let row;
    let overlays;

    const fakePool = {
        execute: async (sql, params = []) => {
            if (/^\s*SELECT/i.test(sql)) return [row ? [{ ...row }] : []];
            const [zone_id, home_id, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit,
                termination_type, termination_duration_seconds, termination_expiry] = params;
            row = { zone_id, home_id, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit,
                termination_type, termination_duration_seconds, termination_expiry };
            return [{ affectedRows: 1 }];
        },
    };

    beforeAll(() => {
        dbBase.getPool = () => fakePool;
        delete require.cache[overlaysPath];
        overlays = require('../lib/db-zones/overlays');
    });
    afterAll(() => {
        dbBase.getPool = realGetPool;
        delete require.cache[overlaysPath];
    });
    beforeEach(() => { row = null; });

    test('mode 1 (heating off) is stored as power OFF with no setpoint', async () => {
        await overlays.upsertZoneOverlay(1, 4, 1, null, false);
        assert.strictEqual(row.setting_power, 'OFF');
        assert.strictEqual(row.setting_temp_celsius, null);
        assert.strictEqual(row.termination_type, 'MANUAL');
    });

    test('mode 2 with a setpoint is a manual overlay with that temperature', async () => {
        await overlays.upsertZoneOverlay(1, 7, 2, 20, true);
        assert.strictEqual(row.setting_power, 'ON');
        assert.strictEqual(row.setting_temp_celsius, 20);
        assert.strictEqual(row.setting_temp_fahrenheit, 68);
        assert.strictEqual(row.termination_type, 'MANUAL');
    });

    test('a new manual overlay does not inherit the previous overlay expiry', async () => {
        row = { zone_id: 7, home_id: 1, setting_type: 'HEATING', setting_power: 'OFF', setting_temp_celsius: null,
            setting_temp_fahrenheit: null, termination_type: 'TIMER', termination_duration_seconds: 3600,
            termination_expiry: '2026-10-07T22:46:43.253Z' };
        await overlays.upsertZoneOverlay(1, 7, 2, 20, true);
        assert.strictEqual(row.termination_type, 'MANUAL');
        assert.strictEqual(row.termination_expiry, null);
        assert.strictEqual(row.termination_duration_seconds, null);
    });

    test('a valve echoing the stored timed overlay keeps its type and expiry', async () => {
        row = { zone_id: 7, home_id: 1, setting_type: 'HEATING', setting_power: 'ON', setting_temp_celsius: 20,
            setting_temp_fahrenheit: 68, termination_type: 'NEXT_TIME_BLOCK', termination_duration_seconds: 5400,
            termination_expiry: '2026-10-07T23:00:00.000Z' };
        await overlays.upsertZoneOverlay(1, 7, 3, 20, true);
        assert.strictEqual(row.termination_type, 'NEXT_TIME_BLOCK');
        assert.strictEqual(row.termination_expiry, '2026-10-07T23:00:00.000Z');
        assert.strictEqual(row.termination_duration_seconds, 5400);
    });

    test('a valve echoing a stored off overlay keeps it off and keeps its timer', async () => {
        row = { zone_id: 7, home_id: 1, setting_type: 'HEATING', setting_power: 'OFF', setting_temp_celsius: null,
            setting_temp_fahrenheit: null, termination_type: 'TIMER', termination_duration_seconds: 3600,
            termination_expiry: '2026-10-07T22:46:43.253Z' };
        await overlays.upsertZoneOverlay(1, 7, 1, null, false);
        assert.strictEqual(row.setting_power, 'OFF');
        assert.strictEqual(row.termination_type, 'TIMER');
        assert.strictEqual(row.termination_expiry, '2026-10-07T22:46:43.253Z');
    });
});
