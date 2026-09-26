import type { AudioManager } from '../core/AudioManager';
import type { EngineSound } from '../core/EngineSound';
import type { LoopSound } from '../core/LoopSound';
import type { Car } from '../shared/Car';
import { computeCarSound, createCarSoundParams } from '../shared/carEffects';
import type { VirtualGearbox } from '../shared/VirtualGearbox';

/** 自車の走行音 (エンジン・スキール・路面・壁の擦れ)。毎フレーム update し、画面を抜けるときに stop する */
export class DriveSounds {
  private readonly engine: EngineSound;
  private readonly squeal: LoopSound;
  private readonly grass: LoopSound;
  private readonly gravel: LoopSound;
  private readonly kerb: LoopSound;
  private readonly scrape: LoopSound;
  private readonly params = createCarSoundParams();

  constructor(audio: AudioManager) {
    this.engine = audio.createEngine('engine-player-loop', 'engine-player-decel-loop');
    this.squeal = audio.createLoop('tire-squeal-loop');
    this.grass = audio.createLoop('offtrack-grass-loop');
    this.gravel = audio.createLoop('offtrack-gravel-loop');
    this.kerb = audio.createLoop('kerb-rumble-loop');
    this.scrape = audio.createLoop('scrape-loop');
  }

  /** throttle は音に使うアクセル量 (操作不能・ブレーキ中は 0 を渡す) */
  update(car: Car, gearbox: VirtualGearbox, throttle: number): void {
    const p = computeCarSound(car, gearbox, throttle, this.params);
    this.engine.update(gearbox.rpmRatio, throttle);
    this.squeal.set(p.squealVolume, p.squealRate);
    this.grass.set(p.grassVolume, p.surfaceRate);
    this.gravel.set(p.gravelVolume, p.surfaceRate);
    this.kerb.set(p.kerbVolume, p.surfaceRate);
    this.scrape.set(p.scrapeVolume);
  }

  stop(): void {
    this.engine.stop();
    this.squeal.stop();
    this.grass.stop();
    this.gravel.stop();
    this.kerb.stop();
    this.scrape.stop();
  }
}
