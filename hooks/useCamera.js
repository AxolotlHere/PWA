/**
 * useCamera — Rear camera frame capture at 2fps
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Camera } from 'expo-camera'; // FIX: used only for permissions

const FRAME_INTERVAL_MS = 500;
const FRAME_QUALITY = 0.7;

export function useCamera({ onFrame, enabled = false }) {
  const [hasPermission, setHasPermission] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const cameraRef = useRef(null);
  const frameTimer = useRef(null);
  const isCaptureActive = useRef(false);

  useEffect(() => {
    requestPermission();
  }, []);

  async function requestPermission() {
    // FIX: use Camera.requestCameraPermissionsAsync which works for both old and new expo-camera
    const { status } = await Camera.requestCameraPermissionsAsync();
    setHasPermission(status === 'granted');
  }

  useEffect(() => {
    if (enabled && isReady && hasPermission) {
      startCapture();
    } else {
      stopCapture();
    }
    return () => stopCapture();
  }, [enabled, isReady, hasPermission]);

  function startCapture() {
    if (frameTimer.current) return;
    isCaptureActive.current = true;

    frameTimer.current = setInterval(async () => {
      if (!isCaptureActive.current || !cameraRef.current) return;

      try {
        const photo = await cameraRef.current.takePictureAsync({
          quality: FRAME_QUALITY,
          base64: true,
          skipProcessing: true,
          exif: false,
          width: 640,
        });

        if (photo && photo.base64 && onFrame) {
          onFrame({
            type: 'FRAME',
            timestamp: Date.now(),
            data: photo.base64,
            width: photo.width,
            height: photo.height,
          });
        }
      } catch (e) {
        if (__DEV__) console.warn('[Camera] Frame capture failed:', e.message);
      }
    }, FRAME_INTERVAL_MS);
  }

  function stopCapture() {
    isCaptureActive.current = false;
    if (frameTimer.current) {
      clearInterval(frameTimer.current);
      frameTimer.current = null;
    }
  }

  const handleCameraReady = useCallback(() => {
    setIsReady(true);
  }, []);

  return {
    hasPermission,
    isReady,
    cameraRef,
    handleCameraReady,
    isActive: enabled && isReady && hasPermission,
  };
}
