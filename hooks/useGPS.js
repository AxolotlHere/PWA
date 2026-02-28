/**
 * useGPS — High-accuracy location at ~1Hz
 * 
 * Provides:
 * - Live lat/lng/speed/heading
 * - Distance tracking
 * - Speed validity check (min 20 km/h for IRI)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import * as Location from 'expo-location';
import { computeDistanceMeters } from '../utils/iriEstimate';

const MIN_SPEED_KMH = 20;
const GPS_ACCURACY = Location.Accuracy.BestForNavigation;

export function useGPS({ onSample, enabled = false }) {
  const [hasPermission, setHasPermission] = useState(false);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [distanceM, setDistanceM] = useState(0);
  const [isSpeedValid, setIsSpeedValid] = useState(false);

  const watchRef = useRef(null);
  const coordHistory = useRef([]);
  const totalDistance = useRef(0);

  useEffect(() => {
    requestPermissions();
  }, []);

  async function requestPermissions() {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      setHasPermission(true);
    }
  }

  useEffect(() => {
    if (!hasPermission) return;

    if (enabled) {
      startTracking();
    } else {
      stopTracking();
    }

    return () => stopTracking();
  }, [enabled, hasPermission]);

  async function startTracking() {
    if (watchRef.current) return;

    coordHistory.current = [];
    totalDistance.current = 0;
    setDistanceM(0);

    watchRef.current = await Location.watchPositionAsync(
      {
        accuracy: GPS_ACCURACY,
        timeInterval: 1000,    // 1Hz
        distanceInterval: 0,   // Don't skip any updates
      },
      (location) => {
        const { latitude, longitude, speed, accuracy, heading, altitude } = location.coords;

        // speed is in m/s from expo-location
        const speedMs = speed || 0;
        const speedKmh = speedMs * 3.6;
        const valid = speedKmh >= MIN_SPEED_KMH;

        // Track distance
        const newCoord = { lat: latitude, lng: longitude };
        if (coordHistory.current.length > 0) {
          const last = coordHistory.current[coordHistory.current.length - 1];
          const delta = computeDistanceMeters([last, newCoord]);
          totalDistance.current += delta;
          setDistanceM(totalDistance.current);
        }

        coordHistory.current.push(newCoord);
        if (coordHistory.current.length > 120) {
          // Keep last 2 minutes of coords
          coordHistory.current.shift();
        }

        const locationData = {
          lat: latitude,
          lng: longitude,
          speed_ms: speedMs,
          speed_kmh: speedKmh,
          accuracy_m: accuracy,
          heading: heading || 0,
          altitude: altitude || 0,
          distance_m: totalDistance.current,
        };

        setCurrentLocation(locationData);
        setIsSpeedValid(valid);

        if (onSample) {
          onSample({
            type: 'GPS',
            timestamp: Date.now(),
            ...locationData,
          });
        }
      }
    );
  }

  function stopTracking() {
    if (watchRef.current) {
      watchRef.current.remove();
      watchRef.current = null;
    }
    setIsSpeedValid(false);
  }

  function resetDistance() {
    totalDistance.current = 0;
    coordHistory.current = [];
    setDistanceM(0);
  }

  return {
    hasPermission,
    currentLocation,
    distanceM,
    isSpeedValid,
    isActive: enabled && hasPermission && watchRef.current !== null,
    resetDistance,
  };
}
