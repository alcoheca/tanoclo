/**
 * Migration 0013: Let an emulated device take its readings from an MQTT source
 * (e.g. a Zigbee2MQTT thermometer topic).
 */

async function up(pool) {
    const cols = [
        "source_topic VARCHAR(255) DEFAULT NULL",
        "source_temp_key VARCHAR(64) DEFAULT NULL",
        "source_humidity_key VARCHAR(64) DEFAULT NULL",
        "source_battery_key VARCHAR(64) DEFAULT NULL"
    ];
    for (const col of cols) {
        try {
            await pool.execute(`ALTER TABLE emulated_devices ADD COLUMN ${col}`);
        } catch (e) {
            if (!/Duplicate column/i.test(e.message)) throw e;
        }
    }
}

async function down(pool) {
    for (const c of ['source_topic', 'source_temp_key', 'source_humidity_key', 'source_battery_key']) {
        try { await pool.execute(`ALTER TABLE emulated_devices DROP COLUMN ${c}`); } catch (e) { }
    }
}

module.exports = { up, down };
