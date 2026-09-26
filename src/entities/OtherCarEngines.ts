import type { AudioManager } from '../core/AudioManager';
import type { LoopSound } from '../core/LoopSound';
import type { Car } from '../shared/Car';
import { VirtualGearbox } from '../shared/VirtualGearbox';

/** 同時に鳴らす台数 (game-design.md 13.2 節: 近い 4 台) */
const voiceCount = 4;
/** この距離 (px) 以上で音量 0 (衝突音と同じ距離、game-design.md 14 章) */
const hearingDistance = 600;
/** 回転数 0 / 1 の再生速度 (自車の EngineSound と同じ幅) */
const minRate = 0.55;
const maxRate = 1.9;
/** アクセルを離しているときの音量 (踏んでいるときを 1 とした比) */
const offThrottleVolume = 0.6;

/** 他車 1 台ぶんの入力 */
export interface OtherCarSource {
  /** 車ごとに変わらない番号 (車番) */
  id: number;
  car: Car;
  /** 0〜1 */
  throttle: number;
}

/**
 * 他車 (CPU・オンラインの相手) のエンジン音 engine-cpu-loop。自車に近い 4 台だけを鳴らし、距離で音量を下げる。
 * 回転数は車ごとの仮想ギアを音のためだけに持って計算する (オンラインの相手は物理を持たないため)。
 */
export class OtherCarEngines {
  private readonly voices: LoopSound[] = [];
  private readonly gearboxes = new Map<number, VirtualGearbox>();
  private readonly nearest: { source: OtherCarSource; distance: number }[] = [];

  constructor(audio: AudioManager) {
    for (let i = 0; i < voiceCount; i++) this.voices.push(audio.createLoop('engine-cpu-loop'));
  }

  /** 毎フレーム呼ぶ。listener は自車 (聞く位置)、volume は全体に掛ける音量 */
  update(listener: Car, sources: readonly OtherCarSource[], volume = 1): void {
    const nearest = this.nearest;
    nearest.length = 0;
    for (const s of sources) {
      let gearbox = this.gearboxes.get(s.id);
      if (!gearbox) {
        gearbox = new VirtualGearbox();
        this.gearboxes.set(s.id, gearbox);
      }
      gearbox.update(s.car.isSpinning ? s.car.speed : s.car.sF);
      const distance = Math.hypot(s.car.x - listener.x, s.car.y - listener.y);
      if (distance < hearingDistance) nearest.push({ source: s, distance });
    }
    nearest.sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i];
      const n = nearest[i];
      if (!n) {
        voice.setVolume(0);
        continue;
      }
      const gearbox = this.gearboxes.get(n.source.id)!;
      const throttle = Math.min(1, Math.max(0, n.source.throttle));
      const level = (offThrottleVolume + (1 - offThrottleVolume) * throttle) * (1 - n.distance / hearingDistance);
      voice.set(level * volume, minRate + (maxRate - minRate) * gearbox.rpmRatio);
    }
  }

  /** 全部の音量を 0 にする (ポーズ中など) */
  silence(): void {
    for (const v of this.voices) v.setVolume(0);
  }

  stop(): void {
    for (const v of this.voices) v.stop();
  }
}
