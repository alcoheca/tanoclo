/**
 * @file lib/snapshot-cleanup.js
 * @brief Pruning and retention manager for hydraulic balancing and PID tuning snapshots.
 * 
 * Enforces maximum snapshot count per home and prunes snapshots older than a retention threshold
 * while preserving the active baseline snapshot.
 */

'use strict';

const db = require('./db');
const { getLogger } = require('./logger');
const log = getLogger('snapshot-cleanup');

/**
 * Prune historical balancing snapshots for a specific home.
 * 
 * @param {number|string} homeId - Home ID
 * @param {number|Object} [maxKeepOrOptions=5] - Maximum snapshots to retain per home, or options object { maxKeep, maxDays, pool }
 * @param {number} [maxDaysArg=3] - Maximum age in days before pruning
 */
async function pruneBalancingSnapshots(homeId, maxKeepOrOptions = 5, maxDaysArg = 3) {
    if (!homeId) return;
    try {
        const isOptions = typeof maxKeepOrOptions === 'object' && maxKeepOrOptions !== null;
        const maxKeep = isOptions ? (maxKeepOrOptions.maxKeep ?? 5) : maxKeepOrOptions;
        const maxDays = isOptions ? (maxKeepOrOptions.maxDays ?? 3) : maxDaysArg;
        const pool = (isOptions && maxKeepOrOptions.pool) ? maxKeepOrOptions.pool : db.getPool();

        // 1. Identify active baseline snapshot (do not delete)
        const [appliedRows] = await pool.execute(
            'SELECT id FROM balancing_snapshots WHERE home_id = ? AND applied = 1 ORDER BY applied_at DESC LIMIT 1',
            [homeId]
        );
        const latestAppliedId = appliedRows.length > 0 ? appliedRows[0].id : null;

        // 2. Fetch all snapshots for this home
        const [rows] = await pool.execute(
            'SELECT id, created_at FROM balancing_snapshots WHERE home_id = ? ORDER BY created_at DESC',
            [homeId]
        );

        if (!rows || rows.length === 0) return;

        const cutoffMs = Date.now() - maxDays * 24 * 60 * 60 * 1000;
        const idsToDelete = [];

        rows.forEach((row, index) => {
            if (row.id === latestAppliedId) return;

            const rowTime = new Date(row.created_at).getTime();
            const isOld = rowTime < cutoffMs;
            const isBeyondMax = index >= maxKeep;

            if (isOld || isBeyondMax) {
                idsToDelete.push(row.id);
            }
        });

        if (idsToDelete.length > 0) {
            const placeholders = idsToDelete.map(() => '?').join(',');
            await pool.execute(
                `DELETE FROM balancing_snapshots WHERE id IN (${placeholders})`,
                idsToDelete
            );
            log('debug', `Pruned ${idsToDelete.length} balancing snapshots for home ${homeId}`);
        }
    } catch (err) {
        log('warn', `Failed to prune balancing snapshots for home ${homeId}: ${err.message}`);
    }
}

/**
 * Prune historical thermodynamic PID tuning snapshots for a specific home.
 * 
 * @param {number|string} homeId - Home ID
 * @param {number|Object} [maxKeepOrOptions=5] - Maximum snapshots to retain per home, or options object { maxKeep, maxDays, pool }
 * @param {number} [maxDaysArg=3] - Maximum age in days before pruning
 */
async function prunePidTuningSnapshots(homeId, maxKeepOrOptions = 5, maxDaysArg = 3) {
    if (!homeId) return;
    try {
        const isOptions = typeof maxKeepOrOptions === 'object' && maxKeepOrOptions !== null;
        const maxKeep = isOptions ? (maxKeepOrOptions.maxKeep ?? 5) : maxKeepOrOptions;
        const maxDays = isOptions ? (maxKeepOrOptions.maxDays ?? 3) : maxDaysArg;
        const pool = (isOptions && maxKeepOrOptions.pool) ? maxKeepOrOptions.pool : db.getPool();

        // 1. Identify active applied PID snapshot (do not delete)
        const [appliedRows] = await pool.execute(
            'SELECT id FROM pid_tuning_snapshots WHERE home_id = ? AND applied = 1 ORDER BY applied_at DESC LIMIT 1',
            [homeId]
        );
        const latestAppliedId = appliedRows.length > 0 ? appliedRows[0].id : null;

        // 2. Fetch all snapshots for this home
        const [rows] = await pool.execute(
            'SELECT id, created_at FROM pid_tuning_snapshots WHERE home_id = ? ORDER BY created_at DESC',
            [homeId]
        );

        if (!rows || rows.length === 0) return;

        const cutoffMs = Date.now() - maxDays * 24 * 60 * 60 * 1000;
        const idsToDelete = [];

        rows.forEach((row, index) => {
            if (row.id === latestAppliedId) return;

            const rowTime = new Date(row.created_at).getTime();
            const isOld = rowTime < cutoffMs;
            const isBeyondMax = index >= maxKeep;

            if (isOld || isBeyondMax) {
                idsToDelete.push(row.id);
            }
        });

        if (idsToDelete.length > 0) {
            const placeholders = idsToDelete.map(() => '?').join(',');
            await pool.execute(
                `DELETE FROM pid_tuning_snapshots WHERE id IN (${placeholders})`,
                idsToDelete
            );
            log('debug', `Pruned ${idsToDelete.length} PID tuning snapshots for home ${homeId}`);
        }
    } catch (err) {
        log('warn', `Failed to prune PID tuning snapshots for home ${homeId}: ${err.message}`);
    }
}

/**
 * Prune snapshots across all homes (used by scheduled maintenance cron).
 * 
 * @param {number|Object} [maxKeepOrOptions=5]
 * @param {number} [maxDaysArg=3]
 */
async function pruneAllSnapshots(maxKeepOrOptions = 5, maxDaysArg = 3) {
    try {
        const isOptions = typeof maxKeepOrOptions === 'object' && maxKeepOrOptions !== null;
        const maxKeep = isOptions ? (maxKeepOrOptions.maxKeep ?? 5) : maxKeepOrOptions;
        const maxDays = isOptions ? (maxKeepOrOptions.maxDays ?? 3) : maxDaysArg;
        const pool = (isOptions && maxKeepOrOptions.pool) ? maxKeepOrOptions.pool : db.getPool();

        const [homes] = await pool.execute('SELECT id FROM homes');
        for (const h of homes) {
            await pruneBalancingSnapshots(h.id, { maxKeep, maxDays, pool });
            await prunePidTuningSnapshots(h.id, { maxKeep, maxDays, pool });
        }
    } catch (err) {
        log('warn', `Failed to prune all snapshots: ${err.message}`);
    }
}

module.exports = {
    pruneBalancingSnapshots,
    prunePidTuningSnapshots,
    pruneAllSnapshots
};
