export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

/** Graphics preset: everything that trades image quality for frame rate. */
export interface Quality {
  level: QualityLevel;
  /** Cap for devicePixelRatio (low scales below 1). */
  pixelRatio: number;
  msaa: number;
  bloom: boolean;
  shadows: boolean;
  shadowSize: number;
  /** Half-size of the sun shadow box around the player, metres. */
  shadowRange: number;
  smallProps: boolean;
  /** Cloud density multiplier (0 = none). */
  clouds: number;
  /** Terrain LOD split factor (higher = more detail further away). */
  splitK: number;
  /** Image-based reflections (sky / space environment maps). */
  env: boolean;
  /** Colour grade + vignette pass. */
  grade: boolean;
}

export const QUALITY: Record<QualityLevel, Quality> = {
  low: { level: 'low', pixelRatio: 0.75, msaa: 0, bloom: false, shadows: false, shadowSize: 1024, shadowRange: 40, smallProps: false, clouds: 0.4, splitK: 1.8, env: false, grade: false },
  medium: { level: 'medium', pixelRatio: 1, msaa: 0, bloom: true, shadows: true, shadowSize: 1024, shadowRange: 45, smallProps: true, clouds: 0.7, splitK: 2.2, env: true, grade: true },
  high: { level: 'high', pixelRatio: 1.5, msaa: 4, bloom: true, shadows: true, shadowSize: 2048, shadowRange: 60, smallProps: true, clouds: 1, splitK: 2.6, env: true, grade: true },
  ultra: { level: 'ultra', pixelRatio: 2, msaa: 4, bloom: true, shadows: true, shadowSize: 4096, shadowRange: 90, smallProps: true, clouds: 1.3, splitK: 3.2, env: true, grade: true },
};

export const QUALITY_NAMES: Record<QualityLevel, string> = { low: 'Низкое', medium: 'Среднее', high: 'Высокое', ultra: 'Ультра' };

export interface Settings { quality: QualityLevel; sensitivity: number; volume: number }

const KEY = 'nova.settings';

export function loadSettings(): Settings {
  const def: Settings = { quality: 'high', sensitivity: 1, volume: 0.6 };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...def, ...s, quality: s.quality in QUALITY ? s.quality : def.quality };
  } catch {
    return def;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* storage unavailable */ }
}
