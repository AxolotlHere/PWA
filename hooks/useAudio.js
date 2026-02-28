/**
 * useAudio — Microphone RMS every 100ms
 * 
 * Uses expo-av Audio to:
 * - Record continuously
 * - Sample metering levels every 100ms
 * - Send RMS energy packets for acoustic surface classification
 */

import { useState, useEffect, useRef } from 'react';
import { Audio } from 'expo-av';

const METERING_INTERVAL_MS = 100;

export function useAudio({ onSample, enabled = false }) {
  const [hasPermission, setHasPermission] = useState(false);
  const [currentRMS, setCurrentRMS] = useState(0);

  const recordingRef = useRef(null);
  const meteringTimer = useRef(null);
  const sampleRate = useRef(44100);

  useEffect(() => {
    requestPermission();
    return () => cleanup();
  }, []);

  async function requestPermission() {
    const { status } = await Audio.requestPermissionsAsync();
    setHasPermission(status === 'granted');
  }

  useEffect(() => {
    if (enabled && hasPermission) {
      startRecording();
    } else {
      stopRecording();
    }

    return () => stopRecording();
  }, [enabled, hasPermission]);

  async function startRecording() {
    if (recordingRef.current) return;

    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });

      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync({
        android: {
          extension: '.m4a',
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 64000,
        },
        ios: {
          extension: '.m4a',
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.MEDIUM,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 64000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: {},
        isMeteringEnabled: true,  // Critical: enables dB level readings
      });

      await recording.startAsync();
      recordingRef.current = recording;

      // Poll metering every 100ms
      meteringTimer.current = setInterval(async () => {
        if (!recordingRef.current) return;

        try {
          const status = await recordingRef.current.getStatusAsync();
          if (!status.isRecording) return;

          // metering is in dBFS (0 = max, -160 = silence)
          const dbfs = status.metering || -160;

          // Convert dBFS to linear RMS (0-1 scale)
          const rms = Math.pow(10, dbfs / 20);
          setCurrentRMS(rms);

          if (onSample) {
            onSample({
              type: 'AUDIO',
              timestamp: Date.now(),
              rms: rms,
              dbfs: dbfs,
              sample_rate: sampleRate.current,
            });
          }
        } catch (e) {
          // Status fetch failed — skip
        }
      }, METERING_INTERVAL_MS);

    } catch (e) {
      console.error('[Audio] Failed to start recording:', e);
    }
  }

  async function stopRecording() {
    if (meteringTimer.current) {
      clearInterval(meteringTimer.current);
      meteringTimer.current = null;
    }

    if (recordingRef.current) {
      try {
        await recordingRef.current.stopAndUnloadAsync();
      } catch (e) {
        // Ignore stop errors
      }
      recordingRef.current = null;
    }

    setCurrentRMS(0);
  }

  async function cleanup() {
    await stopRecording();
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
    });
  }

  return {
    hasPermission,
    currentRMS,
    isActive: enabled && hasPermission && recordingRef.current !== null,
  };
}