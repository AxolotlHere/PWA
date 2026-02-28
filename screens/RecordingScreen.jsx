/**
 * RecordingScreen — Main recording interface
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
  SafeAreaView, StatusBar, Dimensions, ScrollView,
} from 'react-native';
import { CameraView } from 'expo-camera';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useNavigation, useRoute } from '@react-navigation/native';
import NetInfo from '@react-native-community/netinfo';

import { useIMU } from '../hooks/useIMU';
import { useGPS } from '../hooks/useGPS';
import { useCamera } from '../hooks/useCamera';
import { useAudio } from '../hooks/useAudio';

import SensorStatusBar from '../components/SensorStatusBar';
import AccelWaveform from '../components/AccelWaveform';
import IRIGauge from '../components/IRIGauge';
import SegmentHistory from '../components/SegmentHistory';

import wsClient from '../services/WebSocketClient';
import { saveSegment, createSession, finalizeSession } from '../services/OfflineBuffer';
import { pushSample, computeRollingIRI, resetIRIEstimator } from '../utils/iriEstimate';
import { COLORS, SPACING, RADIUS } from '../utils/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SESSION_ID_PREFIX = 'pulse_';

export default function RecordingScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { sessionName, serverHost, cameraHeightM, segmentLengthM } = route.params;

  // ─── Core State ────────────────────────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const sessionStartTime = useRef(null);
  const elapsedTimer = useRef(null);

  // ─── Display State (throttled — updated at 10fps max) ──────────────────────
  const [accelZ, setAccelZ] = useState(0);
  const [currentIRI, setCurrentIRI] = useState(null);
  const [isSpeedValid, setIsSpeedValid] = useState(false);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [distanceM, setDistanceM] = useState(0);
  const [gpsCoords, setGpsCoords] = useState(null);
  const [audioRMS, setAudioRMS] = useState(0);
  const [currentSegmentDistance, setCurrentSegmentDistance] = useState(0);

  // ─── Raw Value Refs (high-frequency, no re-render) ─────────────────────────
  const accelZRef = useRef(0);
  const audioRMSRef = useRef(0);
  const speedKmhRef = useRef(0);
  const distanceMRef = useRef(0);
  const isSpeedValidRef = useRef(false);
  const gpsCoordsRef = useRef(null);
  const currentSegmentDistanceRef = useRef(0);
  const currentIRIRef = useRef(null);

  // ─── Session Refs ──────────────────────────────────────────────────────────
  const [completedSegments, setCompletedSegments] = useState([]);
  const completedSegmentsRef = useRef([]);
  const segmentStartDistanceRef = useRef(0);
  const segmentIndexRef = useRef(0);

  const [wsStatus, setWsStatus] = useState('off');
  const [queueSize, setQueueSize] = useState(0);

  const iriUpdateTimer = useRef(null);
  const displayTimer = useRef(null); // FIX: single throttled display update timer
  const isRecordingRef = useRef(false);
  const sessionIdRef = useRef(null);
  const isStoppingRef = useRef(false); // FIX: guard against double-stop

  // ─── NetInfo ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(() => {}); // keep listener alive for network awareness
    return () => unsubscribe();
  }, []);

  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // ─── Throttled Display Timer (10fps) ───────────────────────────────────────
  // FIX: instead of setState on every sensor sample (200Hz), batch all UI updates here
  useEffect(() => {
    if (isRecording) {
      displayTimer.current = setInterval(() => {
        setAccelZ(accelZRef.current);
        setAudioRMS(audioRMSRef.current);
        setSpeedKmh(speedKmhRef.current);
        setDistanceM(distanceMRef.current);
        setIsSpeedValid(isSpeedValidRef.current);
        setGpsCoords(gpsCoordsRef.current);
        setCurrentSegmentDistance(currentSegmentDistanceRef.current);
        setCurrentIRI(currentIRIRef.current);
      }, 100); // 10fps — plenty for human eyes
    } else {
      if (displayTimer.current) {
        clearInterval(displayTimer.current);
        displayTimer.current = null;
      }
    }
    return () => {
      if (displayTimer.current) {
        clearInterval(displayTimer.current);
        displayTimer.current = null;
      }
    };
  }, [isRecording]);

  // ─── Sensor Hooks ──────────────────────────────────────────────────────────

  const imu = useIMU({
    enabled: isRecording,
    onSample: useCallback((packet) => {
      if (!isRecordingRef.current) return;
      accelZRef.current = packet.az - 9.81; // FIX: ref only, no setState
      pushSample(packet.az, speedKmhRef.current);
      wsClient.send(packet);
    }, []),
  });

  const gps = useGPS({
    enabled: isRecording,
    onSample: useCallback((packet) => {
      if (!isRecordingRef.current) return;
      speedKmhRef.current = packet.speed_kmh;
      isSpeedValidRef.current = packet.speed_kmh >= 20;
      distanceMRef.current = packet.distance_m;
      gpsCoordsRef.current = { lat: packet.lat, lng: packet.lng };

      const segmentDist = packet.distance_m - segmentStartDistanceRef.current;
      currentSegmentDistanceRef.current = segmentDist;

      if (segmentDist >= segmentLengthM) {
        segmentStartDistanceRef.current = packet.distance_m;
      }
      wsClient.send(packet);
    }, [segmentLengthM]),
  });

  const camera = useCamera({
    enabled: isRecording,
    onFrame: useCallback((packet) => {
      if (!isRecordingRef.current) return;
      wsClient.send(packet);
    }, []),
  });

  const audio = useAudio({
    enabled: isRecording,
    onSample: useCallback((packet) => {
      if (!isRecordingRef.current) return;
      audioRMSRef.current = packet.rms; // FIX: ref only, no setState
      wsClient.send(packet);
    }, []),
  });

  // ─── WebSocket Events ──────────────────────────────────────────────────────
  useEffect(() => {
    wsClient.onConnected = () => setWsStatus('connected');
    wsClient.onDisconnected = () => setWsStatus('disconnected');
    wsClient.onSegmentComplete = handleSegmentComplete;
    wsClient.onQueueDrain = () => setQueueSize(0);
    return () => {
      wsClient.onConnected = null;
      wsClient.onDisconnected = null;
      wsClient.onSegmentComplete = null;
      wsClient.onQueueDrain = null;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setQueueSize(wsClient.getStatus().queueSize), 2000);
    return () => clearInterval(timer);
  }, []);

  // ─── Rolling IRI (via ref, batched into display timer above) ───────────────
  useEffect(() => {
    if (isRecording) {
      iriUpdateTimer.current = setInterval(() => {
        currentIRIRef.current = computeRollingIRI();
      }, 500);
    } else {
      if (iriUpdateTimer.current) {
        clearInterval(iriUpdateTimer.current);
        iriUpdateTimer.current = null;
      }
    }
    return () => {
      if (iriUpdateTimer.current) {
        clearInterval(iriUpdateTimer.current);
        iriUpdateTimer.current = null;
      }
    };
  }, [isRecording]);

  // ─── Segment Complete ──────────────────────────────────────────────────────
  async function handleSegmentComplete(segment) {
    const segWithIndex = { ...segment, segment_index: segmentIndexRef.current };
    segmentIndexRef.current++;
    const updated = [...completedSegmentsRef.current, segWithIndex];
    completedSegmentsRef.current = updated;
    setCompletedSegments(updated);
    if (sessionIdRef.current) {
      await saveSegment(sessionIdRef.current, segWithIndex.segment_index, segWithIndex);
    }
  }

  // ─── Start ─────────────────────────────────────────────────────────────────
  async function startRecording() {
  if (isRecordingRef.current) return;

  // FIX: set immediately so UI shows stop button before awaits complete
  setIsRecording(true);
  isRecordingRef.current = true;

  const newSessionId = SESSION_ID_PREFIX + Date.now();
  setSessionId(newSessionId);
  sessionIdRef.current = newSessionId;

  await createSession({ id: newSessionId, name: sessionName, serverHost });

  resetIRIEstimator();
  completedSegmentsRef.current = [];
  setCompletedSegments([]);
  currentIRIRef.current = null;
  distanceMRef.current = 0;
  accelZRef.current = 0;
  audioRMSRef.current = 0;
  speedKmhRef.current = 0;
  isSpeedValidRef.current = false;
  gpsCoordsRef.current = null;
  currentSegmentDistanceRef.current = 0;
  setElapsedSeconds(0);
  segmentStartDistanceRef.current = 0;
  segmentIndexRef.current = 0;
  isStoppingRef.current = false;

  gps.resetDistance();

  setWsStatus('connecting');
  wsClient.connect(serverHost, newSessionId);
  await activateKeepAwakeAsync();

  sessionStartTime.current = Date.now();
  elapsedTimer.current = setInterval(() => {
    setElapsedSeconds(Math.floor((Date.now() - sessionStartTime.current) / 1000));
  }, 1000);
}

  // ─── Stop ──────────────────────────────────────────────────────────────────
  function stopRecording() {
    Alert.alert('Stop Recording', 'End this session and save all data?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Stop & Save', style: 'destructive', onPress: confirmStop },
    ]);
  }

  async function confirmStop() {
    // FIX: guard against double-call
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;

    setIsRecording(false);
    isRecordingRef.current = false;

    clearInterval(elapsedTimer.current);
    elapsedTimer.current = null;
    clearInterval(iriUpdateTimer.current);
    iriUpdateTimer.current = null;
    clearInterval(displayTimer.current);
    displayTimer.current = null;

    wsClient.disconnect();
    setWsStatus('off');
    deactivateKeepAwake();

    try {
      if (sessionIdRef.current) {
        const segs = completedSegmentsRef.current;
        const avgIRI = segs.length > 0
          ? segs.reduce((s, seg) => s + (seg.iri_value || 0), 0) / segs.length
          : null;
        await finalizeSession(sessionIdRef.current, {
          distanceM: distanceMRef.current,
          segmentCount: segs.length,
          avgIRI,
        });
      }
    } catch (e) {
      console.error('[Stop] finalizeSession failed:', e);
    }

    navigation.replace('History');
  }

  // ─── Sensor Statuses ───────────────────────────────────────────────────────
  const sensorStatuses = {
    imu:    imu.isActive    ? 'active'   : isRecording ? 'error'    : 'off',
    gps:    gps.isActive    ? (isSpeedValid ? 'active' : 'degraded') : isRecording ? 'error' : 'off',
    camera: camera.isActive ? 'active'   : isRecording ? 'degraded' : 'off',
    audio:  audio.isActive  ? 'active'   : isRecording ? 'degraded' : 'off',
    ws: wsStatus === 'connected' ? 'active' : wsStatus === 'connecting' ? 'degraded' : wsStatus === 'disconnected' ? 'error' : 'off',
  };

  function formatElapsed(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function formatDistance(meters) {
    if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
    return `${Math.round(meters)} m`;
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg0} />

      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sessionName} numberOfLines={1}>{sessionName}</Text>
          <Text style={styles.sessionMeta}>
            {isRecording ? formatElapsed(elapsedSeconds) : 'READY'} · {formatDistance(distanceM)} · SEG {segmentIndexRef.current}
          </Text>
        </View>
        <View style={[
          styles.wsBadge,
          wsStatus === 'connected'    && styles.wsBadgeConnected,
          wsStatus === 'connecting'   && styles.wsBadgeConnecting,
          wsStatus === 'disconnected' && styles.wsBadgeDisconnected,
        ]}>
          <Text style={[
            styles.wsBadgeText,
            wsStatus === 'connected'    && { color: COLORS.green },
            wsStatus === 'connecting'   && { color: COLORS.amber },
            wsStatus === 'disconnected' && { color: COLORS.red },
          ]}>
            {wsStatus === 'connected' ? '● LIVE' : wsStatus === 'connecting' ? '◌ LINKING' : wsStatus === 'disconnected' ? '○ OFFLINE' : '○ IDLE'}
          </Text>
          {queueSize > 0 && <Text style={styles.queueBadge}>{queueSize}Q</Text>}
        </View>
      </View>

      {/* Sensor Bar */}
      <View style={styles.sensorBar}>
        <SensorStatusBar statuses={sensorStatuses} sampleRate={imu.sampleRate} />
      </View>

      {/* Scrollable content */}
      <ScrollView style={styles.scrollArea} contentContainerStyle={styles.scrollContent}>

        {/* Camera */}
        <View style={styles.cameraContainer}>
          {camera.hasPermission ? (
            <CameraView ref={camera.cameraRef} style={styles.camera} facing="back" onCameraReady={camera.handleCameraReady} />
          ) : (
            <View style={styles.cameraPlaceholder}>
              <Text style={styles.cameraPlaceholderText}>CAM PERMISSION REQUIRED</Text>
            </View>
          )}
          {isRecording && !isSpeedValid && (
            <View style={styles.speedWarning}>
              <Text style={styles.speedWarningText}>⚠ SPEED &lt; 20 km/h — IRI INVALID</Text>
            </View>
          )}
          {gpsCoords && (
            <View style={styles.gpsOverlay}>
              <Text style={styles.gpsText}>{gpsCoords.lat.toFixed(5)}, {gpsCoords.lng.toFixed(5)}</Text>
            </View>
          )}
        </View>

        {/* Data Panels */}
        <View style={styles.dataPanels}>
          <View style={styles.iriPanel}>
            <IRIGauge iri={currentIRI} isValid={isSpeedValid || !isRecording} />
            <Text style={styles.iriNote}>LIVE ESTIMATE</Text>
          </View>
          <View style={styles.rightPanel}>
            <View style={styles.speedPanel}>
              <Text style={[styles.speedValue, { color: isSpeedValid ? COLORS.green : COLORS.amber }]}>
                {speedKmh.toFixed(0)}
              </Text>
              <Text style={styles.speedUnit}>km/h</Text>
            </View>
            <View style={styles.waveformPanel}>
              <Text style={styles.waveformLabel}>ACCEL Z  m/s²</Text>
              <AccelWaveform value={accelZ} />
            </View>
            <View style={styles.audioPanel}>
              <Text style={styles.audioLabel}>MIC RMS</Text>
              <View style={styles.audioBar}>
                <View style={[styles.audioFill, {
                  width: `${Math.min(100, audioRMS * 500)}%`,
                  backgroundColor: audioRMS > 0.1 ? COLORS.amber : COLORS.amberDim,
                }]} />
              </View>
            </View>
          </View>
        </View>

        {/* Segment Progress */}
        {isRecording && (
          <View style={styles.segmentProgress}>
            <View style={styles.segmentProgressTrack}>
              <View style={[styles.segmentProgressFill, {
                width: `${Math.min(100, (currentSegmentDistance / segmentLengthM) * 100)}%`,
              }]} />
            </View>
            <Text style={styles.segmentProgressText}>
              {Math.round(currentSegmentDistance)}m / {segmentLengthM}m  SEGMENT {segmentIndexRef.current + 1}
            </Text>
          </View>
        )}

        {/* Segment History */}
        <View style={styles.historyContainer}>
          <Text style={styles.historyLabel}>COMPLETED SEGMENTS</Text>
          <SegmentHistory segments={completedSegments} />
        </View>

      </ScrollView>

      {/* Button — pinned at bottom, outside ScrollView */}
      <View style={styles.buttonArea}>
        {!isRecording ? (
          <TouchableOpacity style={styles.recordBtn} onPress={startRecording} activeOpacity={0.8}>
            <View style={styles.recordBtnInner}><View style={styles.recordDot} /></View>
            <Text style={styles.recordBtnLabel}>START RECORDING</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.stopBtn} onPress={stopRecording} activeOpacity={0.8}>
            <View style={styles.stopBtnInner}><View style={styles.stopSquare} /></View>
            <Text style={styles.stopBtnLabel}>STOP SESSION</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const CAMERA_HEIGHT = 160;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg0 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  sessionName: { fontSize: 13, color: COLORS.textPrimary, fontWeight: '600', letterSpacing: 0.3, maxWidth: SCREEN_WIDTH * 0.55 },
  sessionMeta: { fontSize: 10, color: COLORS.textMuted, letterSpacing: 0.5, marginTop: 2 },
  wsBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.bg2,
  },
  wsBadgeConnected:    { borderColor: COLORS.green + '60', backgroundColor: COLORS.greenFaint },
  wsBadgeConnecting:   { borderColor: COLORS.amber + '60', backgroundColor: COLORS.amberFaint },
  wsBadgeDisconnected: { borderColor: COLORS.red   + '40', backgroundColor: COLORS.redFaint },
  wsBadgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 1, color: COLORS.textMuted },
  queueBadge:  { fontSize: 8, color: COLORS.amber, fontWeight: '700' },
  sensorBar: { paddingHorizontal: SPACING.md, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  scrollArea: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  cameraContainer: { height: CAMERA_HEIGHT, backgroundColor: COLORS.bg2, position: 'relative', borderBottomWidth: 1, borderBottomColor: COLORS.border },
  camera: { flex: 1 },
  cameraPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  cameraPlaceholderText: { fontSize: 11, color: COLORS.textMuted, letterSpacing: 2 },
  speedWarning: { position: 'absolute', bottom: 8, left: 0, right: 0, alignItems: 'center' },
  speedWarningText: { fontSize: 10, color: COLORS.amber, backgroundColor: COLORS.bg0 + 'CC', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, fontWeight: '700', letterSpacing: 1 },
  gpsOverlay: { position: 'absolute', top: 8, right: 8, backgroundColor: COLORS.bg0 + 'BB', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  gpsText: { fontSize: 9, color: COLORS.green, letterSpacing: 0.5 },
  dataPanels: { flexDirection: 'row', padding: SPACING.md, gap: SPACING.md, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  iriPanel:   { flex: 1, alignItems: 'center', gap: 4 },
  iriNote:    { fontSize: 8, color: COLORS.textMuted, letterSpacing: 2 },
  rightPanel: { flex: 1.2, gap: SPACING.sm },
  speedPanel: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  speedValue: { fontSize: 36, fontWeight: '200', letterSpacing: -1, lineHeight: 38, fontVariant: ['tabular-nums'] },
  speedUnit:  { fontSize: 11, color: COLORS.textMuted, marginBottom: 4, letterSpacing: 1 },
  waveformPanel: { gap: 4 },
  waveformLabel: { fontSize: 8, color: COLORS.textMuted, letterSpacing: 2 },
  audioPanel: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  audioLabel: { fontSize: 8, color: COLORS.textMuted, letterSpacing: 1.5, width: 40 },
  audioBar:   { flex: 1, height: 4, backgroundColor: COLORS.bg3, borderRadius: 2, overflow: 'hidden' },
  audioFill:  { height: '100%', borderRadius: 2 },
  segmentProgress: { paddingHorizontal: SPACING.md, paddingVertical: 8, gap: 4 },
  segmentProgressTrack: { height: 3, backgroundColor: COLORS.bg3, borderRadius: 2, overflow: 'hidden' },
  segmentProgressFill:  { height: '100%', backgroundColor: COLORS.amber, borderRadius: 2 },
  segmentProgressText:  { fontSize: 9, color: COLORS.textMuted, letterSpacing: 1.5 },
  historyContainer: { paddingHorizontal: SPACING.md, paddingVertical: 8, gap: 6 },
  historyLabel: { fontSize: 8, color: COLORS.textMuted, letterSpacing: 2, fontWeight: '600' },
  buttonArea: { paddingHorizontal: SPACING.lg, paddingBottom: SPACING.lg, paddingTop: SPACING.sm, borderTopWidth: 1, borderTopColor: COLORS.border },
  recordBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.md, backgroundColor: COLORS.redFaint, borderWidth: 1, borderColor: COLORS.red + '80', borderRadius: RADIUS.md, paddingVertical: 16 },
  recordBtnInner: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: COLORS.red, justifyContent: 'center', alignItems: 'center' },
  recordDot:      { width: 14, height: 14, borderRadius: 7, backgroundColor: COLORS.red },
  recordBtnLabel: { fontSize: 14, color: COLORS.red, fontWeight: '800', letterSpacing: 3 },
  stopBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.md, backgroundColor: COLORS.bg3, borderWidth: 1, borderColor: COLORS.borderBright, borderRadius: RADIUS.md, paddingVertical: 16 },
  stopBtnInner: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: COLORS.textSecondary, justifyContent: 'center', alignItems: 'center' },
  stopSquare:   { width: 12, height: 12, backgroundColor: COLORS.textSecondary, borderRadius: 2 },
  stopBtnLabel: { fontSize: 14, color: COLORS.textSecondary, fontWeight: '800', letterSpacing: 3 },
});
