/**
 * @file lib/zigbee-source.js
 * @brief Feeds emulated Tado sensors (RU wireless sensors) from an MQTT source topic,
 *        typically a Zigbee2MQTT thermometer (`zigbee2mqtt/<friendly name>` JSON).
 *
 * Per emulated device: source_topic plus optional JSON keys (defaults temperature /
 * humidity / battery). Readings are validated, rate limited, and dropped when stale.
 */

'use strict';

const DEFAULTS = {
    minPushIntervalMs: 30 * 1000,   // never push to RF more often than this
    heartbeatMs: 5 * 60 * 1000,     // push unchanged readings at least this often
    staleMs: 30 * 60 * 1000,        // stop pushing if source silent this long
    minDeltaC: 0.1,                 // push sooner on a change this large
    checkIntervalMs: 60 * 1000
};

const TEMP_RANGE = [-20, 60];
const HUMIDITY_RANGE = [0, 100];

/** Pull a finite number from a parsed payload by (dotted) key, within range. */
function pickNumber(obj, key, [min, max]) {
    if (!obj || !key) return null;
    let v = obj;
    for (const part of String(key).split('.')) {
        if (v == null || typeof v !== 'object') return null;
        v = v[part];
    }
    if (typeof v === 'string' && v.trim() !== '') v = Number(v);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return null;
    return v;
}

/**
 * Parse a source payload. Returns { temp_celsius, humidity_percent?, battery_mv? } or null
 * if there is no valid temperature. Zigbee battery is a percentage (0-100); it is mapped to
 * a plausible mV so the emulated device reports a non-empty battery.
 */
function parseReading(payload, dev) {
    let obj;
    try { obj = JSON.parse(String(payload)); } catch (e) { return null; }
    const temp = pickNumber(obj, dev.source_temp_key || 'temperature', TEMP_RANGE);
    if (temp === null) return null;
    const out = { temp_celsius: Math.round(temp * 100) / 100 };
    const hum = pickNumber(obj, dev.source_humidity_key || 'humidity', HUMIDITY_RANGE);
    if (hum !== null) out.humidity_percent = hum;
    const bat = pickNumber(obj, dev.source_battery_key || 'battery', [0, 100]);
    if (bat !== null) out.battery_mv = Math.round(3000 + bat * 15); // 0..100 % -> 3000..4500 mV
    return out;
}

function create(opts = {}) {
    const cfg = { ...DEFAULTS, ...(opts.config || {}) };
    const now = opts.now || (() => Date.now());
    const log = opts.log || (() => { });
    const { mqttClient, getDevices, applyTelemetry } = opts;

    const bindings = new Map();     // serial -> { dev, lastReadingAt, lastPushAt, lastPushTemp, stale, pending }
    const subscribed = new Set();   // topics we've subscribed to (mqtt-client can't unsubscribe)
    let timer = null;

    function onMessage(topic, payload) {
        for (const b of bindings.values()) {
            if (b.dev.source_topic === topic) handleReading(b, payload);
        }
    }

    function handleReading(b, payload) {
        const reading = parseReading(payload, b.dev);
        if (!reading) {
            log('debug', `[zigbee-source] ${b.dev.serial_no}: ignoring invalid payload on ${b.dev.source_topic}`);
            return;
        }
        const t = now();
        b.lastReadingAt = t;
        if (b.stale) {
            b.stale = false;
            log('info', `[zigbee-source] ${b.dev.serial_no}: source recovered`);
        }
        b.pending = reading;
        const changed = b.lastPushTemp === null || Math.abs(reading.temp_celsius - b.lastPushTemp) >= cfg.minDeltaC;
        const sincePush = t - b.lastPushAt;
        const due = changed ? sincePush >= cfg.minPushIntervalMs : sincePush >= cfg.heartbeatMs;
        // Always record the state; only hit the RF link when due.
        flush(b, due);
        if (!due && changed) scheduleDeferred(b);
    }

    function flush(b, push) {
        const reading = b.pending;
        if (!reading) return;
        if (push) {
            b.lastPushAt = now();
            b.lastPushTemp = reading.temp_celsius;
            b.pending = null;
        }
        Promise.resolve(applyTelemetry(b.dev.serial_no, reading, { push })).catch(e =>
            log('warn', `[zigbee-source] ${b.dev.serial_no}: apply failed: ${e.message}`));
    }

    // A changed reading arrived inside the min-interval window: push when the window ends.
    function scheduleDeferred(b) {
        if (b.deferred) return;
        const wait = Math.max(0, cfg.minPushIntervalMs - (now() - b.lastPushAt));
        b.deferred = setTimeout(() => {
            b.deferred = null;
            if (b.pending && !b.stale) flush(b, true);
        }, wait);
        if (b.deferred.unref) b.deferred.unref();
    }

    function checkStale() {
        const t = now();
        for (const b of bindings.values()) {
            if (b.stale || b.lastReadingAt === null) continue;
            if (t - b.lastReadingAt > cfg.staleMs) {
                b.stale = true;
                b.pending = null;
                log('warn', `[zigbee-source] ${b.dev.serial_no}: no reading from ${b.dev.source_topic} for ${Math.round((t - b.lastReadingAt) / 60000)} min; not pushing stale value`);
            }
        }
    }

    /** Reload bindings from the DB. Call at startup and after a source is edited. */
    async function refresh() {
        const devices = (await getDevices()).filter(d => d.source_topic);
        const seen = new Set();
        for (const dev of devices) {
            seen.add(dev.serial_no);
            const prev = bindings.get(dev.serial_no);
            if (prev && prev.dev.source_topic === dev.source_topic) {
                prev.dev = dev; // key names may have changed
            } else {
                if (prev && prev.deferred) clearTimeout(prev.deferred);
                bindings.set(dev.serial_no, { dev, lastReadingAt: null, lastPushAt: 0, lastPushTemp: null, stale: false, pending: null, deferred: null });
            }
            if (!subscribed.has(dev.source_topic)) {
                subscribed.add(dev.source_topic);
                mqttClient.subscribe(dev.source_topic, onMessage);
            }
        }
        for (const serial of [...bindings.keys()]) {
            if (!seen.has(serial)) {
                const b = bindings.get(serial);
                if (b.deferred) clearTimeout(b.deferred);
                bindings.delete(serial);
            }
        }
    }

    function start() {
        timer = setInterval(checkStale, cfg.checkIntervalMs);
        if (timer.unref) timer.unref();
        return refresh();
    }

    function stop() {
        if (timer) clearInterval(timer);
        for (const b of bindings.values()) if (b.deferred) clearTimeout(b.deferred);
        bindings.clear();
    }

    function getStatus(serial) {
        const b = bindings.get(serial);
        if (!b) return null;
        return { topic: b.dev.source_topic, lastReadingAt: b.lastReadingAt, lastPushAt: b.lastPushAt || null, stale: b.stale };
    }

    return { start, stop, refresh, checkStale, getStatus, _onMessage: onMessage };
}

let instance = null;
const setInstance = (i) => { instance = i; };
const getInstance = () => instance;

/**
 * Validate a user-supplied source topic. Returns an error string, or null if OK.
 * Wildcards are refused (one device, one sensor) and tanoclo's own topic tree is
 * off limits so a source can never loop back into command topics.
 */
function validateSourceTopic(topic) {
    if (typeof topic !== 'string' || topic.trim() === '' || topic.length > 255) return 'source_topic must be a non-empty string up to 255 chars';
    if (/[+#\0]/.test(topic)) return 'source_topic must not contain wildcards';
    if (topic.startsWith('/') || topic.startsWith('$')) return 'source_topic must not start with / or $';
    if (topic.toLowerCase().startsWith('tado/tanoclo')) return 'source_topic must not be inside tado/tanoclo/';
    return null;
}

module.exports = { create, parseReading, validateSourceTopic, setInstance, getInstance, DEFAULTS };
