/**
 * @file test/test_schedule_profiles.test.js
 * @brief Vitest testing suite validating schedule profiles database helpers, HA discovery, and MQTT.
 */

'use strict';

const { isDateInRange } = require('../lib/db-schedule-profiles');
const homeBuilders = require('../lib/ha-discovery/home-builders');

test('isDateInRange correctly evaluates calendar ranges', () => {
    // Normal in-year range (Autumn: 09-21 to 12-20)
    expect(isDateInRange('10-12', '09-21', '12-20')).toBe(true);
    expect(isDateInRange('09-21', '09-21', '12-20')).toBe(true);
    expect(isDateInRange('12-20', '09-21', '12-20')).toBe(true);
    expect(isDateInRange('09-20', '09-21', '12-20')).toBe(false);
    expect(isDateInRange('12-21', '09-21', '12-20')).toBe(false);
    expect(isDateInRange('01-15', '09-21', '12-20')).toBe(false);

    // Year-crossing range (Winter: 12-21 to 03-20)
    expect(isDateInRange('12-25', '12-21', '03-20')).toBe(true);
    expect(isDateInRange('01-05', '12-21', '03-20')).toBe(true);
    expect(isDateInRange('03-20', '12-21', '03-20')).toBe(true);
    expect(isDateInRange('12-21', '12-21', '03-20')).toBe(true);
    expect(isDateInRange('03-21', '12-21', '03-20')).toBe(false);
    expect(isDateInRange('08-15', '12-21', '03-20')).toBe(false);

    // Spring (03-21 to 06-20)
    expect(isDateInRange('04-01', '03-21', '06-20')).toBe(true);
    expect(isDateInRange('07-01', '03-21', '06-20')).toBe(false);
});

test('homeBuilders publishes schedule_profile select entity', () => {
    const published = [];
    const publishEntity = (component, entityId, payload) => {
        published.push({ component, entityId, payload });
    };

    const mockHomes = [
        { id: 123, name: 'My Home' }
    ];

    const profilesByHome = new Map();
    profilesByHome.set(123, ['Autumn', 'Winter', 'Spring', 'Holiday']);

    homeBuilders.buildHomeDiscovery(publishEntity, mockHomes, profilesByHome);

    const profileEntity = published.find(e => e.entityId === 'tanoclo_h123_schedule_profile');
    expect(profileEntity).toBeDefined();
    expect(profileEntity.component).toBe('select');
    expect(profileEntity.payload.name).toBe('Heating Schedule Profile');
    expect(profileEntity.payload.options).toEqual(['Autumn', 'Winter', 'Spring', 'Holiday']);
    expect(profileEntity.payload.state_topic).toBe('tado/tanoclo/h/123/schedule_profile');
    expect(profileEntity.payload.command_topic).toBe('tado/tanoclo/h/123/set/schedule_profile');

    const modeEntity = published.find(e => e.entityId === 'tanoclo_h123_schedule_profile_mode');
    expect(modeEntity).toBeUndefined();
});
