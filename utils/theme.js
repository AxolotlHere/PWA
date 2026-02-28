// PULSE Design System
// Aesthetic: Industrial telemetry — dark cockpit, phosphor green data, amber warnings
// Inspired by aircraft instrument panels + Soviet-era engineering displays

export const COLORS = {
  // Backgrounds
  bg0: '#050810',        // Deepest background
  bg1: '#0A0F1E',        // Primary background
  bg2: '#0F1628',        // Card background
  bg3: '#162035',        // Elevated card
  border: '#1E2D4A',     // Subtle border
  borderBright: '#2A3F5F', // Active border

  // Phosphor green — primary data color
  green: '#00FF88',
  greenDim: '#00C86A',
  greenFaint: '#003320',
  greenMid: '#00884A',

  // Amber — warnings, secondary data
  amber: '#FFB800',
  amberDim: '#CC9200',
  amberFaint: '#2A2000',

  // Red — critical / poor condition
  red: '#FF3B3B',
  redDim: '#CC2020',
  redFaint: '#2A0808',

  // IRI condition colors (IRC:SP:20)
  iriGood: '#00FF88',     // < 2.0
  iriFair: '#FFB800',     // 2.0 - 4.0
  iriPoor: '#FF6B00',     // 4.0 - 6.0
  iriVeryPoor: '#FF3B3B', // > 6.0

  // Text
  textPrimary: '#E8F0FF',
  textSecondary: '#7A8FAE',
  textMuted: '#3A4F6E',
  textGreen: '#00FF88',
  textAmber: '#FFB800',

  // Neutral
  white: '#FFFFFF',
  black: '#000000',
};

export const FONTS = {
  // Display: monospace engineering font
  mono: 'SpaceMono',          // For data values
  // Body: clean technical
  regular: 'System',
};

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const RADIUS = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 20,
};

export const IRI_THRESHOLDS = {
  GOOD: 2.0,
  FAIR: 4.0,
  POOR: 6.0,
};

export const getIRIColor = (iri) => {
  if (iri === null || iri === undefined) return COLORS.textMuted;
  if (iri < IRI_THRESHOLDS.GOOD) return COLORS.iriGood;
  if (iri < IRI_THRESHOLDS.FAIR) return COLORS.iriFair;
  if (iri < IRI_THRESHOLDS.POOR) return COLORS.iriPoor;
  return COLORS.iriVeryPoor;
};

export const getIRILabel = (iri) => {
  if (iri === null || iri === undefined) return 'NO DATA';
  if (iri < IRI_THRESHOLDS.GOOD) return 'GOOD';
  if (iri < IRI_THRESHOLDS.FAIR) return 'FAIR';
  if (iri < IRI_THRESHOLDS.POOR) return 'POOR';
  return 'VERY POOR';
};

export const getIRIAction = (iri) => {
  if (iri === null || iri === undefined) return '—';
  if (iri < IRI_THRESHOLDS.GOOD) return 'ROUTINE MAINT.';
  if (iri < IRI_THRESHOLDS.FAIR) return 'PREVENTIVE TX';
  if (iri < IRI_THRESHOLDS.POOR) return 'REHABILITATION';
  return 'RECONSTRUCTION';
};

export const formatIRI = (iri) => {
  if (iri === null || iri === undefined) return '—';
  return iri.toFixed(1);
};