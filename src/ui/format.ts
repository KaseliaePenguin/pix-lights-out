/** 速度の表示換算 (game-design.md 10.1 節: km/h = px/秒 × 0.6 の演出値) */
export function toDisplayKmh(speedPxPerSec: number): number {
  return Math.round(Math.abs(speedPxPerSec) * 0.6);
}

/** ラップ・区間タイム `1:23.456`。null は `-:--.---` (桁をそろえる) */
export function formatLapTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '-:--.---';
  const totalMs = Math.floor(seconds * 1000 + 1e-6);
  const minutes = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${minutes}:${pad(secs, 2)}.${pad(ms, 3)}`;
}

/** 前後の車とのタイム差 (7.5 節): `+1.234` / `+1:02.345` */
export function formatGap(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const totalMs = Math.floor(Math.abs(seconds) * 1000 + 1e-6);
  if (totalMs < 60000) return `${sign}${Math.floor(totalMs / 1000)}.${pad(totalMs % 1000, 3)}`;
  return `${sign}${formatLapTime(totalMs / 1000)}`;
}

/** ゴースト差 `-0.23` (小数 2 桁、±99.99 で頭打ち) */
export function formatGhostDelta(seconds: number): string {
  const hundredths = Math.min(Math.round(Math.abs(seconds) * 100), 9999);
  const sign = seconds < 0 && hundredths > 0 ? '-' : '+';
  return `${sign}${Math.floor(hundredths / 100)}.${pad(hundredths % 100, 2)}`;
}

function pad(value: number, digits: number): string {
  return String(value).padStart(digits, '0');
}
