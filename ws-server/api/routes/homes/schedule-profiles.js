/**
 * @file api/routes/homes/schedule-profiles.js
 * @brief Heating schedule profiles endpoints for homes.
 */

'use strict';

const express = require('express');
const dbScheduleProfiles = require('../../../lib/db-schedule-profiles');
const { getLogger } = require('../../../lib/logger');
const { checkZoneConfigReadonly } = require('./helpers');

const router = express.Router();
const _log = getLogger('homes-schedule-profiles');

// GET /api/v2/homes/:homeId/scheduleProfiles
router.get('/:homeId/scheduleProfiles', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const data = await dbScheduleProfiles.getScheduleProfiles(homeId);
        res.json(data);
    } catch (err) {
        _log('error', `Failed to get schedule profiles: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// GET /api/v2/homes/:homeId/scheduleProfiles/:profileId
router.get('/:homeId/scheduleProfiles/:profileId', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const profileId = parseInt(req.params.profileId, 10);
        const profile = await dbScheduleProfiles.getScheduleProfileDetails(homeId, profileId);
        if (!profile) {
            return res.status(404).json({ error: 'profile_not_found' });
        }
        res.json(profile);
    } catch (err) {
        _log('error', `Failed to get schedule profile details: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// POST /api/v2/homes/:homeId/scheduleProfiles
router.post('/:homeId/scheduleProfiles', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        if (await checkZoneConfigReadonly(homeId, res)) return;

        const { name, icon, description, autoStartDate, copyFromProfileId } = req.body;
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'invalid_name' });
        }

        const profile = await dbScheduleProfiles.createScheduleProfile(homeId, {
            name,
            icon,
            description,
            autoStartDate,
            copyFromProfileId: copyFromProfileId ? parseInt(copyFromProfileId, 10) : null
        });

        res.status(201).json(profile);
    } catch (err) {
        _log('error', `Failed to create schedule profile: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// PUT /api/v2/homes/:homeId/scheduleProfiles/:profileId
router.put('/:homeId/scheduleProfiles/:profileId', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const profileId = parseInt(req.params.profileId, 10);
        if (await checkZoneConfigReadonly(homeId, res)) return;

        const { name, icon, description, autoStartDate, orderIndex } = req.body;
        await dbScheduleProfiles.updateScheduleProfile(homeId, profileId, {
            name,
            icon,
            description,
            autoStartDate,
            orderIndex
        });

        const updated = await dbScheduleProfiles.getScheduleProfileDetails(homeId, profileId);
        res.json(updated);
    } catch (err) {
        _log('error', `Failed to update schedule profile: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// DELETE /api/v2/homes/:homeId/scheduleProfiles/:profileId
router.delete('/:homeId/scheduleProfiles/:profileId', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const profileId = parseInt(req.params.profileId, 10);
        if (await checkZoneConfigReadonly(homeId, res)) return;

        await dbScheduleProfiles.deleteScheduleProfile(homeId, profileId);
        res.json({ success: true, deletedProfileId: profileId });
    } catch (err) {
        _log('error', `Failed to delete schedule profile: ${err.message}`);
        res.status(400).json({ error: 'delete_failed', message: err.message });
    }
});

// POST /api/v2/homes/:homeId/scheduleProfiles/:profileId/activate
router.post('/:homeId/scheduleProfiles/:profileId/activate', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const profileId = parseInt(req.params.profileId, 10);
        if (await checkZoneConfigReadonly(homeId, res)) return;

        const result = await dbScheduleProfiles.activateScheduleProfile(homeId, profileId);
        res.json(result);
    } catch (err) {
        _log('error', `Failed to activate schedule profile: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// POST /api/v2/homes/:homeId/scheduleProfiles/:profileId/capture
router.post('/:homeId/scheduleProfiles/:profileId/capture', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const profileId = parseInt(req.params.profileId, 10);
        if (await checkZoneConfigReadonly(homeId, res)) return;

        await dbScheduleProfiles.captureCurrentSchedulesToProfile(homeId, profileId);
        const updated = await dbScheduleProfiles.getScheduleProfileDetails(homeId, profileId);
        res.json(updated);
    } catch (err) {
        _log('error', `Failed to capture current schedule to profile: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// PUT /api/v2/homes/:homeId/scheduleProfiles/:profileId/zones/:zoneId/blocks
router.put('/:homeId/scheduleProfiles/:profileId/zones/:zoneId/blocks', async (req, res) => {
    try {
        const homeId = parseInt(req.params.homeId, 10);
        const profileId = parseInt(req.params.profileId, 10);
        const zoneId = parseInt(req.params.zoneId, 10);
        if (await checkZoneConfigReadonly(homeId, res)) return;

        const { timetableType, blocks } = req.body;
        if (!Array.isArray(blocks)) {
            return res.status(400).json({ error: 'invalid_blocks' });
        }

        await dbScheduleProfiles.saveProfileZoneBlocks(homeId, profileId, zoneId, timetableType, blocks);
        res.json({ success: true });
    } catch (err) {
        _log('error', `Failed to save profile zone blocks: ${err.message}`);
        res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

module.exports = router;
