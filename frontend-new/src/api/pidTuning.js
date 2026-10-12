/**
 * @file src/api/pidTuning.js
 * @brief Handles client-side API requests for thermodynamic PID tuning features.
 */

import { apiFetch } from './client';

/**
 * Runs thermodynamic PID tuning analysis for a home
 * @param {string|number} homeId
 * @param {number} [hours=72]
 */
export function getPidTuningAnalysis(homeId, hours = 72) {
  return apiFetch(`/api/v2/homes/${homeId}/pid-tuning/analysis?hours=${hours}`);
}

/**
 * Batch applies suggested PID gains to zones
 * @param {string|number} homeId
 * @param {Array<{ zoneId: number, kp: number, ki: number, kd: number }>} zones
 * @param {number|null} [snapshotId]
 */
export function applyPidTuningSuggestions(homeId, zones, snapshotId = null) {
  return apiFetch(`/api/v2/homes/${homeId}/pid-tuning/apply`, {
    method: 'POST',
    body: { zones, snapshotId }
  });
}

/**
 * Retrieves historical PID tuning snapshots for a home
 * @param {string|number} homeId
 */
export function getPidTuningHistory(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/pid-tuning/history`);
}
