/**
 * @file lib/overlay-codes.js
 * @brief Single definition of the zone overlay mode codes and the labels shown in Home Assistant.
 *
 * The overlay mode is the TLV field 0x6240 sent to and received from valves and stored in
 * zone_measurements.field_6240:
 *
 *   0 = no overlay (following the schedule)
 *   1 = heating switched OFF (overlay with no setpoint)
 *   2 = manual overlay (until cancelled)
 *   3 = timed overlay (timer, or until the next schedule block)
 *
 * The kind of timed overlay (timer vs next block) is not part of the code: it lives in
 * zone_overlays.termination_type, so anything that needs to tell them apart must look there.
 */

'use strict';

const OVERLAY_MODE = Object.freeze({ SCHEDULE: 0, OFF: 1, MANUAL: 2, TIMED: 3 });

// Home Assistant preset names (shown as-is in the climate card). "no overlay" is HA's built-in "none".
const PRESET_NONE = 'none';
const PRESET = Object.freeze({
    TIMER: 'For a set time',
    NEXT_BLOCK: 'Until next schedule change',
    MANUAL: 'Until cancelled',
});
const PRESET_MODES = Object.freeze([PRESET.TIMER, PRESET.NEXT_BLOCK, PRESET.MANUAL]);

const NEXT_BLOCK_TYPES = new Set(['NEXT_TIME_BLOCK', 'NEXT_BLOCK', 'TADO_MODE']);

/**
 * Overlay mode code for an overlay about to be applied.
 * Hot water zones keep a termination-based code even when switched off.
 */
function overlayModeFor({ power = 'ON', terminationType = 'MANUAL', isHotWater = false } = {}) {
    if (String(power).toUpperCase() !== 'ON' && !isHotWater) return OVERLAY_MODE.OFF;
    return (terminationType === 'TIMER' || terminationType === 'NEXT_TIME_BLOCK')
        ? OVERLAY_MODE.TIMED
        : OVERLAY_MODE.MANUAL;
}

/** Home Assistant preset label for a stored overlay termination type. */
function presetForTermination(terminationType) {
    const t = String(terminationType || 'MANUAL').toUpperCase();
    if (t === 'TIMER') return PRESET.TIMER;
    if (NEXT_BLOCK_TYPES.has(t)) return PRESET.NEXT_BLOCK;
    return PRESET.MANUAL;
}

/**
 * Parse a preset sent by Home Assistant. Accepts the current labels and the legacy names.
 * @returns {'SCHEDULE'|'TIMER'|'NEXT_BLOCK'|'MANUAL'|null}
 */
function parsePresetCommand(payload) {
    const raw = String(payload ?? '').trim();
    const norm = raw.toLowerCase();
    if (norm === PRESET_NONE || norm === 'schedule' || norm === 'auto') return 'SCHEDULE';
    if (norm === PRESET.TIMER.toLowerCase() || norm === 'timer') return 'TIMER';
    if (norm === PRESET.NEXT_BLOCK.toLowerCase() || NEXT_BLOCK_TYPES.has(raw.toUpperCase())) return 'NEXT_BLOCK';
    if (norm === PRESET.MANUAL.toLowerCase() || norm === 'manual') return 'MANUAL';
    return null;
}

/**
 * What Home Assistant should show for a zone.
 *  hvacMode: 'auto' (following schedule) | 'heat' (overlay, power on) | 'off' (overlay with power off, or zone disabled)
 *  preset:   label of the overlay type, or PRESET_NONE when following the schedule
 *
 * @param {number} overlayCode  field_6240 from the latest zone measurement
 * @param {object|null} overlay row from zone_overlays (null if none)
 * @param {number} zoneEnabled  field_61e0 (0 = zone disabled)
 */
function describeOverlay({ overlayCode, overlay = null, zoneEnabled = 1 } = {}) {
    const code = Number(overlayCode);
    const active = Number.isFinite(code) && code > 0;

    let hvacMode = 'auto';
    if (Number(zoneEnabled) === 0) {
        hvacMode = 'off';
    } else if (active) {
        const powerOff = overlay ? overlay.setting_power === 'OFF' : code === OVERLAY_MODE.OFF;
        hvacMode = powerOff ? 'off' : 'heat';
    }

    let preset = PRESET_NONE;
    if (active) {
        // Without the row, a timed code cannot say which kind it is; treat it as next-block like state-restore does.
        const fallbackType = code === OVERLAY_MODE.TIMED ? 'NEXT_TIME_BLOCK' : 'MANUAL';
        preset = presetForTermination(overlay ? overlay.termination_type : fallbackType);
    }
    return { hvacMode, preset };
}

module.exports = {
    OVERLAY_MODE,
    PRESET,
    PRESET_MODES,
    PRESET_NONE,
    overlayModeFor,
    presetForTermination,
    parsePresetCommand,
    describeOverlay,
};
