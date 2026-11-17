/** RoBugs UI palette — a dark "workshop" look with amber accents. */
export const Colors = {
  bg: '#12151A',
  bgDeep: '#0C0E12',
  panel: '#1C2129',
  panelHi: '#262D37',
  panelEdge: '#323B47',
  border: '#343D49',
  text: '#F4EFE6',
  textDim: '#97A1AD',
  accent: '#F2A93B',
  accentLip: '#B36F16',
  accentDim: '#7A5520',
  good: '#3DDC97',
  goodLip: '#1F8A5C',
  bad: '#FF5D5D',
  badLip: '#9C2F33',
  slateLip: '#151A21',
  arenaFloor: '#23282F',
  arenaGrid: '#2C323A',
  acid: 'rgba(124, 230, 84, 0.35)',
  stomper: 'rgba(255, 138, 61, 0.18)',
  stomperWarn: 'rgba(255, 90, 40, 0.55)',
} as const;

/** Display face for titles, buttons and big numbers (loaded in the root layout). */
export const Fonts = {
  display: 'LilitaOne_400Regular',
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const MaxContentWidth = 560;
