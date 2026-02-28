/**
 * useIMU — Accelerometer + Gyroscope at 200Hz
 * 
 * Returns live IMU data and starts/stops sensor subscriptions.
 * Handles iOS permission request automatically.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import { Platform } from 'react-native';

const TARGET_INTERVAL_MS = 5; // 200Hz = 1000ms / 200 = 5ms

export function useIMU({ onSample, enabled = false }) {
  const [isAvailable, setIsAvailable] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [sampleRate, setSampleRate] = useState(0); // actual measured Hz

  const accelSub = useRef(null);
  const gyroSub = useRef(null);
  const latestGyro = useRef({ rx: 0, ry: 0, rz: 0 });
  const sampleCount = useRef(0);
  const rateTimer = useRef(null);

  // Check availability & permissions
  useEffect(() => {
    async function checkSensors() {
      const accelAvail = await Accelerometer.isAvailableAsync();
      const gyroAvail = await Gyroscope.isAvailableAsync();
      setIsAvailable(accelAvail);

      // iOS requires explicit permission for motion data in some contexts
      if (Platform.OS === 'ios') {
        // expo-sensors handles this internally via app.json NSMotionUsageDescription
        setHasPermission(true);
      } else {
        setHasPermission(true);
      }
    }
    checkSensors();
  }, []);

  // Start/stop based on enabled flag
  useEffect(() => {
    if (!isAvailable || !hasPermission) return;

    if (enabled) {
      startSensors();
    } else {
      stopSensors();
    }

    return () => stopSensors();
  }, [enabled, isAvailable, hasPermission]);

  function startSensors() {
    // Set update interval
    Accelerometer.setUpdateInterval(TARGET_INTERVAL_MS);
    Gyroscope.setUpdateInterval(TARGET_INTERVAL_MS);

    // Gyro subscription — store latest values for fusion with accel
    gyroSub.current = Gyroscope.addListener((data) => {
      latestGyro.current = {
        rx: data.x,
        ry: data.y,
        rz: data.z,
      };
    });

    // Accelerometer subscription — primary sensor, triggers packet
    accelSub.current = Accelerometer.addListener((data) => {
      sampleCount.current++;

      if (onSample) {
        onSample({
          type: 'IMU',
          timestamp: Date.now(),
          ax: data.x * 9.81,  // Convert g to m/s²
          ay: data.y * 9.81,
          az: data.z * 9.81,
          ...latestGyro.current,
        });
      }
    });

    // Measure actual sample rate every second
    rateTimer.current = setInterval(() => {
      setSampleRate(sampleCount.current);
      sampleCount.current = 0;
    }, 1000);
  }

  function stopSensors() {
    if (accelSub.current) {
      accelSub.current.remove();
      accelSub.current = null;
    }
    if (gyroSub.current) {
      gyroSub.current.remove();
      gyroSub.current = null;
    }
    if (rateTimer.current) {
      clearInterval(rateTimer.current);
      rateTimer.current = null;
    }
    setSampleRate(0);
  }

  return {
    isAvailable,
    hasPermission,
    sampleRate,
    isActive: enabled && isAvailable && hasPermission,
  };
}
