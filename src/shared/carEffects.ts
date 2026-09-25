import type { Car } from './Car';
import type { VirtualGearbox } from './VirtualGearbox';

/**
 * 車の状態から、音と画面の演出に使う値を計算する (再生そのものはしない。DOM に依存しない)。
 * 数値の出典: sound-guide.md §3・§4、game-design.md 10.4 節・13.2 節、car-physics.md 8・9 節。
 */
export interface CarSoundParams {
  /** engine-player-loop の再生速度 (0.55〜1.9) */
  engineRate: number;
  /** engine-player-decel-loop があるとき: ON 用 (engine-player-loop) と OFF 用のクロスフェードの音量 0〜1 */
  engineOnVolume: number;
  engineOffVolume: number;
  /** engine-player-decel-loop がないとき: engine-player-loop だけで鳴らす音量 (OFF で 0.6 倍) */
  engineSoloVolume: number;
  /** tire-squeal-loop の音量・再生速度 */
  squealVolume: number;
  squealRate: number;
  /** offtrack-grass-loop / offtrack-gravel-loop / kerb-rumble-loop の音量・再生速度 */
  grassVolume: number;
  gravelVolume: number;
  kerbVolume: number;
  surfaceRate: number;
  /** scrape-loop の音量 */
  scrapeVolume: number;
}

export function createCarSoundParams(): CarSoundParams {
  return {
    engineRate: 0.55, engineOnVolume: 0, engineOffVolume: 0, engineSoloVolume: 0, squealVolume: 0, squealRate: 1,
    grassVolume: 0, gravelVolume: 0, kerbVolume: 0, surfaceRate: 1, scrapeVolume: 0,
  };
}

const engineRateMin = 0.55;
const engineRateMax = 1.9;
/** アクセル OFF のときの音量 (ON の 0.6 倍) */
const engineOffRatio = 0.6;
/** 路面の音を鳴らす最低速度 (px/秒) */
const surfaceSoundMinSpeed = 60;
/** この速度で路面の音量・再生速度が最大になる */
const surfaceSoundFullSpeed = 400;

/**
 * 毎フレーム呼ぶ。throttle は実際に車にかかっているアクセル量 (Controls.throttle、操作不能中は 0)
 */
export function computeCarSound(car: Car, gearbox: VirtualGearbox, throttle: number, out: CarSoundParams): CarSoundParams {
  // エンジン: ギア内の回転数でノコギリ形に上下させる。ON/OFF はアクセル量でクロスフェード
  out.engineRate = engineRateMin + (engineRateMax - engineRateMin) * gearbox.rpmRatio;
  const t = Math.max(0, Math.min(1, throttle));
  out.engineOnVolume = t;
  out.engineOffVolume = (1 - t) * engineOffRatio;
  out.engineSoloVolume = t + (1 - t) * engineOffRatio;

  out.squealVolume = car.squealVolume;
  out.squealRate = car.squealRate;

  const s = car.speed;
  const k = s < surfaceSoundMinSpeed ? 0 : Math.min(1, s / surfaceSoundFullSpeed);
  let grass = 0;
  let gravel = 0;
  let kerb = 0;
  for (const surface of car.wheelSurfaces) {
    if (surface === 'grass') grass++;
    else if (surface === 'gravel') gravel++;
    else if (surface === 'kerb') kerb++;
  }
  // 車輪 1 本でも乗っていれば聞こえるようにし、本数で大きくする
  const level = (wheels: number) => (wheels === 0 || k === 0 ? 0 : (0.2 + 0.8 * k) * (0.5 + 0.5 * (wheels / 4)));
  out.grassVolume = level(grass);
  out.gravelVolume = level(gravel);
  out.kerbVolume = level(kerb);
  out.surfaceRate = 0.8 + 0.4 * k;
  out.scrapeVolume = car.isScraping ? Math.min(1, 0.4 + s / 500) : 0;
  return out;
}

/** 壁との衝突の強さ J (px/秒) から、鳴らす音と画面揺れを決める */
export interface ImpactEffect {
  /** 'crash-wall' (強い) / 'tire-barrier-hit' (弱い) / null (鳴らさない) */
  sound: 'crash-wall' | 'tire-barrier-hit' | null;
  /** 音量 0.3〜1.0 */
  volume: number;
  /** 画面揺れの振幅 (px、2 px 単位)。0 なら揺らさない */
  shake: number;
  /** 火花の粒の数 (0 なら出さない) */
  sparks: number;
}

export function wallImpactEffect(impact: number, out: ImpactEffect): ImpactEffect {
  out.sound = impact >= 187.5 ? 'crash-wall' : impact >= 50 ? 'tire-barrier-hit' : null;
  out.volume = Math.min(1, 0.3 + 0.7 * Math.min(1, impact / 500));
  out.shake = impact >= 187.5 ? Math.round(Math.min(6, impact / 75) / 2) * 2 : 0;
  out.sparks = impact >= 50 ? Math.round(4 + 16 * Math.min(1, (impact - 50) / 450)) : 0;
  return out;
}
