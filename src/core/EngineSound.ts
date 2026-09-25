import type { LoopSound } from './LoopSound';

export interface EngineSoundOptions {
  /** 回転数 0 (アイドリング) の再生速度 */
  minRate?: number;
  /** 回転数 1 (レッドゾーン) の再生速度 */
  maxRate?: number;
  /** アクセル OFF のときの音量 (ON を 1 とした比) */
  offVolume?: number;
}

/**
 * 自車のエンジン音。アクセル ON のループと OFF (減速) のループをアクセル量でクロスフェードし、
 * 回転数で再生速度を変える (sound-guide.md 3 章)。OFF のループがなければ ON だけで音量を下げる。
 */
export class EngineSound {
  /** OFF 側の再生速度に掛ける補正 (素材を録った回転数の違いを合わせる。試聴で調整する) */
  decelRateScale = 1.0;

  private readonly minRate: number;
  private readonly maxRate: number;
  private readonly offVolume: number;

  constructor(
    private readonly on: LoopSound,
    private readonly off: LoopSound,
    options: EngineSoundOptions = {},
  ) {
    this.minRate = options.minRate ?? 0.55;
    this.maxRate = options.maxRate ?? 1.9;
    this.offVolume = options.offVolume ?? 0.6;
  }

  /**
   * 毎フレーム呼ぶ。rpm は仮想ギア内の回転数 (0〜1)、throttle はアクセル量 (0〜1)、
   * volume は全体に掛ける音量 (スタート前に絞るときなど)
   */
  update(rpm: number, throttle: number, volume = 1): void {
    const r = clamp01(rpm);
    const t = clamp01(throttle);
    const rate = this.minRate + (this.maxRate - this.minRate) * r;
    if (this.off.isPlayable) {
      // 等パワーのクロスフェード (中間で音量が痩せないように)
      this.on.set(Math.sin((t * Math.PI) / 2) * volume, rate);
      this.off.set(Math.cos((t * Math.PI) / 2) * this.offVolume * volume, rate * this.decelRateScale);
    } else {
      this.on.set((this.offVolume + (1 - this.offVolume) * t) * volume, rate);
    }
  }

  /** 走行画面を抜けるときに呼ぶ */
  stop(): void {
    this.on.stop();
    this.off.stop();
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
