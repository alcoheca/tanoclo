/**
 * @file test/test_schedule_profiles.test.js
 * @brief Vitest testing suite validating schedule profiles database helpers, HA discovery, and MQTT.
 */

'use strict';

const homeBuilders = require('../lib/ha-discovery/home-builders');

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
