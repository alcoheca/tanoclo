/**
 * @file src/api/scheduleProfiles.js
 * @brief Handles API requests for seasonal heating schedule profiles.
 */

import { apiFetch } from './client';

/**
 * Fetch all schedule profiles for a home.
 * @param {string|number} homeId
 */
export function getScheduleProfiles(homeId) {
  return apiFetch(`/api/v2/homes/${homeId}/scheduleProfiles`);
}

/**
 * Fetch details for a specific schedule profile including zone blocks.
 * @param {string|number} homeId
 * @param {string|number} profileId
 */
export function getScheduleProfileDetails(homeId, profileId) {
  return apiFetch(`/api/v2/homes/${homeId}/scheduleProfiles/${profileId}`);
}

/**
 * Activate a schedule profile across all zones in the home.
 * @param {string|number} homeId
 * @param {string|number} profileId
 */
export function activateScheduleProfile(homeId, profileId) {
  return apiFetch(`/api/v2/homes/${homeId}/scheduleProfiles/${profileId}/activate`, {
    method: 'POST'
  });
}

/**
 * Create a new schedule profile.
 * @param {string|number} homeId
 * @param {Object} data
 */
export function createScheduleProfile(homeId, data) {
  return apiFetch(`/api/v2/homes/${homeId}/scheduleProfiles`, {
    method: 'POST',
    body: data
  });
}

/**
 * Update metadata of an existing schedule profile.
 * @param {string|number} homeId
 * @param {string|number} profileId
 * @param {Object} data
 */
export function updateScheduleProfile(homeId, profileId, data) {
  return apiFetch(`/api/v2/homes/${homeId}/scheduleProfiles/${profileId}`, {
    method: 'PUT',
    body: data
  });
}

/**
 * Delete a schedule profile.
 * @param {string|number} homeId
 * @param {string|number} profileId
 */
export function deleteScheduleProfile(homeId, profileId) {
  return apiFetch(`/api/v2/homes/${homeId}/scheduleProfiles/${profileId}`, {
    method: 'DELETE'
  });
}

/**
 * Capture current active schedules of all zones into a profile.
 * @param {string|number} homeId
 * @param {string|number} profileId
 */
export function captureScheduleProfile(homeId, profileId) {
  return apiFetch(`/api/v2/homes/${homeId}/scheduleProfiles/${profileId}/capture`, {
    method: 'POST'
  });
}

/**
 * Save schedule blocks for a specific zone inside a profile.
 * @param {string|number} homeId
 * @param {string|number} profileId
 * @param {string|number} zoneId
 * @param {string} timetableType
 * @param {Array} blocks
 */
export function saveProfileZoneBlocks(homeId, profileId, zoneId, timetableType, blocks) {
  return apiFetch(`/api/v2/homes/${homeId}/scheduleProfiles/${profileId}/zones/${zoneId}/blocks`, {
    method: 'PUT',
    body: { timetableType, blocks }
  });
}
