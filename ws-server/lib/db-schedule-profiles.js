/**
 * @file lib/db-schedule-profiles.js
 * @brief Database operations for seasonal heating schedule profiles.
 */

'use strict';

const { getPool, _log } = require('./db-base');
const { getLocalParts } = require('./utils');
const dbHomes = require('./db-homes');

/**
 * Check if a date (in MM-DD format) falls within a date range (both MM-DD),
 * correctly handling ranges that span across the new year (e.g., 12-21 to 03-20).
 *
 * @param {string} dateStr - 'MM-DD'
 * @param {string} startStr - 'MM-DD'
 * @param {string} endStr - 'MM-DD'
 * @returns {boolean}
 */
function isDateInRange(dateStr, startStr, endStr) {
    if (!dateStr || !startStr || !endStr) return false;
    if (startStr <= endStr) {
        return dateStr >= startStr && dateStr <= endStr;
    }
    // Range wraps around year boundary (e.g. 12-21 to 03-20)
    return dateStr >= startStr || dateStr <= endStr;
}

/**
 * Fetch all schedule profiles for a home.
 * @param {number} homeId
 * @returns {Promise<{activeProfileId: number|null, profiles: Array}>}
 */
async function getScheduleProfiles(homeId) {
    const pool = getPool();
    const [homeRows] = await pool.execute(
        'SELECT active_schedule_profile_id FROM homes WHERE id = ?',
        [homeId]
    );

    const activeProfileId = homeRows[0]?.active_schedule_profile_id ?? null;

    const [profiles] = await pool.execute(`
        SELECT sp.id, sp.name, sp.icon, sp.description, sp.is_active, 
               sp.auto_start_date, sp.order_index,
               COUNT(DISTINCT spb.zone_id) as zones_count
        FROM schedule_profiles sp
        LEFT JOIN schedule_profile_blocks spb ON spb.profile_id = sp.id
        WHERE sp.home_id = ?
        GROUP BY sp.id
        ORDER BY sp.order_index ASC, sp.id ASC
    `, [homeId]);

    const formatted = profiles.map(p => ({
        id: p.id,
        name: p.name,
        icon: p.icon || 'calendar',
        description: p.description || '',
        isActive: Boolean(p.is_active) || (p.id === activeProfileId),
        autoStartDate: p.auto_start_date,
        orderIndex: p.order_index,
        zonesCount: Number(p.zones_count || 0)
    }));

    return {
        activeProfileId,
        profiles: formatted
    };
}

/**
 * Fetch detailed schedule profile info including all zone blocks.
 * @param {number} homeId
 * @param {number} profileId
 * @returns {Promise<Object|null>}
 */
async function getScheduleProfileDetails(homeId, profileId) {
    const pool = getPool();
    const [pRows] = await pool.execute(
        'SELECT * FROM schedule_profiles WHERE id = ? AND home_id = ?',
        [profileId, homeId]
    );
    if (pRows.length === 0) return null;
    const p = pRows[0];

    const [blocksRows] = await pool.execute(`
        SELECT spb.*, z.name as zone_name, z.type as zone_type
        FROM schedule_profile_blocks spb
        JOIN zones z ON z.id = spb.zone_id AND z.home_id = spb.home_id
        WHERE spb.profile_id = ? AND spb.home_id = ?
        ORDER BY spb.zone_id ASC, spb.start_time ASC
    `, [profileId, homeId]);

    // Group blocks by zone
    const zonesMap = new Map();
    for (const row of blocksRows) {
        if (!zonesMap.has(row.zone_id)) {
            zonesMap.set(row.zone_id, {
                zoneId: row.zone_id,
                zoneName: row.zone_name,
                zoneType: row.zone_type || 'HEATING',
                timetableType: row.timetable_type || 'ONE_DAY',
                blocks: []
            });
        }
        zonesMap.get(row.zone_id).blocks.push({
            id: row.id,
            dayType: row.day_type,
            start: row.start_time,
            end: row.end_time,
            geolocationOverride: Boolean(row.geolocation_override),
            setting: {
                type: row.setting_type || 'HEATING',
                power: row.setting_power || 'ON',
                temperature: (row.setting_temp_celsius !== null) ? {
                    celsius: parseFloat(row.setting_temp_celsius),
                    fahrenheit: (row.setting_temp_fahrenheit !== null) ? parseFloat(row.setting_temp_fahrenheit) : null
                } : null
            }
        });
    }

    return {
        id: p.id,
        homeId: p.home_id,
        name: p.name,
        icon: p.icon || 'calendar',
        description: p.description || '',
        isActive: Boolean(p.is_active),
        autoStartDate: p.auto_start_date,
        orderIndex: p.order_index,
        zones: Array.from(zonesMap.values())
    };
}

/**
 * Capture active schedule blocks from all zones for a home into a profile.
 * @param {number} homeId
 * @param {number} profileId
 */
async function captureCurrentSchedulesToProfile(homeId, profileId) {
    const pool = getPool();
    // Verify profile belongs to home
    const [pRows] = await pool.execute('SELECT id FROM schedule_profiles WHERE id = ? AND home_id = ?', [profileId, homeId]);
    if (pRows.length === 0) throw new Error('Profile not found');

    // Remove existing blocks for this profile
    await pool.execute('DELETE FROM schedule_profile_blocks WHERE profile_id = ? AND home_id = ?', [profileId, homeId]);

    // Query active timetable blocks for all zones in home
    const [zones] = await pool.execute('SELECT id FROM zones WHERE home_id = ?', [homeId]);
    for (const zone of zones) {
        const [ttRows] = await pool.execute(
            'SELECT id, type FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND is_active = 1 LIMIT 1',
            [zone.id, homeId]
        );
        const ttType = ttRows.length > 0 ? ttRows[0].type : 'ONE_DAY';
        const ttId = ttRows.length > 0 ? ttRows[0].id : null;

        if (ttId) {
            const [blocks] = await pool.execute(
                'SELECT day_type, start_time, end_time, geolocation_override, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit FROM schedule_blocks WHERE timetable_id = ?',
                [ttId]
            );
            for (const b of blocks) {
                await pool.execute(`
                    INSERT INTO schedule_profile_blocks (
                        profile_id, home_id, zone_id, timetable_type, day_type, start_time, end_time,
                        geolocation_override, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    profileId, homeId, zone.id, ttType, b.day_type, b.start_time, b.end_time,
                    b.geolocation_override || 0, b.setting_type, b.setting_power, b.setting_temp_celsius, b.setting_temp_fahrenheit
                ]);
            }
        }
    }
}

/**
 * Add a new zone with default schedule blocks to all existing profiles in a home.
 * @param {number} homeId
 * @param {number} zoneId
 * @param {string} zoneType
 */
async function addZoneToAllProfiles(homeId, zoneId, zoneType) {
    const pool = getPool();
    const [profiles] = await pool.execute('SELECT id FROM schedule_profiles WHERE home_id = ?', [homeId]);
    if (profiles.length === 0) return;

    const isHotWater = zoneType === 'HOT_WATER';
    const settingType = isHotWater ? 'HOT_WATER' : 'HEATING';
    const tempC = isHotWater ? 50.0 : 20.0;
    const tempF = isHotWater ? 122.0 : 68.0;

    for (const p of profiles) {
        const [existing] = await pool.execute(
            'SELECT id FROM schedule_profile_blocks WHERE profile_id = ? AND home_id = ? AND zone_id = ? LIMIT 1',
            [p.id, homeId, zoneId]
        );
        if (existing.length === 0) {
            await pool.execute(`
                INSERT INTO schedule_profile_blocks (
                    profile_id, home_id, zone_id, timetable_type, day_type, start_time, end_time,
                    geolocation_override, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                ) VALUES (?, ?, ?, 'ONE_DAY', 'MONDAY_TO_SUNDAY', '00:00', '00:00', 0, ?, 'ON', ?, ?)
            `, [p.id, homeId, zoneId, settingType, tempC, tempF]);
        }
    }
}

/**
 * Create a new schedule profile.
 * Always seeds schedules from current home timetable settings (or from source profile).
 * @param {number} homeId
 * @param {Object} data
 * @returns {Promise<Object>}
 */
async function createScheduleProfile(homeId, data) {
    const pool = getPool();
    const { name, icon = 'calendar', description = '', autoStartDate = null, copyFromProfileId = null } = data;

    const [countRows] = await pool.execute('SELECT COUNT(*) as c FROM schedule_profiles WHERE home_id = ?', [homeId]);
    const orderIndex = countRows[0].c;

    const validStartDate = autoStartDate ? String(autoStartDate).trim() : null;

    const [res] = await pool.execute(`
        INSERT INTO schedule_profiles (home_id, name, icon, description, is_active, auto_start_date, order_index)
        VALUES (?, ?, ?, ?, 0, ?, ?)
    `, [homeId, name, icon, description, validStartDate, orderIndex]);

    const profileId = res.insertId;

    if (copyFromProfileId) {
        // Copy blocks from specified source profile
        const [sourceBlocks] = await pool.execute(
            'SELECT * FROM schedule_profile_blocks WHERE profile_id = ? AND home_id = ?',
            [copyFromProfileId, homeId]
        );
        for (const b of sourceBlocks) {
            await pool.execute(`
                INSERT INTO schedule_profile_blocks (
                    profile_id, home_id, zone_id, timetable_type, day_type, start_time, end_time,
                    geolocation_override, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                profileId, homeId, b.zone_id, b.timetable_type, b.day_type, b.start_time, b.end_time,
                b.geolocation_override, b.setting_type, b.setting_power, b.setting_temp_celsius, b.setting_temp_fahrenheit
            ]);
        }
    } else {
        // Always seed new profile with current settings
        await captureCurrentSchedulesToProfile(homeId, profileId);
    }

    return { id: profileId, homeId, name, icon, description, autoStartDate: validStartDate, orderIndex };
}

/**
 * Update metadata of an existing schedule profile.
 * @param {number} homeId
 * @param {number} profileId
 * @param {Object} data
 */
async function updateScheduleProfile(homeId, profileId, data) {
    const pool = getPool();
    const { name, icon, description, autoStartDate, orderIndex } = data;

    const fields = [];
    const values = [];

    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (icon !== undefined) { fields.push('icon = ?'); values.push(icon); }
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    if (autoStartDate !== undefined) {
        const val = autoStartDate ? String(autoStartDate).trim() : null;
        fields.push('auto_start_date = ?');
        values.push(val);
    }
    if (orderIndex !== undefined) { fields.push('order_index = ?'); values.push(orderIndex); }

    if (fields.length === 0) return;

    values.push(profileId, homeId);
    await pool.execute(
        `UPDATE schedule_profiles SET ${fields.join(', ')} WHERE id = ? AND home_id = ?`,
        values
    );
}

/**
 * Delete a schedule profile.
 * Cannot delete if it is the only remaining profile.
 * If active, activates the first available profile before deleting.
 * @param {number} homeId
 * @param {number} profileId
 */
async function deleteScheduleProfile(homeId, profileId) {
    const pool = getPool();
    const [profiles] = await pool.execute('SELECT id, is_active FROM schedule_profiles WHERE home_id = ?', [homeId]);
    if (profiles.length <= 1) {
        throw new Error('Cannot delete the only remaining profile');
    }

    const target = profiles.find(p => p.id === Number(profileId));
    if (!target) throw new Error('Profile not found');

    if (target.is_active) {
        const nextProfile = profiles.find(p => p.id !== Number(profileId));
        if (nextProfile) {
            await activateScheduleProfile(homeId, nextProfile.id, { skipDeleteNotify: true });
        }
    }

    await pool.execute('DELETE FROM schedule_profile_blocks WHERE profile_id = ? AND home_id = ?', [profileId, homeId]);
    await pool.execute('DELETE FROM schedule_profiles WHERE id = ? AND home_id = ?', [profileId, homeId]);
}

/**
 * Save schedule blocks for a specific zone inside a profile.
 * @param {number} homeId
 * @param {number} profileId
 * @param {number} zoneId
 * @param {string} timetableType
 * @param {Array} blocks
 */
async function saveProfileZoneBlocks(homeId, profileId, zoneId, timetableType, blocks) {
    const pool = getPool();
    // Validate profile
    const [pRows] = await pool.execute('SELECT id FROM schedule_profiles WHERE id = ? AND home_id = ?', [profileId, homeId]);
    if (pRows.length === 0) throw new Error('Profile not found');

    // Remove existing blocks for this zone in this profile
    await pool.execute(
        'DELETE FROM schedule_profile_blocks WHERE profile_id = ? AND home_id = ? AND zone_id = ?',
        [profileId, homeId, zoneId]
    );

    for (const b of blocks) {
        const dayType = b.dayType;
        const start = b.start;
        const end = b.end;
        const geo = b.geolocationOverride ? 1 : 0;
        const settingType = b.setting?.type || 'HEATING';
        const settingPower = b.setting?.power || 'ON';
        const tempC = b.setting?.temperature?.celsius ?? null;
        const tempF = b.setting?.temperature?.fahrenheit ?? (tempC !== null ? Math.round((tempC * 9 / 5 + 32) * 10) / 10 : null);

        await pool.execute(`
            INSERT INTO schedule_profile_blocks (
                profile_id, home_id, zone_id, timetable_type, day_type, start_time, end_time,
                geolocation_override, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            profileId, homeId, zoneId, timetableType || 'ONE_DAY', dayType, start, end,
            geo, settingType, settingPower, tempC, tempF
        ]);
    }
}

/**
 * Activate a schedule profile across all zones in the home.
 * Applies the stored blocks to each zone's timetable and activates it.
 *
 * @param {number} homeId
 * @param {number} profileId
 * @param {Object} [opts]
 * @returns {Promise<{success: boolean, profileId: number, profileName: string}>}
 */
async function activateScheduleProfile(homeId, profileId, opts = {}) {
    const pool = getPool();
    const [pRows] = await pool.execute(
        'SELECT * FROM schedule_profiles WHERE id = ? AND home_id = ?',
        [profileId, homeId]
    );
    if (pRows.length === 0) throw new Error('Profile not found');
    const profile = pRows[0];

    // Fetch all blocks stored for this profile
    const [profileBlocks] = await pool.execute(
        'SELECT * FROM schedule_profile_blocks WHERE profile_id = ? AND home_id = ?',
        [profileId, homeId]
    );

    // Group blocks by zone_id
    const blocksByZone = new Map();
    for (const b of profileBlocks) {
        if (!blocksByZone.has(b.zone_id)) {
            blocksByZone.set(b.zone_id, {
                timetableType: b.timetable_type || 'ONE_DAY',
                blocks: []
            });
        }
        blocksByZone.get(b.zone_id).blocks.push(b);
    }

    // Apply to each zone
    for (const [zoneId, zoneData] of blocksByZone.entries()) {
        const ttType = zoneData.timetableType;

        // Ensure timetable exists for this type
        let [ttRows] = await pool.execute(
            'SELECT id FROM zone_timetables WHERE zone_id = ? AND home_id = ? AND type = ?',
            [zoneId, homeId, ttType]
        );
        let internalTtId;
        if (ttRows.length === 0) {
            const [insertRes] = await pool.execute(
                'INSERT INTO zone_timetables (zone_id, home_id, type, is_active) VALUES (?, ?, ?, 1)',
                [zoneId, homeId, ttType]
            );
            internalTtId = insertRes.insertId;
        } else {
            internalTtId = ttRows[0].id;
        }

        // Deactivate other timetables for this zone and activate this one
        await pool.execute('UPDATE zone_timetables SET is_active = 0 WHERE zone_id = ? AND home_id = ?', [zoneId, homeId]);
        await pool.execute('UPDATE zone_timetables SET is_active = 1 WHERE id = ?', [internalTtId]);

        // Replace schedule blocks for this timetable
        await pool.execute('DELETE FROM schedule_blocks WHERE timetable_id = ?', [internalTtId]);

        for (const b of zoneData.blocks) {
            await pool.execute(`
                INSERT INTO schedule_blocks (
                    timetable_id, home_id, day_type, start_time, end_time,
                    geolocation_override, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                internalTtId, homeId, b.day_type, b.start_time, b.end_time,
                b.geolocation_override, b.setting_type, b.setting_power, b.setting_temp_celsius, b.setting_temp_fahrenheit
            ]);
        }

        await pool.execute('UPDATE zones SET last_schedule_change_at = NOW() WHERE id = ? AND home_id = ?', [zoneId, homeId]);
    }

    // Update active profile state
    await pool.execute('UPDATE schedule_profiles SET is_active = 0 WHERE home_id = ?', [homeId]);
    await pool.execute('UPDATE schedule_profiles SET is_active = 1 WHERE id = ? AND home_id = ?', [profileId, homeId]);
    await pool.execute('UPDATE homes SET active_schedule_profile_id = ? WHERE id = ?', [profileId, homeId]);

    // Publish MQTT telemetry if mqttPublisher is available
    try {
        const mqttPublisher = require('./mqtt-publisher');
        if (mqttPublisher && mqttPublisher.publishHomeTelemetry) {
            await mqttPublisher.publishHomeTelemetry(homeId);
        }
    } catch (e) {
        _log('debug', `[schedule-profiles] Failed to publish MQTT telemetry on profile activate: ${e.message}`);
    }

    return {
        success: true,
        profileId,
        profileName: profile.name
    };
}

/**
 * Evaluate auto schedule profile for a home based on current date.
 * If current date matches a profile's auto_start_date and that profile is not active,
 * automatically activates it!
 * @param {number} homeId
 * @param {string} [overrideDateStr] - Optional 'MM-DD' for testing
 * @returns {Promise<{switched: boolean, activeProfileId: number|null}>}
 */
async function evaluateAutoScheduleProfiles(homeId, overrideDateStr = null) {
    const pool = getPool();
    const [homeRows] = await pool.execute('SELECT active_schedule_profile_id FROM homes WHERE id = ?', [homeId]);
    if (homeRows.length === 0) return { switched: false, activeProfileId: null };

    const home = homeRows[0];

    let dateStr = overrideDateStr;
    if (!dateStr) {
        const tzName = await dbHomes.getHomeTimezone(homeId);
        const local = getLocalParts(new Date(), tzName || 'Europe/Brussels');
        // local.dateStr is YYYY-MM-DD -> slice(5) is MM-DD
        dateStr = local.dateStr.slice(5);
    }

    const [profiles] = await pool.execute(
        'SELECT id, name, auto_start_date FROM schedule_profiles WHERE home_id = ? AND auto_start_date IS NOT NULL ORDER BY order_index ASC',
        [homeId]
    );

    const matchingProfile = profiles.find(p => p.auto_start_date === dateStr);

    if (matchingProfile && matchingProfile.id !== home.active_schedule_profile_id) {
        _log('info', `[schedule-profiles] Auto-switching Home ${homeId} profile to '${matchingProfile.name}' (id: ${matchingProfile.id}) for date ${dateStr}`);
        await activateScheduleProfile(homeId, matchingProfile.id, { reason: 'AUTO_SCHEDULE' });
        return { switched: true, activeProfileId: matchingProfile.id };
    }

    return { switched: false, activeProfileId: home.active_schedule_profile_id };
}

module.exports = {
    isDateInRange,
    getScheduleProfiles,
    getScheduleProfileDetails,
    createScheduleProfile,
    updateScheduleProfile,
    deleteScheduleProfile,
    saveProfileZoneBlocks,
    captureCurrentSchedulesToProfile,
    activateScheduleProfile,
    addZoneToAllProfiles,
    evaluateAutoScheduleProfiles
};
