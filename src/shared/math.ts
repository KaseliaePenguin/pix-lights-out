/** DOM に依存しない小さな数学ヘルパー */

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 角度を -π〜π に収める */
export function wrapAngle(angle: number): number {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  else if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** 近い回り方向で角度を補間する */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/** value を target へ最大 maxDelta だけ近づける */
export function approach(value: number, target: number, maxDelta: number): number {
  if (value < target) return Math.min(value + maxDelta, target);
  return Math.max(value - maxDelta, target);
}

/**
 * 線分 p0→p1 と線分 a→b の交差。交差すれば p0→p1 上の位置 (0〜1) を返し、しなければ -1
 */
export function segmentIntersection(
  p0x: number, p0y: number, p1x: number, p1y: number,
  ax: number, ay: number, bx: number, by: number,
): number {
  const rx = p1x - p0x;
  const ry = p1y - p0y;
  const sx = bx - ax;
  const sy = by - ay;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return -1;
  const qpx = ax - p0x;
  const qpy = ay - p0y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
  return t;
}
