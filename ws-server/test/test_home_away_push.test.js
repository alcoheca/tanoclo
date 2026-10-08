'use strict';

const assert = require('assert');

describe('an OFF schedule block is reported disabled with no setpoint', () => {
    const dbBase = require('../lib/db-base');
    const modulePaths = ['../lib/db-homes', '../lib/db-zones/schedule'].map(p => require.resolve(p));
    const realGetPool = dbBase.getPool;
    let block;
    let schedule;

    const fakePool = {
        execute: async (sql) => {
            if (/FROM homes/i.test(sql)) return [[{ date_time_zone: 'Europe/London' }]];
            if (/FROM zone_timetables/i.test(sql)) return [[{ id: 8, type: 'ONE_DAY' }]];
            if (/FROM schedule_blocks/i.test(sql)) return [block ? [{ ...block }] : []];
            return [[]];
        },
    };

    beforeAll(() => {
        dbBase.getPool = () => fakePool;
        modulePaths.forEach(p => delete require.cache[p]);
        schedule = require('../lib/db-zones/schedule');
    });
    afterAll(() => {
        dbBase.getPool = realGetPool;
        modulePaths.forEach(p => delete require.cache[p]);
    });

    const offBlock = {
        id: 1, day_type: 'MONDAY_TO_SUNDAY', start_time: '00:00', end_time: '00:00',
        setting_type: 'HEATING', setting_power: 'OFF', setting_temp_celsius: null, setting_temp_fahrenheit: null,
    };

    test('heating zone with an OFF block is disabled and has no target', async () => {
        block = offBlock;
        const state = await schedule.getZoneScheduleState(1, 4, 1);
        assert.strictEqual(state.enabled, 0);
        assert.strictEqual(state.targetTemp, null);
    });

    test('heating zone with an ON block keeps its target', async () => {
        block = { ...offBlock, setting_power: 'ON', setting_temp_celsius: 19, setting_temp_fahrenheit: 66.2 };
        const state = await schedule.getZoneScheduleState(1, 7, 1);
        assert.strictEqual(state.enabled, 1);
        assert.strictEqual(state.targetTemp, 19);
    });
});

describe('Home/Away push', () => {
    const api = require('../lib/command-api');
    const { pushHomeAway } = require('../lib/commands/zone');

    const saved = {};
    let sent;
    let zoneState;

    const fakeDb = {
        getPool: () => ({
            execute: async (sql) => {
                if (/FROM zones WHERE home_id/i.test(sql)) return [[{ id: 4, name: 'Funzone', type: 'HEATING' }]];
                if (/measuring_device_serial/i.test(sql)) return [[{ measuring_device_serial: 'VA1' }]];
                if (/FROM away_configurations/i.test(sql)) return [[]];
                if (/FROM heating_circuits/i.test(sql)) return [[]];
                return [[]];
            },
        }),
        getZoneState: async () => zoneState,
        getDevicesInZone: async () => [{ serial_no: 'VA1', ipv6_address: 'fe80::1' }],
        getDeviceByFullSerial: async () => null,
    };

    beforeAll(() => {
        ['_db', '_log', 'findBridgeForHome', 'sendViaBridge'].forEach(k => { saved[k] = api[k]; });
        api._db = fakeDb;
        api._log = () => {};
        api.findBridgeForHome = () => ({ bridgeId: 'IB1', bridgeClient: {} });
        api.sendViaBridge = (id, client, ip, port, bytes) => { sent.push(bytes); };
    });
    afterAll(() => {
        Object.keys(saved).forEach(k => { api[k] = saved[k]; });
    });
    beforeEach(() => { sent = []; });

    // The z/s payload follows the CoAP payload marker (0xff) and starts with field 0x6160.
    // The URI options also carry 0xff bytes, so anchor on the marker plus that first field id.
    // Parsed by hand as [fid:2][len:1][value:len] so the test does not depend on tlv.decode,
    // whose output shape varies with module state when files share one module cache.
    function decodeSent() {
        assert.strictEqual(sent.length, 1);
        const buf = sent[0];
        const start = buf.indexOf(Buffer.from([0xff, 0x61, 0x60]));
        assert.notStrictEqual(start, -1, 'payload marker not found');
        // Temperatures (0x6200, 0x6280) are on the wire in hundredths of a degree.
        const temps = new Set(['0x6200', '0x6280']);
        const fields = {};
        for (let i = start + 1; i + 3 <= buf.length;) {
            const fid = '0x' + buf.readUInt16BE(i).toString(16).padStart(4, '0');
            const len = buf[i + 2];
            const value = buf.readUIntBE(i + 3, len);
            fields[fid] = temps.has(fid) ? value / 100 : value;
            i += 3 + len;
        }
        return fields;
    }

    test('an OFF zone is pushed disabled with no target on Home', async () => {
        zoneState = { field_61e0: 0, field_6200: null, field_6240: 0, field_6180: 0 };
        await pushHomeAway(1, false);
        const fields = decodeSent();
        assert.strictEqual(fields['0x6160'], 1);
        assert.strictEqual(fields['0x61e0'], 0);
        assert.strictEqual(fields['0x6200'], undefined);
    });

    test('a scheduled zone is pushed with its scheduled target on Home', async () => {
        zoneState = { field_61e0: 1, field_6200: 19, field_6240: 0, field_6180: 0 };
        await pushHomeAway(1, false);
        const fields = decodeSent();
        assert.strictEqual(fields['0x61e0'], 1);
        assert.strictEqual(fields['0x6200'], 19);
    });

    test('an active timer overlay survives a presence change', async () => {
        zoneState = {
            field_61e0: 1, field_6200: 5, field_6240: 3, field_6260: 1, field_6280: 20, field_6440: 1, field_6180: 0,
        };
        await pushHomeAway(1, false);
        const fields = decodeSent();
        assert.strictEqual(fields['0x6240'], 3);
        assert.strictEqual(fields['0x6260'], 1);
        assert.strictEqual(fields['0x6280'], 20);
        assert.strictEqual(fields['0x6440'], 1);
    });

    test('no overlay is sent when none is active', async () => {
        zoneState = { field_61e0: 1, field_6200: 19, field_6240: 0, field_6180: 0 };
        await pushHomeAway(1, true);
        const fields = decodeSent();
        assert.strictEqual(fields['0x6160'], 2);
        assert.strictEqual(fields['0x6240'], 0);
        assert.strictEqual(fields['0x6280'], undefined);
    });
});
