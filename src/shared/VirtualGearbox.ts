import { raceRules } from './carParams';

/** 各ギアの上限速度 (px/秒、game-design.md 10.1 節) */
export const gearTopSpeeds: readonly number[] = [110, 190, 265, 340, 410, 470, 620];
/** シフトダウンのヒステリシス (下のギアの上限よりこれだけ遅くなったら下げる) */
const downshiftMargin = 10;

/** 速度の表示値 (km/h)。px/秒 × 0.6 の演出値 */
export function toKmh(speed: number): number {
  return Math.round(Math.abs(speed) * raceRules.kmhPerPxPerSec);
}

/**
 * 表示とエンジン音のための仮想ギア (物理にギアはない)。車ごとに 1 つ持ち、毎フレーム update する。
 */
export class VirtualGearbox {
  /** 1〜7 */
  gear = 1;
  /**
   * 回転数 = そのギアの速度範囲の中での割合 0〜1 (前のギアの上限 → このギアの上限)。
   * シフトアップで 0 近くまで落ちる
   */
  rpm = 0;
  /** そのギアの上限速度に対する割合 0〜1。シフトアップで 0.6〜0.85 程度に落ちる (実車に近いノコギリ形) */
  rpmRatio = 0;
  /** このフレームでシフトアップした (gear-shift を鳴らす) */
  shiftedUp = false;

  update(speed: number): void {
    const v = Math.abs(speed);
    this.shiftedUp = false;
    while (this.gear < gearTopSpeeds.length && v > gearTopSpeeds[this.gear - 1]) {
      this.gear++;
      this.shiftedUp = true;
    }
    while (this.gear > 1 && v < gearTopSpeeds[this.gear - 2] - downshiftMargin) this.gear--;
    const hi = gearTopSpeeds[this.gear - 1];
    const lo = this.gear > 1 ? gearTopSpeeds[this.gear - 2] : 0;
    this.rpm = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    this.rpmRatio = Math.max(0, Math.min(1, v / hi));
  }

  reset(): void {
    this.gear = 1;
    this.rpm = 0;
    this.rpmRatio = 0;
    this.shiftedUp = false;
  }
}
