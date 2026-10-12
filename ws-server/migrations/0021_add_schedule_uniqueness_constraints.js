/**
 * Migration 0021: Add uniqueness constraints for schedule tables.
 * 
 * Prevents race conditions and duplicate timetables or schedule blocks:
 * 1. Deduplicates any duplicate rows in zone_timetables and schedule_blocks.
 * 2. Adds UNIQUE KEY uq_zone_timetable (zone_id, home_id, type) on zone_timetables.
 * 3. Adds UNIQUE KEY uq_schedule_block (timetable_id, home_id, day_type, start_time) on schedule_blocks.
 */

'use strict';

async function up(pool) {
    console.log('[Migration 0021] Adding schedule uniqueness constraints...');

    // 1. Deduplicate schedule_blocks if any duplicate start_time exists per day_type & timetable
    try {
        await pool.execute(`
            DELETE b1 FROM schedule_blocks b1
            INNER JOIN schedule_blocks b2 
            WHERE b1.timetable_id = b2.timetable_id 
              AND b1.home_id <=> b2.home_id 
              AND b1.day_type = b2.day_type 
              AND b1.start_time = b2.start_time 
              AND b1.id < b2.id
        `);
    } catch (e) {
        console.warn('[Migration 0021] Warning during schedule_blocks deduplication:', e.message);
    }

    // 2. Deduplicate zone_timetables if any duplicate type exists per zone
    try {
        await pool.execute(`
            DELETE t1 FROM zone_timetables t1
            INNER JOIN zone_timetables t2
            WHERE t1.zone_id = t2.zone_id
              AND t1.home_id <=> t2.home_id
              AND t1.type = t2.type
              AND (
                (t1.is_active < t2.is_active)
                OR (t1.is_active = t2.is_active AND t1.id < t2.id)
              )
        `);
    } catch (e) {
        console.warn('[Migration 0021] Warning during zone_timetables deduplication:', e.message);
    }

    // 3. Add UNIQUE KEY uq_zone_timetable (zone_id, home_id, type)
    try {
        const [rows] = await pool.execute("SHOW INDEX FROM zone_timetables WHERE Key_name = 'uq_zone_timetable'");
        if (rows.length === 0) {
            await pool.execute('ALTER TABLE zone_timetables ADD UNIQUE KEY uq_zone_timetable (zone_id, home_id, type)');
            console.log('[Migration 0021] Added UNIQUE KEY uq_zone_timetable on zone_timetables.');
        } else {
            console.log('[Migration 0021] UNIQUE KEY uq_zone_timetable already exists.');
        }
    } catch (e) {
        console.warn('[Migration 0021] Error adding uq_zone_timetable:', e.message);
        throw e;
    }

    // 4. Add UNIQUE KEY uq_schedule_block (timetable_id, home_id, day_type, start_time)
    try {
        const [rows] = await pool.execute("SHOW INDEX FROM schedule_blocks WHERE Key_name = 'uq_schedule_block'");
        if (rows.length === 0) {
            await pool.execute('ALTER TABLE schedule_blocks ADD UNIQUE KEY uq_schedule_block (timetable_id, home_id, day_type, start_time)');
            console.log('[Migration 0021] Added UNIQUE KEY uq_schedule_block on schedule_blocks.');
        } else {
            console.log('[Migration 0021] UNIQUE KEY uq_schedule_block already exists.');
        }
    } catch (e) {
        console.warn('[Migration 0021] Error adding uq_schedule_block:', e.message);
        throw e;
    }
}

async function down(pool) {
    try {
        await pool.execute('ALTER TABLE schedule_blocks DROP INDEX uq_schedule_block');
    } catch (e) {}

    try {
        await pool.execute('ALTER TABLE zone_timetables DROP INDEX uq_zone_timetable');
    } catch (e) {}
}

module.exports = { up, down };
