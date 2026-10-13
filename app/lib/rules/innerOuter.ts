/** One wheel size like "7.5 x 17 ET52" or "8Jx20 ET24": width in inches, diameter, ET (offset). */
const SIZE = /(\d+(?:[.,]\d+)?)\s*J?\s*x\s*(\d+(?:[.,]\d+)?)\s*ET\s*(-?\d+(?:[.,]\d+)?)/gi;

const num = (s: string) => Number(s.replace(",", "."));

export interface WheelSize {
  width: number;
  diameter: number;
  et: number;
}

/** All sizes in a text such as "7.5 x 17 ET52|6.5 x 17 ET39". */
export function parseSizes(text: string | null | undefined): WheelSize[] {
  return [...(text ?? "").matchAll(SIZE)].map((m) => ({ width: num(m[1]), diameter: num(m[2]), et: num(m[3]) }));
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Largest inner and outer reach (mm from the hub face to the rim edge) over the sizes, plus the
 * tolerance: inner = width/2 + ET, outer = width/2 − ET, width converted from inches.
 */
export function innerOuter(sizes: WheelSize[], toleranceMm: number) {
  if (sizes.length === 0) return null;
  const half = (s: WheelSize) => (s.width * 25.4) / 2;
  return {
    inner: round1(Math.max(...sizes.map((s) => half(s) + s.et)) + toleranceMm),
    outer: round1(Math.max(...sizes.map((s) => half(s) - s.et)) + toleranceMm),
  };
}
