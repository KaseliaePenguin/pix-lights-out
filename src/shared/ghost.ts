import { physicsVersion, raceRules } from './carParams';
import { lerpAngle, wrapAngle } from './math';
import type { Pose } from './Track';

/**
 * ゴースト (自己ベスト周の位置と向き、game-design.md 12 章 M1)。
 * 周回の開始 (コントロールライン通過) を 0 秒として、30 回/秒 の位置と向きを持つ。
 * 保存形式は JSON にそのまま入れられる形 (frames は Int16 の base64)。
 */
export interface GhostData {
  formatVersion: 1;
  /** 記録したときの物理のバージョン。今と違えば破棄する */
  physicsVersion: number;
  trackId: string;
  /** 記録したときのコースデータのバージョン (TrackData.version)。今と違えば破棄する */
  trackVersion: number;
  lapTime: number;
  /** 記録の頻度 (回/秒) */
  rate: number;
  frameCount: number;
  /** [x×2, y×2, 向き] × frameCount を Int16 にして base64 にしたもの */
  frames: string;
  /** タイミングラインごとの通過タイム (ゴースト差の表示に使う) */
  splits: number[];
  /** 区間タイム 3 つ */
  sectors: number[];
}

const angleScale = 32767 / Math.PI;

/** ゴーストが今の物理・コースで使えるか */
export function isGhostCompatible(data: unknown, trackId: string, trackVersion: number): data is GhostData {
  if (typeof data !== 'object' || data === null) return false;
  const g = data as Partial<GhostData>;
  return (
    g.formatVersion === 1 &&
    g.physicsVersion === physicsVersion &&
    g.trackId === trackId &&
    g.trackVersion === trackVersion &&
    typeof g.lapTime === 'number' &&
    typeof g.rate === 'number' &&
    typeof g.frameCount === 'number' &&
    typeof g.frames === 'string' &&
    Array.isArray(g.splits) &&
    Array.isArray(g.sectors)
  );
}

/** ゴーストを保存用の文字列にする (localStorage にそのまま入れられる JSON。1 周 約 10 KB) */
export function serializeGhost(data: GhostData): string {
  return JSON.stringify(data);
}

/**
 * 保存した文字列からゴーストを戻す。壊れている・物理のバージョンやコースが違う場合は null (破棄する)
 */
export function deserializeGhost(text: string | null, trackId: string, trackVersion: number): GhostData | null {
  if (!text) return null;
  try {
    const data: unknown = JSON.parse(text);
    if (!isGhostCompatible(data, trackId, trackVersion)) return null;
    // frames が壊れていないか (base64 として読めて、長さが足りるか)
    const bytes = atob(data.frames).length;
    if (bytes < data.frameCount * 6) return null;
    return data;
  } catch {
    return null;
  }
}

/** 1 周分の位置を記録する。周回の開始で start、毎フレーム record、周回の終了で finish */
export class GhostRecorder {
  private values: number[] = [];
  private nextTime = 0;
  private prevTime = 0;
  private prevX = 0;
  private prevY = 0;
  private prevH = 0;
  private active = false;
  private readonly interval = 1 / raceRules.ghostRate;

  get isRecording(): boolean {
    return this.active;
  }

  /**
   * 周回の開始時に呼ぶ。lapTime はこの時点の周回タイム (通過したフレームの終わり。0〜dt)、
   * prev は通過直前のフレームの位置 (lapTime - dt の時点)
   */
  start(lapTime: number, dt: number, prevX: number, prevY: number, prevHeading: number): void {
    this.values = [];
    this.nextTime = 0;
    this.prevTime = lapTime - dt;
    this.prevX = prevX;
    this.prevY = prevY;
    this.prevH = prevHeading;
    this.active = true;
  }

  /** 毎フレーム (車の update の後) に呼ぶ */
  record(lapTime: number, x: number, y: number, heading: number): void {
    if (!this.active) return;
    const span = lapTime - this.prevTime;
    while (this.nextTime <= lapTime && span > 0) {
      const t = Math.max(0, Math.min(1, (this.nextTime - this.prevTime) / span));
      this.values.push(
        Math.round((this.prevX + (x - this.prevX) * t) * 2),
        Math.round((this.prevY + (y - this.prevY) * t) * 2),
        Math.round(wrapAngle(lerpAngle(this.prevH, heading, t)) * angleScale),
      );
      this.nextTime += this.interval;
    }
    this.prevTime = lapTime;
    this.prevX = x;
    this.prevY = y;
    this.prevH = heading;
  }

  cancel(): void {
    this.active = false;
    this.values = [];
  }

  /** 周回の終了時に呼ぶ */
  finish(trackId: string, trackVersion: number, lapTime: number, splits: readonly number[], sectors: readonly number[]): GhostData {
    this.active = false;
    const arr = new Int16Array(this.values.length);
    for (let i = 0; i < this.values.length; i++) arr[i] = Math.max(-32768, Math.min(32767, this.values[i]));
    return {
      formatVersion: 1,
      physicsVersion,
      trackId,
      trackVersion,
      lapTime,
      rate: raceRules.ghostRate,
      frameCount: this.values.length / 3,
      frames: encodeInt16(arr),
      splits: splits.map((v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : -1)),
      sectors: sectors.map((v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : -1)),
    };
  }
}

/** ゴーストの再生。周回タイムを渡すと、その時点の位置と向きを返す */
export class GhostPlayer {
  private readonly frames: Int16Array;

  constructor(readonly data: GhostData) {
    this.frames = decodeInt16(data.frames);
  }

  get lapTime(): number {
    return this.data.lapTime;
  }

  /** lapTime の時点の位置。0〜ラップタイムの外なら false (最後のフレームより後はその位置に止める) */
  sample(lapTime: number, out: Pose): boolean {
    const count = Math.min(this.data.frameCount, Math.floor(this.frames.length / 3));
    if (lapTime < 0 || count === 0 || lapTime > this.data.lapTime) return false;
    const u = Math.min(lapTime * this.data.rate, count - 1);
    // フレームが 1 つだけのときは i = 0、t = 0 (count - 2 が負になって NaN にならないように)
    const i = Math.max(0, Math.min(Math.floor(u), count - 2));
    const t = count > 1 ? u - i : 0;
    const a = i * 3;
    const b = Math.min(i + 1, count - 1) * 3;
    out.x = (this.frames[a] + (this.frames[b] - this.frames[a]) * t) / 2;
    out.y = (this.frames[a + 1] + (this.frames[b + 1] - this.frames[a + 1]) * t) / 2;
    out.heading = lerpAngle(this.frames[a + 2] / angleScale, this.frames[b + 2] / angleScale, t);
    return true;
  }

  /** タイミングライン index を lapTime で通過したときのゴースト差 (負 = ゴーストより速い)。記録がなければ null */
  deltaAt(index: number, lapTime: number): number | null {
    const ref = this.data.splits[index];
    if (ref === undefined || ref < 0) return null;
    return lapTime - ref;
  }
}

// base64 (btoa / atob はブラウザと Node 16 以降の両方にある)
function encodeInt16(values: Int16Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function decodeInt16(text: string): Int16Array {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length - (bin.length % 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
