/**
 * @file api/routes/homes/pid-tuning.js
 * @brief Advisory thermodynamic PID tuning endpoints for homes.
 * 
 * Provides endpoints to compute room PID tuning recommendations from transient responses,
 * apply suggested PID gains (Kp 0x6080, Ki 0x60a0, Kd 0x60c0) to zones,
 * and view historical tuning snapshots correlated with hydraulic balancing.
 */

'use strict';

const express = require('express');
const db = require('../../../lib/db');
const { getLogger } = require('../../../lib/logger');
const commandApi = require('../../../lib/command-api');
const { checkZoneConfigReadonly } = require('./helpers');
const { analyzePidTuning } = require('../../../lib/pid-analyzer');
const { prunePidTuningSnapshots } = require('../../../lib/snapshot-cleanup');

const router = express.Router();
const _log = getLogger('pid-tuning-api');

/**
 * GET /:homeId/pid-tuning/analysis
 * Run thermodynamic PID analyzer and return recommendations.
 */
router.get('/:homeId/pid-tuning/analysis', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const hours = req.query.hours ? parseInt(req.query.hours, 10) : 72;

        const analysis = await analyzePidTuning(homeId, { hours });

        if (!analysis.ok) {
            const statusCode = analysis.error === 'no_heating_zones' ? 404 : 400;
            return res.status(statusCode).json(analysis);
        }

        // Store snapshot in history
        const pool = db.getPool();
        let snapshotId = null;
        try {
            const hydId = analysis.hydraulicBaseline ? analysis.hydraulicBaseline.id : null;
            const [insertRes] = await pool.execute(
                'INSERT INTO pid_tuning_snapshots (home_id, hydraulic_snapshot_id, analysis_json, applied) VALUES (?, ?, ?, 0)',
                [homeId, hydId, JSON.stringify(analysis)]
            );
            snapshotId = insertRes.insertId;

            // Enforce max retention in DB and prune snapshots older than 3 days
            await prunePidTuningSnapshots(homeId, 5, 3);
        } catch (dbErr) {
            _log('warn', `Failed to save PID tuning snapshot for home ${homeId}: ${dbErr.message}`);
        }

        res.json({
            ...analysis,
            snapshotId
        });
    } catch (err) {
        _log('error', `Failed to run PID tuning analysis: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

/**
 * POST /:homeId/pid-tuning/apply
 * Apply suggested PID gains to zones and push config refresh to devices.
 */
router.post('/:homeId/pid-tuning/apply', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const { isReadOnly, devBypass } = await checkZoneConfigReadonly(homeId);
        if (isReadOnly && !devBypass) {
            return res.status(403).json({ error: 'config_readonly', message: 'Configuration is read-only' });
        }

        const { zones, snapshotId } = req.body;
        if (!Array.isArray(zones) || zones.length === 0) {
            return res.status(400).json({ error: 'invalid_body', message: 'zones array is required' });
        }

        const pool = db.getPool();
        const appliedZones = [];

        for (const item of zones) {
            const zoneId = item.zoneId || item.id;
            const kp = item.kp !== undefined ? parseFloat(item.kp) : undefined;
            const ki = item.ki !== undefined ? parseFloat(item.ki) : undefined;
            const kd = item.kd !== undefined ? parseFloat(item.kd) : undefined;

            if (!zoneId) continue;

            const configFields = {};
            if (kp !== undefined && !isNaN(kp)) configFields['0x6080'] = kp;
            if (ki !== undefined && !isNaN(ki)) configFields['0x60a0'] = ki;
            if (kd !== undefined && !isNaN(kd)) configFields['0x60c0'] = kd;

            if (Object.keys(configFields).length > 0) {
                await db.updateZoneConfig(homeId, zoneId, configFields);

                // Push config refresh to all devices in this zone
                const [devices] = await pool.execute(
                    'SELECT serial_no FROM devices WHERE zone_id = ? AND home_id = ?',
                    [zoneId, homeId]
                );
                for (const dev of devices) {
                    await commandApi.pushConfigRefresh(dev.serial_no).catch(err => {
                        _log('warn', `PID apply: config refresh failed for ${dev.serial_no}: ${err.message}`);
                    });
                }

                appliedZones.push({ zoneId, configFields });
            }
        }

        if (snapshotId) {
            await pool.execute(
                'UPDATE pid_tuning_snapshots SET applied = 1, applied_at = NOW() WHERE id = ? AND home_id = ?',
                [snapshotId, homeId]
            ).catch(err => {
                _log('warn', `Failed to mark PID snapshot ${snapshotId} as applied: ${err.message}`);
            });
        }

        res.json({
            ok: true,
            appliedCount: appliedZones.length,
            zones: appliedZones
        });
    } catch (err) {
        _log('error', `Failed to apply PID tuning suggestions: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

/**
 * GET /:homeId/pid-tuning/history
 * Retrieve recent PID tuning snapshots.
 */
router.get('/:homeId/pid-tuning/history', async (req, res) => {
    try {
        const homeId = req.params.homeId;
        const pool = db.getPool();

        const [rows] = await pool.execute(
            `SELECT id, home_id, hydraulic_snapshot_id, created_at, analysis_json, applied, applied_at 
             FROM pid_tuning_snapshots 
             WHERE home_id = ? 
             ORDER BY created_at DESC 
             LIMIT 10`,
            [homeId]
        );

        const snapshots = rows.map(r => {
            let parsed = null;
            try {
                parsed = typeof r.analysis_json === 'string' ? JSON.parse(r.analysis_json) : r.analysis_json;
            } catch (e) {
                parsed = null;
            }
            return {
                id: r.id,
                homeId: r.home_id,
                hydraulicSnapshotId: r.hydraulic_snapshot_id,
                createdAt: r.created_at,
                applied: Boolean(r.applied),
                appliedAt: r.applied_at,
                analysis: parsed
            };
        });

        res.json(snapshots);
    } catch (err) {
        _log('error', `Failed to fetch PID tuning history: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

module.exports = router;
