/**
 * @file migrations/0022_sync_zone_config_listeners_and_invalidate_etags.js
 * @brief Migration 0022: Rebuild zone config peer listeners (0x8000) and invalidate ETags.
 * 
 * Ensures all heating zones have 0x8000 listener URIs binding them to the
 * heating circuit driver (RU/BU/WR) and local zone actuators. Invalidates cached
 * config ETags (setting config_etag_real = NULL) across zones, devices, and circuits
 * so hardware devices re-fetch the complete configuration and listen for 6LoWPAN state packets.
 */

'use strict';

const crypto = require('crypto');
const dbUtils = require('../lib/db-utils');

async function up(pool) {
    console.log('[Migration 0022] Synchronizing zone peer listeners (0x8000) and invalidating config ETags...');

    const [zones] = await pool.execute(
        "SELECT id, home_id, name, type, heating_circuit FROM zones WHERE type != 'HOT_WATER' AND type != 'DHW'"
    );

    let syncedZones = 0;
    for (const z of zones) {
        try {
            const fields = await dbUtils.buildZoneConfigFields(z.home_id, z.id);
            if (!fields) continue;

            const tlvBuf = await dbUtils.buildZoneConfigTLV(z.home_id, z.id);
            const newEtag = tlvBuf && tlvBuf.length > 0
                ? crypto.createHash('md5').update(tlvBuf).digest().subarray(0, 8)
                : crypto.randomBytes(8);

            await pool.execute(
                'UPDATE zones SET config_etag = ?, config_etag_real = NULL WHERE id = ? AND home_id = ?',
                [newEtag, z.id, z.home_id]
            );
            syncedZones++;
        } catch (err) {
            console.warn(`[Migration 0022] Failed to build config for zone ${z.id} (home ${z.home_id}): ${err.message}`);
        }
    }
    console.log(`[Migration 0022] Synchronized full config and peer listeners for ${syncedZones} zone(s).`);

    // Invalidate device config ETags so physical thermostats and valves re-poll /config
    const randomDeviceEtag = crypto.randomBytes(8);
    const [devResult] = await pool.execute(
        "UPDATE devices SET config_etag = ?, config_etag_real = NULL WHERE device_type LIKE 'RU%' OR device_type LIKE 'VA%' OR device_type LIKE 'BU%' OR device_type LIKE 'WR%'",
        [randomDeviceEtag]
    );
    console.log(`[Migration 0022] Invalidated config ETags for ${devResult.affectedRows} thermostat/valve device(s).`);

    // Invalidate heating circuit config ETags so RU refreshes circuit parameters
    const randomCircEtag = crypto.randomBytes(8);
    const [circResult] = await pool.execute(
        'UPDATE heating_circuits SET config_etag = ?, config_etag_real = NULL',
        [randomCircEtag]
    );
    console.log(`[Migration 0022] Invalidated config ETags for ${circResult.affectedRows} heating circuit(s).`);
}

module.exports = {
    up
};
