import type { Car } from './Car';
import type { Track } from './Track';

/** free = 予選・タイムアタック (区間内なら条件なし)、race = 決勝 (検知ラインで条件成立した周だけ。M2) */
export type DrsMode = 'free' | 'race';

/** HUD の DRS 表示 (game-design.md 10.1 節の 3 状態) */
export type DrsIndicator = 'unavailable' | 'available' | 'active';

/**
 * DRS の使用権と区間の管理 (game-design.md 7.6 節、car-physics.md 12 節)。
 * 車の update の前に update を呼ぶ (車が drsAvailable を見て開くため)。
 * 一度閉じたら、その区間では再度開けない。
 */
export class DrsController {
  /** 決勝モードで、この周の DRS 区間を使えるか (検知ラインの判定結果。M2 で外から設定する) */
  isEligible = false;
  /** 車が DRS 区間の中にいる */
  isInZone = false;
  /** このフレームで区間に入った */
  enteredZone = false;
  /** このフレームで、使える状態で区間に入った (DRS ENABLED を出す) */
  enabledOnEntry = false;

  private usedInZone = false;

  constructor(private readonly track: Track, readonly mode: DrsMode) {}

  /** HUD の DRS 表示 */
  indicator(car: Car): DrsIndicator {
    if (car.drsOpen) return 'active';
    if (car.drsAvailable) return 'available';
    // 決勝で使用権を得ている周は、区間の外でも「使用可能」を出す
    if (this.mode === 'race' && this.isEligible && !this.usedInZone) return 'available';
    return 'unavailable';
  }

  /** s は車の中心線上の位置 (LapTracker.projection.s) */
  update(car: Car, s: number): void {
    const inZone = this.isInside(s);
    this.enteredZone = inZone && !this.isInZone;
    if (!inZone) {
      if (this.isInZone) car.closeDrs();
      this.usedInZone = false;
    } else if (car.drsOpen) {
      this.usedInZone = true;
    }
    this.isInZone = inZone;
    const allowed = this.mode === 'free' || this.isEligible;
    car.drsAvailable = inZone && allowed && (!this.usedInZone || car.drsOpen);
    this.enabledOnEntry = this.enteredZone && car.drsAvailable;
  }

  private isInside(s: number): boolean {
    const a = this.track.drsStartS;
    const b = this.track.drsEndS;
    return a <= b ? s >= a && s <= b : s >= a || s <= b;
  }
}
