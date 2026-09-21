/**
 * @file src/hooks/useSSE.js
 * @brief Custom hook managing a real-time Server-Sent Events (SSE) stream client.
 * 
 * Multiplexes SSE across multiple browser tabs using a BroadcastChannel tab-leader election.
 * Exactly ONE tab (the leader) maintains the persistent EventSource connection to the server,
 * broadcasting incoming events to all other open tabs (followers). This prevents hitting browser
 * HTTP/1.1 per-host connection limits (max 6 connections) and socket queue deadlock.
 * 
 * Includes exponential backoff reconnection policy, heartbeat watchdog, automatic failover
 * if the leader tab closes, and automatic recovery on network/visibility changes.
 */

import { useState, useEffect, useRef } from 'react';
import { useSWRConfig } from 'swr';
import { STORAGE_KEYS, getApiBase } from '../utils/constants';
import { apiFetch } from '../api/client';
import logger from '../utils/logger';
import { SWR_KEYS } from '../utils/swrKeys';

/**
 * @brief Custom hook to establish real-time SSE event updates for an active Home.
 * @param {string|number} homeId - Active home identifier.
 * @returns {{ isConnected: boolean, lastEventAt: number | null }}
 */
export function useSSE(homeId) {
  const { mutate } = useSWRConfig();
  const mutateRef = useRef(mutate);
  useEffect(() => {
    mutateRef.current = mutate;
  }, [mutate]);

  const [isConnected, setIsConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState(null);
  const esRef = useRef(null);
  const lastHeartbeatRef = useRef(null);

  useEffect(() => {
    if (!homeId) {
      setIsConnected(false);
      return;
    }

    lastHeartbeatRef.current = Date.now();
    const apiBase = getApiBase();
    const base = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;

    let active = true;
    let es = null;
    let isLeader = false;
    let isConnecting = false;
    let reconnectDelay = 2000;
    let reconnectTimer = null;
    let watchdogTimer = null;
    let heartbeatTimer = null;
    let electionTimer = null;
    let lastLeaderSeen = 0;

    const myTabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const channelName = `tanoclo_sse_home_${homeId}`;
    const hasBroadcastChannel = typeof globalThis.BroadcastChannel !== 'undefined';
    const channel = hasBroadcastChannel ? new globalThis.BroadcastChannel(channelName) : null;

    function markActivity() {
      lastHeartbeatRef.current = Date.now();
      setLastEventAt(Date.now());
    }

    /**
     * Dispatches and maps server-pushed updates directly to local cache mutations using SWR.
     */
    function handleSSEEvent(name, rawData) {
      markActivity();
      let parsed = null;
      if (rawData) {
        try { parsed = JSON.parse(rawData); } catch (_err) { /* expected */ }
      }

      switch (name) {
        case 'connected':
          setIsConnected(true);
          reconnectDelay = 2000;
          if (mutateRef.current) {
            mutateRef.current(SWR_KEYS.zoneStates(homeId));
            mutateRef.current(SWR_KEYS.homeState(homeId));
            mutateRef.current(SWR_KEYS.zones(homeId));
          }
          break;
        case 'zone-state':
          if (mutateRef.current) {
            mutateRef.current(SWR_KEYS.zoneStates(homeId));
            if (parsed && parsed.zoneId != null) {
              mutateRef.current(SWR_KEYS.zoneState(homeId, parsed.zoneId));
            }
          }
          break;
        case 'zone-config':
          if (mutateRef.current) {
            mutateRef.current(SWR_KEYS.zones(homeId));
            mutateRef.current(SWR_KEYS.zoneStates(homeId));
            if (parsed && parsed.zoneId != null) {
              mutateRef.current(SWR_KEYS.zoneState(homeId, parsed.zoneId));
            }
          }
          break;
        case 'device-state':
          if (mutateRef.current) {
            mutateRef.current(SWR_KEYS.devices(homeId));
            mutateRef.current(SWR_KEYS.zoneStates(homeId));
            mutateRef.current(SWR_KEYS.batteryDevices(homeId));
            mutateRef.current(SWR_KEYS.batteryDevicesRaw(homeId));
            if (parsed && parsed.deviceId) {
              mutateRef.current(SWR_KEYS.deviceDetails(homeId, parsed.deviceId));
              mutateRef.current(SWR_KEYS.deviceRaw(homeId, parsed.deviceId));
            }
          }
          break;
        case 'device-debug-response':
          if (parsed && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('device-debug-response', { detail: parsed }));
          }
          break;
        case 'home-state':
          if (mutateRef.current) {
            mutateRef.current(SWR_KEYS.homeState(homeId));
            mutateRef.current(SWR_KEYS.zoneStates(homeId));
          }
          break;
        case 'ping':
        case 'heartbeat':
          // markActivity already updated
          break;
        default:
          break;
      }
    }

    function broadcast(msg) {
      if (channel) {
        try {
          channel.postMessage(msg);
        } catch (_err) { /* ignore */ }
      }
    }

    function scheduleReconnect(immediate = false) {
      if (!active || !isLeader || isConnecting) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setIsConnected(false);

      if (immediate) {
        reconnectDelay = 2000;
        connectSSE();
        return;
      }

      const jitter = Math.floor(Math.random() * 1000);
      const delay = Math.min(reconnectDelay, 30000) + jitter;
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);

      logger.debug(`Scheduling SSE reconnect in ${delay}ms`);
      reconnectTimer = setTimeout(() => {
        if (active && isLeader) {
          connectSSE();
        }
      }, delay);
    }

    /**
     * Establishes the real EventSource connection (leader tab only).
     */
    async function connectSSE() {
      if (!active || !isLeader || isConnecting) return;
      isConnecting = true;

      const token = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
      if (!token) {
        isConnecting = false;
        setIsConnected(false);
        return;
      }

      if (es) {
        try { es.close(); } catch (_e) { /* expected */ }
        es = null;
      }
      esRef.current = null;

      try {
        const { ticket } = await apiFetch(`/api/homes/${homeId}/events/ticket`, {
          method: 'POST'
        });

        if (!active || !isLeader) {
          isConnecting = false;
          return;
        }

        const sseUrl = `${base}/api/homes/${homeId}/events?ticket=${ticket}`;
        logger.info(`[SSE Leader ${myTabId}] Connecting to SSE stream for home ${homeId} via ticket...`);

        es = new EventSource(sseUrl);
        esRef.current = es;
        isConnecting = false;

        const eventNames = [
          'connected', 'zone-state', 'zone-config', 'device-state',
          'device-debug-response', 'home-state', 'ping', 'heartbeat'
        ];

        for (const evName of eventNames) {
          es.addEventListener(evName, (e) => {
            handleSSEEvent(evName, e.data);
            broadcast({ type: 'sse-event', name: evName, data: e.data });
          });
        }

        es.onmessage = (e) => {
          markActivity();
          broadcast({ type: 'sse-event', name: 'message', data: e.data });
        };

        es.onerror = (err) => {
          logger.error('SSE Error, reconnecting:', err);
          if (es) {
            try { es.close(); } catch (_e) { /* expected */ }
            es = null;
          }
          esRef.current = null;
          scheduleReconnect(false);
        };
      } catch (err) {
        logger.error('Failed to establish SSE connection:', err);
        isConnecting = false;
        if (es) {
          try { es.close(); } catch (_e) { /* expected */ }
          es = null;
        }
        esRef.current = null;
        scheduleReconnect(false);
      }
    }

    function becomeLeader() {
      if (isLeader || !active) return;
      isLeader = true;
      logger.info(`[SSE] Tab ${myTabId} elected as SSE leader for home ${homeId}`);
      broadcast({ type: 'heartbeat', leaderId: myTabId, isConnected: false });
      connectSSE();
    }

    function stepDown() {
      if (!isLeader) return;
      isLeader = false;
      logger.info(`[SSE] Tab ${myTabId} stepped down as leader for home ${homeId}`);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (es) {
        try { es.close(); } catch (_e) { /* expected */ }
        es = null;
      }
      esRef.current = null;
    }

    // BroadcastChannel message router (multi-tab sync)
    if (channel) {
      channel.onmessage = (event) => {
        if (!active || !event.data) return;
        const msg = event.data;

        if (msg.type === 'heartbeat') {
          lastLeaderSeen = Date.now();
          if (isLeader && msg.leaderId !== myTabId) {
            // Split-brain resolution: lowest alphanumeric ID wins
            if (msg.leaderId < myTabId) {
              stepDown();
            }
          }
          if (!isLeader) {
            setIsConnected(!!msg.isConnected);
            setLastEventAt(Date.now());
          }
        } else if (msg.type === 'sse-event') {
          if (!isLeader) {
            handleSSEEvent(msg.name, msg.data);
          }
        } else if (msg.type === 'leader-resigned') {
          lastLeaderSeen = 0;
          const jitter = Math.floor(Math.random() * 250);
          setTimeout(() => {
            if (active && !isLeader && (Date.now() - lastLeaderSeen > 500)) {
              becomeLeader();
            }
          }, jitter);
        }
      };
    }

    // Periodic leader election check: if no leader heartbeat heard for > 3500ms, claim leadership
    if (hasBroadcastChannel) {
      electionTimer = setInterval(() => {
        if (!active) return;
        const elapsed = Date.now() - lastLeaderSeen;
        if (!isLeader && elapsed > 3500) {
          becomeLeader();
        }
      }, 1500);

      // Leader heartbeat broadcast every 2000ms
      heartbeatTimer = setInterval(() => {
        if (!active) return;
        if (isLeader) {
          broadcast({ type: 'heartbeat', leaderId: myTabId, isConnected: !!esRef.current });
        }
      }, 2000);

      // Initial election: claim after 300ms if no other leader announces itself
      setTimeout(() => {
        if (active && !isLeader && lastLeaderSeen === 0) {
          becomeLeader();
        }
      }, 300);
    } else {
      // Fallback for environments without BroadcastChannel
      becomeLeader();
    }

    // Watchdog: detect silent dead TCP sockets on the leader
    watchdogTimer = setInterval(() => {
      if (!active || !isLeader) return;
      const elapsed = Date.now() - (lastHeartbeatRef.current || Date.now());
      if (esRef.current && elapsed > 60000) {
        logger.warn(`SSE watchdog: no heartbeat for ${Math.round(elapsed / 1000)}s. Reconnecting.`);
        if (esRef.current) {
          try { esRef.current.close(); } catch (_e) { /* expected */ }
          esRef.current = null;
        }
        scheduleReconnect(true);
      }
    }, 15000);

    const handleOnline = () => {
      if (active && isLeader) {
        logger.info('Network online event detected — forcing SSE reconnect');
        scheduleReconnect(true);
      }
    };
    window.addEventListener('online', handleOnline);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && active) {
        if (isLeader) {
          const elapsed = Date.now() - (lastHeartbeatRef.current || Date.now());
          if (!esRef.current || elapsed > 40000) {
            logger.info('Tab visible and leader SSE needs refresh — reconnecting');
            scheduleReconnect(true);
          }
        } else if (Date.now() - lastLeaderSeen > 3500) {
          becomeLeader();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const handleBeforeUnload = () => {
      if (isLeader) {
        broadcast({ type: 'leader-resigned', leaderId: myTabId });
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      active = false;
      logger.info(`Disconnecting SSE hook for home ${homeId} (tab ${myTabId})`);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibility);

      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (electionTimer) clearInterval(electionTimer);

      if (isLeader) {
        broadcast({ type: 'leader-resigned', leaderId: myTabId });
      }

      if (es) {
        try { es.close(); } catch (_e) { /* expected */ }
      }
      esRef.current = null;

      if (channel) {
        try { channel.close(); } catch (_err) { /* ignore */ }
      }

      setIsConnected(false);
    };
  }, [homeId]);

  return { isConnected, lastEventAt };
}