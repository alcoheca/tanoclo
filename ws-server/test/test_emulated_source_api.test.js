'use strict';
require('./test_config');

const express = require('express');
const http = require('http');
const db = require('../lib/db');
const dbDevices = require('../lib/db-devices');
const emulatedRouter = require('../api/routes/setup/emulated');

const SERIAL = 'RU0000009901';

let server, base, nodeId;

async function call(method, path, body) {
    const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/emulated', emulatedRouter);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/emulated`;

    const pool = db.getPool();
    await pool.execute('DELETE FROM emulated_devices WHERE serial_no = ?', [SERIAL]);
    const node = await dbDevices.createEsp32Node({ name: 'zigbee-source-test', ip_address: '127.0.0.1' });
    nodeId = node.id;
    await dbDevices.createEmulatedDevice({
        serial_no: SERIAL, esp32_node_id: nodeId, home_id: 999999, ipv6_address: 'fe80::1', pairing_state: 'PAIRED'
    });
});

afterAll(async () => {
    const pool = db.getPool();
    await pool.execute('DELETE FROM emulated_devices WHERE serial_no = ?', [SERIAL]).catch(() => { });
    await pool.execute('DELETE FROM devices WHERE serial_no = ?', [SERIAL]).catch(() => { });
    if (nodeId) await dbDevices.deleteEsp32Node(nodeId).catch(() => { });
    await new Promise(r => server.close(r));
});

describe('PUT /devices/:serial/source', () => {
    it('binds, lists and unbinds a source topic', async () => {
        let r = await call('PUT', `/devices/${SERIAL}/source`, { source_topic: ' zigbee2mqtt/lounge ', source_temp_key: 'temperature' });
        expect(r.status).toBe(200);
        expect(r.body.source_topic).toBe('zigbee2mqtt/lounge');

        r = await call('GET', '/devices');
        const dev = r.body.devices.find(d => d.serial_no === SERIAL);
        expect(dev.source_topic).toBe('zigbee2mqtt/lounge');
        expect(dev.source_temp_key).toBe('temperature');
        expect(dev.source_humidity_key).toBeNull();

        r = await call('PUT', `/devices/${SERIAL}/source`, { source_topic: null });
        expect(r.status).toBe(200);
        r = await call('GET', '/devices');
        expect(r.body.devices.find(d => d.serial_no === SERIAL).source_topic).toBeNull();
    });

    it('rejects wildcards, internal topics and bad key names', async () => {
        for (const body of [
            { source_topic: 'zigbee2mqtt/#' },
            { source_topic: 'tado/tanoclo/emulated/RU1/set/temp' },
            { source_topic: 'zigbee2mqtt/ok', source_temp_key: 'a b;c' }
        ]) {
            const r = await call('PUT', `/devices/${SERIAL}/source`, body);
            expect(r.status).toBe(400);
        }
    });

    it('404s for unknown devices', async () => {
        const r = await call('PUT', '/devices/RU0000009999/source', { source_topic: 'zigbee2mqtt/x' });
        expect(r.status).toBe(404);
    });
});
