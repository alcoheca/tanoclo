'use strict';

const assert = require('assert');
const {
    OVERLAY_MODE, PRESET, PRESET_MODES, PRESET_NONE,
    overlayModeFor, presetForTermination, parsePresetCommand, describeOverlay,
} = require('../lib/overlay-codes');

describe('overlay codes', () => {
    test('code values are the protocol ones', () => {
        assert.deepStrictEqual({ ...OVERLAY_MODE }, { SCHEDULE: 0, OFF: 1, MANUAL: 2, TIMED: 3 });
    });

    describe('overlayModeFor', () => {
        test('heating off is code 1 whatever the termination', () => {
            for (const t of ['MANUAL', 'TIMER', 'NEXT_TIME_BLOCK', null]) {
                assert.strictEqual(overlayModeFor({ power: 'OFF', terminationType: t }), 1);
            }
        });
        test('power on: manual is 2, timer and next block are 3', () => {
            assert.strictEqual(overlayModeFor({ power: 'ON', terminationType: 'MANUAL' }), 2);
            assert.strictEqual(overlayModeFor({ power: 'ON', terminationType: 'TIMER' }), 3);
            assert.strictEqual(overlayModeFor({ power: 'ON', terminationType: 'NEXT_TIME_BLOCK' }), 3);
        });
        test('hot water stays termination-based when switched off', () => {
            assert.strictEqual(overlayModeFor({ power: 'OFF', terminationType: 'TIMER', isHotWater: true }), 3);
            assert.strictEqual(overlayModeFor({ power: 'OFF', terminationType: 'MANUAL', isHotWater: true }), 2);
        });
        test('unknown or missing termination counts as manual', () => {
            assert.strictEqual(overlayModeFor({ power: 'ON' }), 2);
            assert.strictEqual(overlayModeFor({ power: 'ON', terminationType: 'TADO_MODE' }), 2);
        });
    });

    describe('labels', () => {
        test('presets are human readable and exclude the schedule (HA uses "none")', () => {
            assert.deepStrictEqual([...PRESET_MODES], ['For a set time', 'Until next schedule change', 'Until cancelled']);
            assert.ok(!PRESET_MODES.includes('none'));
        });
        test('stored termination types map to the right label', () => {
            assert.strictEqual(presetForTermination('TIMER'), PRESET.TIMER);
            assert.strictEqual(presetForTermination('NEXT_TIME_BLOCK'), PRESET.NEXT_BLOCK);
            assert.strictEqual(presetForTermination('TADO_MODE'), PRESET.NEXT_BLOCK);
            assert.strictEqual(presetForTermination('MANUAL'), PRESET.MANUAL);
            assert.strictEqual(presetForTermination(undefined), PRESET.MANUAL);
        });
    });

    describe('parsePresetCommand', () => {
        test('accepts the new labels in any case', () => {
            assert.strictEqual(parsePresetCommand('For a set time'), 'TIMER');
            assert.strictEqual(parsePresetCommand('until next schedule change'), 'NEXT_BLOCK');
            assert.strictEqual(parsePresetCommand('UNTIL CANCELLED'), 'MANUAL');
        });
        test('accepts the legacy names', () => {
            assert.strictEqual(parsePresetCommand('TIMER'), 'TIMER');
            assert.strictEqual(parsePresetCommand('NEXT_BLOCK'), 'NEXT_BLOCK');
            assert.strictEqual(parsePresetCommand('NEXT_TIME_BLOCK'), 'NEXT_BLOCK');
            assert.strictEqual(parsePresetCommand('TADO_MODE'), 'NEXT_BLOCK');
            assert.strictEqual(parsePresetCommand('MANUAL'), 'MANUAL');
        });
        test('none, schedule and auto all resume the schedule', () => {
            for (const p of ['none', 'None', 'SCHEDULE', 'schedule', 'auto', 'AUTO']) {
                assert.strictEqual(parsePresetCommand(p), 'SCHEDULE');
            }
        });
        test('anything else is rejected', () => {
            assert.strictEqual(parsePresetCommand('boost'), null);
            assert.strictEqual(parsePresetCommand(''), null);
            assert.strictEqual(parsePresetCommand(undefined), null);
        });
    });

    describe('describeOverlay', () => {
        test('no overlay: auto, preset none', () => {
            assert.deepStrictEqual(describeOverlay({ overlayCode: 0 }), { hvacMode: 'auto', preset: PRESET_NONE });
        });
        test('timer, next block and manual overlays with heating on are heat with the matching preset', () => {
            const cases = [['TIMER', PRESET.TIMER], ['NEXT_TIME_BLOCK', PRESET.NEXT_BLOCK], ['TADO_MODE', PRESET.NEXT_BLOCK], ['MANUAL', PRESET.MANUAL]];
            for (const [type, label] of cases) {
                const r = describeOverlay({ overlayCode: 3, overlay: { setting_power: 'ON', termination_type: type } });
                assert.deepStrictEqual(r, { hvacMode: 'heat', preset: label }, type);
            }
        });
        test('an off overlay keeps its termination label', () => {
            const r = describeOverlay({ overlayCode: 1, overlay: { setting_power: 'OFF', termination_type: 'TIMER' } });
            assert.deepStrictEqual(r, { hvacMode: 'off', preset: PRESET.TIMER });
        });
        test('a disabled zone is off even with no overlay', () => {
            assert.strictEqual(describeOverlay({ overlayCode: 0, zoneEnabled: 0 }).hvacMode, 'off');
        });
        test('without an overlay row the code decides', () => {
            assert.deepStrictEqual(describeOverlay({ overlayCode: 1 }), { hvacMode: 'off', preset: PRESET.MANUAL });
            assert.deepStrictEqual(describeOverlay({ overlayCode: 2 }), { hvacMode: 'heat', preset: PRESET.MANUAL });
            assert.deepStrictEqual(describeOverlay({ overlayCode: 3 }), { hvacMode: 'heat', preset: PRESET.NEXT_BLOCK });
        });
    });
});

describe('MQTT publisher shows the overlay as Home Assistant labels', () => {
    const mqttPublisher = require('../lib/mqtt-publisher');
    const published = [];
    let overlayRow = null;

    const mockDb = {
        getPool: () => ({ execute: async () => [overlayRow ? [overlayRow] : []] }),
        getZoneType: async () => 'HEATING',
        getHome: async () => ({ presence_locked: 0 }),
    };
    const quietLog = Object.assign(() => { }, { info() { }, error() { }, debug() { }, warn() { } });

    beforeAll(() => {
        mqttPublisher.init({ publish: (topic, payload) => published.push({ topic, payload }) }, mockDb, { logLevel: 'info' }, quietLog);
    });

    async function publish(fields, row = null) {
        published.length = 0;
        overlayRow = row;
        await mqttPublisher.publishZoneStateTelemetry(1, 10, fields);
        await new Promise(resolve => setTimeout(resolve, 30)); // publisher batches on nextTick
        const last = (suffix) => {
            const hits = published.filter(m => m.topic === `tado/tanoclo/h/1/z/10/${suffix}`);
            return hits.length ? hits[hits.length - 1].payload : undefined;
        };
        return { last, all: (suffix) => published.filter(m => m.topic === `tado/tanoclo/h/1/z/10/${suffix}`) };
    }

    test('following the schedule: auto and preset none', async () => {
        const r = await publish({ field_6240: 0, field_61e0: 1, field_6160: 1 });
        assert.strictEqual(r.last('hvac_mode'), 'auto');
        assert.strictEqual(r.last('preset_mode'), 'none');
    });

    test('a timer overlay shows "For a set time"', async () => {
        const r = await publish({ field_6240: 3, field_61e0: 1 }, { setting_power: 'ON', termination_type: 'TIMER' });
        assert.strictEqual(r.last('hvac_mode'), 'heat');
        assert.strictEqual(r.last('preset_mode'), 'For a set time');
    });

    test('an until-next-change overlay shows the readable label, including the TADO_MODE spelling', async () => {
        for (const type of ['NEXT_TIME_BLOCK', 'TADO_MODE']) {
            const r = await publish({ field_6240: 2, field_61e0: 1 }, { setting_power: 'ON', termination_type: type });
            assert.strictEqual(r.last('preset_mode'), 'Until next schedule change', type);
        }
    });

    test('a manual overlay (code 2) is "Until cancelled", not NEXT_BLOCK', async () => {
        const r = await publish({ field_6240: 2, field_61e0: 1 }, { setting_power: 'ON', termination_type: 'MANUAL' });
        assert.strictEqual(r.last('preset_mode'), 'Until cancelled');
        assert.strictEqual(r.last('hvac_mode'), 'heat');
    });

    test('heating switched off (code 1) is mode off and keeps its overlay label', async () => {
        const r = await publish({ field_6240: 1, field_61e0: 1 }, { setting_power: 'OFF', termination_type: 'TIMER' });
        assert.strictEqual(r.last('hvac_mode'), 'off');
        assert.strictEqual(r.last('preset_mode'), 'For a set time');
    });

    test('presence never lands on the preset_mode topic', async () => {
        for (const away of [1, 2]) {
            const r = await publish({ field_6240: 0, field_61e0: 1, field_6160: away });
            const values = r.all('preset_mode').map(m => m.payload);
            assert.deepStrictEqual(values, ['none'], `field_6160=${away}`);
            assert.ok(r.last('home_away'), 'home_away is still published');
        }
    });
});
