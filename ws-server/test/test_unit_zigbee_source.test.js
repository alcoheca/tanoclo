'use strict';
require('./test_config');

const zs = require('../lib/zigbee-source');

const DEV = { serial_no: 'RU0000000001', source_topic: 'zigbee2mqtt/lounge' };

function setup(devices = [DEV], config = {}) {
    let t = 1_000_000;
    const handlers = new Map();
    const mqttClient = { subscribe: vi.fn((topic, h) => handlers.set(topic, h)) };
    const applied = [];
    const src = zs.create({
        mqttClient,
        now: () => t,
        config,
        getDevices: async () => devices,
        applyTelemetry: async (serial, data, opts) => { applied.push({ serial, data, push: opts.push }); }
    });
    const send = (obj, topic = DEV.source_topic) => handlers.get(topic)(topic, JSON.stringify(obj));
    return { src, mqttClient, applied, send, advance: (ms) => { t += ms; } };
}

describe('zigbee-source parseReading', () => {
    it('parses z2m payloads and maps battery % to mV', () => {
        expect(zs.parseReading('{"temperature":21.456,"humidity":48,"battery":100}', {}))
            .toEqual({ temp_celsius: 21.46, humidity_percent: 48, battery_mv: 4500 });
    });
    it('honours custom keys and numeric strings', () => {
        expect(zs.parseReading('{"t":"19.5"}', { source_temp_key: 't' })).toEqual({ temp_celsius: 19.5 });
    });
    it('rejects garbage, missing and out-of-range temperatures', () => {
        for (const p of ['nope', '{}', '{"temperature":null}', '{"temperature":"abc"}', '{"temperature":99}', '{"temperature":-50}']) {
            expect(zs.parseReading(p, {})).toBeNull();
        }
    });
    it('drops out-of-range humidity but keeps the temperature', () => {
        expect(zs.parseReading('{"temperature":20,"humidity":150}', {})).toEqual({ temp_celsius: 20 });
    });
});

describe('zigbee-source validateSourceTopic', () => {
    it('accepts a normal topic and refuses wildcards / internal topics', () => {
        expect(zs.validateSourceTopic('zigbee2mqtt/lounge')).toBeNull();
        for (const t of ['', 'a/#', 'a/+/b', '/abs', '$SYS/x', 'tado/tanoclo/h/1/set/x', 'TADO/tanoclo/emulated/RU1/telemetry', 5, null]) {
            expect(zs.validateSourceTopic(t)).toBeTypeOf('string');
        }
    });
});

describe('zigbee-source bridge', () => {
    it('subscribes once per topic and pushes the first reading', async () => {
        const { src, mqttClient, applied, send } = setup();
        await src.start();
        await src.refresh();
        expect(mqttClient.subscribe).toHaveBeenCalledTimes(1);
        send({ temperature: 20.0 });
        expect(applied).toEqual([{ serial: DEV.serial_no, data: { temp_celsius: 20 }, push: true }]);
        src.stop();
    });

    it('rate limits changed readings and flushes the latest after the window', async () => {
        vi.useFakeTimers();
        try {
            const { src, applied, send, advance } = setup();
            await src.start();
            send({ temperature: 20.0 });
            advance(5000);
            send({ temperature: 20.4 });   // changed but inside 30 s window: state only
            expect(applied.map(a => a.push)).toEqual([true, false]);
            advance(25000);
            await vi.advanceTimersByTimeAsync(25000);
            expect(applied).toHaveLength(3);
            expect(applied[2]).toMatchObject({ push: true, data: { temp_celsius: 20.4 } });
            src.stop();
        } finally { vi.useRealTimers(); }
    });

    it('does not push unchanged readings until the heartbeat', async () => {
        const { src, applied, send, advance } = setup();
        await src.start();
        send({ temperature: 20.0 });
        advance(60000);
        send({ temperature: 20.05 });
        expect(applied[1].push).toBe(false);
        advance(5 * 60000);
        send({ temperature: 20.05 });
        expect(applied[2].push).toBe(true);
        src.stop();
    });

    it('goes stale after silence, then recovers', async () => {
        const { src, send, advance } = setup();
        await src.start();
        send({ temperature: 20.0 });
        advance(31 * 60000);
        src.checkStale();
        expect(src.getStatus(DEV.serial_no).stale).toBe(true);
        send({ temperature: 20.0 });
        expect(src.getStatus(DEV.serial_no).stale).toBe(false);
        src.stop();
    });

    it('ignores invalid payloads and unbinds removed devices on refresh', async () => {
        let devices = [DEV];
        const { src, applied } = setup();
        const s2 = zs.create({ mqttClient: { subscribe() { } }, getDevices: async () => devices, applyTelemetry: async () => { } });
        await s2.start();
        expect(s2.getStatus(DEV.serial_no)).not.toBeNull();
        devices = [];
        await s2.refresh();
        expect(s2.getStatus(DEV.serial_no)).toBeNull();
        s2.stop();
        await src.start();
        src._onMessage(DEV.source_topic, 'not json');
        expect(applied).toHaveLength(0);
        src.stop();
    });
});
