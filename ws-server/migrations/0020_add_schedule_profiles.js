/**
 * Migration 0020: Add schedule_profiles and schedule_profile_blocks tables.
 * 
 * Supports seasonal heating schedule profiles (Autumn, Winter, Spring, Holiday, etc.)
 * that can switch all zone schedules manually or automatically by date ranges.
 */

'use strict';

async function up(pool) {
    console.log('[Migration 0020] Creating schedule profiles tables and columns...');

    // 1. Add active_schedule_profile_id to homes table if missing
    try {
        const [homeCols] = await pool.execute(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'homes' AND COLUMN_NAME = 'active_schedule_profile_id'
        `);

        if (homeCols.length === 0) {
            await pool.execute('ALTER TABLE homes ADD COLUMN active_schedule_profile_id INT(11) NULL DEFAULT NULL');
            console.log('[Migration 0020] Added active_schedule_profile_id to homes table.');
        }
    } catch (e) {
        console.warn('[Migration 0020] Warning checking/adding homes columns:', e.message);
    }

    // 2. Create schedule_profiles table
    const createProfilesTableSql = `
        CREATE TABLE IF NOT EXISTS schedule_profiles (
            id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
            home_id INT(11) NOT NULL,
            name VARCHAR(100) NOT NULL,
            icon VARCHAR(50) NOT NULL DEFAULT 'calendar',
            description VARCHAR(255) DEFAULT '',
            is_active TINYINT(1) NOT NULL DEFAULT 0,
            auto_start_date VARCHAR(10) DEFAULT NULL,
            order_index INT(11) NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_sp_home (home_id),
            CONSTRAINT fk_sp_home FOREIGN KEY (home_id) REFERENCES homes (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    try {
        await pool.execute(createProfilesTableSql);
        console.log('[Migration 0020] Created schedule_profiles table.');
    } catch (e) {
        console.warn('[Migration 0020] Warning creating schedule_profiles table:', e.message);
    }

    // 3. Create schedule_profile_blocks table
    const createProfileBlocksTableSql = `
        CREATE TABLE IF NOT EXISTS schedule_profile_blocks (
            id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
            profile_id INT(11) NOT NULL,
            home_id INT(11) NOT NULL,
            zone_id INT(11) NOT NULL,
            timetable_type VARCHAR(50) NOT NULL DEFAULT 'ONE_DAY',
            day_type VARCHAR(50) NOT NULL,
            start_time VARCHAR(10) NOT NULL,
            end_time VARCHAR(10) NOT NULL,
            geolocation_override TINYINT(1) DEFAULT 0,
            setting_type VARCHAR(50) DEFAULT 'HEATING',
            setting_power VARCHAR(20) DEFAULT 'ON',
            setting_temp_celsius DECIMAL(5,2) DEFAULT NULL,
            setting_temp_fahrenheit DECIMAL(5,2) DEFAULT NULL,
            INDEX idx_spb_profile_zone (profile_id, zone_id),
            INDEX idx_spb_home (home_id),
            CONSTRAINT fk_spb_profile FOREIGN KEY (profile_id) REFERENCES schedule_profiles (id) ON DELETE CASCADE,
            CONSTRAINT fk_spb_zone FOREIGN KEY (zone_id, home_id) REFERENCES zones (id, home_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    try {
        await pool.execute(createProfileBlocksTableSql);
        console.log('[Migration 0020] Created schedule_profile_blocks table.');
    } catch (e) {
        console.warn('[Migration 0020] Warning creating schedule_profile_blocks table:', e.message);
    }

    // 4. Seed default seasonal profiles for existing homes that lack profiles
    try {
        const [homes] = await pool.execute('SELECT id FROM homes');
        for (const home of homes) {
            const homeId = home.id;
            const [existingProfiles] = await pool.execute('SELECT id FROM schedule_profiles WHERE home_id = ?', [homeId]);
            if (existingProfiles.length === 0) {
                console.log(`[Migration 0020] Seeding default profiles for home ${homeId}...`);

                // Query current active blocks across all zones for this home
                const [zones] = await pool.execute('SELECT id, type FROM zones WHERE home_id = ?', [homeId]);
                const zoneBlocks = [];

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
                        zoneBlocks.push({ zoneId: zone.id, ttType, blocks });
                    }
                }

                // Seed single Default profile capturing exact current settings
                const [pRes] = await pool.execute(`
                    INSERT INTO schedule_profiles (home_id, name, icon, description, is_active, auto_start_date, order_index)
                    VALUES (?, 'Default', 'calendar', 'Current schedule profile', 1, NULL, 0)
                `, [homeId]);

                const profileId = pRes.insertId;

                // Insert blocks for this Default profile
                for (const zb of zoneBlocks) {
                    for (const b of zb.blocks) {
                        await pool.execute(`
                            INSERT INTO schedule_profile_blocks (
                                profile_id, home_id, zone_id, timetable_type, day_type, start_time, end_time,
                                geolocation_override, setting_type, setting_power, setting_temp_celsius, setting_temp_fahrenheit
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `, [
                            profileId, homeId, zb.zoneId, zb.ttType, b.day_type, b.start_time, b.end_time,
                            b.geolocation_override || 0, b.setting_type, b.setting_power, b.setting_temp_celsius, b.setting_temp_fahrenheit
                        ]);
                    }
                }

                await pool.execute('UPDATE homes SET active_schedule_profile_id = ? WHERE id = ?', [profileId, homeId]);
            }
        }
    } catch (e) {
        console.warn('[Migration 0020] Warning seeding schedule profiles:', e.message);
    }
}

async function down(pool) {
    try {
        await pool.execute('DROP TABLE IF EXISTS schedule_profile_blocks');
        await pool.execute('DROP TABLE IF EXISTS schedule_profiles');
        await pool.execute('ALTER TABLE homes DROP COLUMN IF EXISTS active_schedule_profile_id');
    } catch (e) {}
}

module.exports = { up, down };
