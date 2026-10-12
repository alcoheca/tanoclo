/**
 * Migration 0019: Add pid_tuning_snapshots table.
 * 
 * Stores historical thermodynamic PID tuning analysis snapshots and tracking of applied zone PID gains.
 * References hydraulic_snapshot_id to correlate PID tuning against baseline hydraulic balancing.
 */

'use strict';

async function up(pool) {
    console.log('[Migration 0019] Creating pid_tuning_snapshots table...');

    const createTableSql = `
        CREATE TABLE IF NOT EXISTS pid_tuning_snapshots (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            home_id INT(11) NOT NULL,
            hydraulic_snapshot_id BIGINT NULL DEFAULT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            analysis_json JSON NOT NULL,
            applied TINYINT(1) NOT NULL DEFAULT 0,
            applied_at TIMESTAMP NULL DEFAULT NULL,
            INDEX idx_pts_home (home_id, created_at DESC),
            INDEX idx_pts_hydraulic (hydraulic_snapshot_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `;

    try {
        await pool.execute(createTableSql);
        console.log('[Migration 0019] Created pid_tuning_snapshots table.');
    } catch (e) {
        console.warn('[Migration 0019] pid_tuning_snapshots creation warning:', e.message);
    }
}

async function down(pool) {
    try {
        await pool.execute('DROP TABLE IF EXISTS pid_tuning_snapshots;');
    } catch (e) {}
}

module.exports = { up, down };
