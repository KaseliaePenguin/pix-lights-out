/**
 * 車の物理とレースのルールのパラメータ (car-physics.md 14 章、game-design.md 7 章)。
 * 数値を変えたら physicsVersion を上げる。コースデータを変えたときは、そのコースの TrackData.version を上げる。
 * ゴースト・自己ベストは、両方の組 (recordVersionOf) が保存時と違えば破棄する。
 */

/** 物理のバージョン番号。CarParams・路面テーブル・当たり判定の計算を変えたら上げる */
export const physicsVersion = 1;

/**
 * 自己ベスト・ゴーストが今のゲームで使えるかを表す文字列 (`物理のバージョン-コースのバージョン`)。
 * セーブデータにはこれを渡して保存し、読むときに違えば破棄する
 */
export function recordVersionOf(track: { readonly version: number }): string {
  return `${physicsVersion}-${track.version}`;
}

export type SurfaceKind = 'asphalt' | 'kerb' | 'pit' | 'grass' | 'gravel';

export interface SurfaceParams {
  grip: number;
  brake: number;
  accel: number;
  /** この速度を超えていると追加減速がかかる (px/秒)。Infinity なら無し */
  speedCap: number;
  /** 上限を超えているときの追加減速 (px/秒²) */
  capDecel: number;
  /** コース外 (芝生・砂利) なら true */
  isOffTrack: boolean;
}

export type TyreCompound = 'soft' | 'hard';

export interface CarParams {
  // 5 章: 前後方向
  vBase: number;
  accel0: number;
  brakeDecel: number;
  coastBase: number;
  coastDrag: number;
  reverseAccel: number;
  reverseMax: number;
  reverseDelay: number;
  /** 後退に入れる速度の上限 (sF がこれ以下) */
  reverseEnterSpeed: number;
  // 4 章: ステア
  steerRise: number;
  steerReturn: number;
  padSteerDeadzone: number;
  padSteerCurve: number;
  padTriggerDeadzone: number;
  // 6 章: 旋回
  latGrip: number;
  yawMaxLow: number;
  yawRampSpeed: number;
  steerDemand: number;
  scrubRate: number;
  scrubMax: number;
  brakeGripLoss: number;
  lateralDecay: number;
  /** 見た目の滑り角 (6.5 節) の開始 uReq・傾き (rad / uReq)・上限 */
  visualSlipStart: number;
  visualSlipGain: number;
  visualSlipMax: number;
  // 7 章: 路面
  surfaces: Readonly<Record<SurfaceKind, SurfaceParams>>;
  // 8 章: 演出
  squealStart: number;
  squealRange: number;
  squealMinSpeed: number;
  squealRateMin: number;
  squealRateGain: number;
  squealFadeTime: number;
  skidMarkUReq: number;
  skidMarkMinSpeed: number;
  lockupMarkTime: number;
  lockupMinSpeed: number;
  // 11 章: スリップストリーム (M2 で使う。M1 では fSlip は常に 0)
  slipBonus: number;
  slipRange: number;
  slipRearOffset: number;
  slipAngle: number;
  slipHeading: number;
  slipMinSpeed: number;
  slipRate: number;
  // 12 章: DRS
  drsBonus: number;
  drsGripMul: number;
  drsRate: number;
  // 10 章: タイヤ (M1 は摩耗なし。グリップの式だけ使う)
  compoundGrip: Readonly<Record<TyreCompound, number>>;
  wearRate: Readonly<Record<TyreCompound, number>>;
  cliffStart: number;
  wearSlope: number;
  cliffSlope: number;
  // 9 章: 接触
  restitution: number;
  attackerMargin: number;
  attackerLossMax: number;
  attackerLossDiv: number;
  wallTangentLossDiv: number;
  wallRestitution: number;
  spinImpulseCar: number;
  spinImpulseWall: number;
  spinWallMinAngle: number;
  spinTime: number;
  spinYaw: number;
  spinDecel: number;
  pairCooldown: number;
  // 13 章
  pitSpeedLimit: number;
  // 1 章: 寸法
  hitWidth: number;
  hitLength: number;
  wheelFront: number;
  wheelRear: number;
  wheelSide: number;
}

const deg = Math.PI / 180;

export const carParams: Readonly<CarParams> = {
  vBase: 525,
  accel0: 450,
  brakeDecel: 562.5,
  coastBase: 37.5,
  coastDrag: 87.5,
  reverseAccel: 187.5,
  reverseMax: 112.5,
  reverseDelay: 0.3,
  reverseEnterSpeed: 6,
  steerRise: 6.0,
  steerReturn: 10.0,
  padSteerDeadzone: 0.15,
  padSteerCurve: 1.5,
  padTriggerDeadzone: 0.05,
  latGrip: 562.5,
  yawMaxLow: 3.0,
  yawRampSpeed: 50,
  steerDemand: 1.15,
  scrubRate: 0.5,
  scrubMax: 150,
  brakeGripLoss: 0.25,
  lateralDecay: 750,
  visualSlipStart: 0.9,
  visualSlipGain: 25 * deg,
  visualSlipMax: 6 * deg,
  surfaces: {
    asphalt: { grip: 1.0, brake: 1.0, accel: 1.0, speedCap: Infinity, capDecel: 0, isOffTrack: false },
    kerb: { grip: 0.92, brake: 0.9, accel: 1.0, speedCap: Infinity, capDecel: 0, isOffTrack: false },
    pit: { grip: 1.0, brake: 1.0, accel: 1.0, speedCap: Infinity, capDecel: 0, isOffTrack: false },
    grass: { grip: 0.6, brake: 0.5, accel: 0.7, speedCap: 225, capDecel: 437.5, isOffTrack: true },
    gravel: { grip: 0.45, brake: 0.4, accel: 0.5, speedCap: 137.5, capDecel: 687.5, isOffTrack: true },
  },
  squealStart: 0.9,
  squealRange: 0.3,
  squealMinSpeed: 150,
  squealRateMin: 0.9,
  squealRateGain: 0.25,
  squealFadeTime: 0.15,
  skidMarkUReq: 1.0,
  skidMarkMinSpeed: 187.5,
  lockupMarkTime: 0.25,
  lockupMinSpeed: 375,
  slipBonus: 0.08,
  slipRange: 150,
  slipRearOffset: 19,
  slipAngle: 20 * deg,
  slipHeading: 30 * deg,
  slipMinSpeed: 250,
  slipRate: 2.0,
  drsBonus: 0.1,
  drsGripMul: 0.9,
  drsRate: 5.0,
  compoundGrip: { soft: 1.08, hard: 0.96 },
  wearRate: { soft: 0.0155, hard: 0.0064 },
  cliffStart: 0.7,
  wearSlope: 0.08,
  cliffSlope: 0.5,
  restitution: 0.2,
  attackerMargin: 25,
  attackerLossMax: 0.3,
  attackerLossDiv: 1000,
  wallTangentLossDiv: 750,
  wallRestitution: 0.2,
  spinImpulseCar: 375,
  spinImpulseWall: 437.5,
  spinWallMinAngle: 45 * deg,
  spinTime: 1.0,
  spinYaw: 8,
  spinDecel: 625,
  pairCooldown: 0.2,
  pitSpeedLimit: 225,
  hitWidth: 18,
  hitLength: 38,
  wheelFront: 13,
  wheelRear: 12,
  wheelSide: 8,
};

/**
 * 起動時の carParams の複製 (開発時の調整パネルで「既定値に戻す」の基準)。carParams を書き換えても変わらない
 */
export const defaultCarParams: Readonly<CarParams> = structuredClone(carParams);

/**
 * 開発時の調整パネル用: carParams の数値の項目を実行時に書き換える (path は ['latGrip'] や ['surfaces', 'grass', 'grip'])。
 * Car などは carParams を参照で持っているので、次のフレームから新しい値で走る。
 * 数値でない項目・存在しない項目は変えずに false を返す
 */
export function setCarParam(path: readonly string[], value: number): boolean {
  if (path.length === 0 || !Number.isFinite(value)) return false;
  let node: unknown = carParams;
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof node !== 'object' || node === null) return false;
    node = (node as Record<string, unknown>)[path[i]];
  }
  if (typeof node !== 'object' || node === null) return false;
  const record = node as Record<string, unknown>;
  const key = path[path.length - 1];
  if (typeof record[key] !== 'number') return false;
  record[key] = value;
  return true;
}

/** レースのルール・判定の数値 (game-design.md 7・10 章) */
export interface RaceRules {
  /** 固定タイムステップ (秒) */
  step: number;
  checkpointSpacing: number;
  timingLineSpacing: number;
  /** 逆走: 進行方向との差 (rad)・前進速度・継続時間 */
  wrongWayAngle: number;
  wrongWaySpeed: number;
  wrongWayTime: number;
  /** コース復帰の条件 */
  resetSlowSpeed: number;
  resetSlowTime: number;
  resetOffTrackTime: number;
  /** コース復帰の手順 */
  resetBackDistance: number;
  resetFadeTime: number;
  resetLockTime: number;
  resetGhostTime: number;
  /** 予選・タイムアタックの開始位置 (コントロールラインの手前) とカウントダウン */
  soloStartDistance: number;
  countdownTime: number;
  /** ゴーストの記録頻度 (回/秒) */
  ghostRate: number;
  /** カメラ (10.5 節) */
  cameraLookAhead: number;
  cameraLookAheadMax: number;
  cameraFollowRate: number;
  cameraBoundX: number;
  cameraBoundY: number;
  /** 速度表示の換算 (km/h = px/秒 × この値) */
  kmhPerPxPerSec: number;
}

export const raceRules: Readonly<RaceRules> = {
  step: 1 / 60,
  checkpointSpacing: 750,
  timingLineSpacing: 250,
  wrongWayAngle: 120 * deg,
  wrongWaySpeed: 37.5,
  wrongWayTime: 1.0,
  resetSlowSpeed: 62.5,
  resetSlowTime: 1.0,
  resetOffTrackTime: 1.5,
  resetBackDistance: 150,
  resetFadeTime: 0.3,
  resetLockTime: 1.5,
  resetGhostTime: 3.0,
  soloStartDistance: 875,
  countdownTime: 3,
  ghostRate: 30,
  cameraLookAhead: 0.4,
  cameraLookAheadMax: 190,
  cameraFollowRate: 4,
  cameraBoundX: 250,
  cameraBoundY: 170,
  kmhPerPxPerSec: 0.6,
};

/** タイヤのグリップ倍率 (car-physics.md 10.1 節) */
export function tyreGrip(params: Readonly<CarParams>, compound: TyreCompound, wear: number): number {
  const w = Math.min(Math.max(wear, 0), 1);
  const wearFactor = w < params.cliffStart
    ? 1 - params.wearSlope * w
    : 1 - params.wearSlope * params.cliffStart - params.cliffSlope * (w - params.cliffStart);
  return params.compoundGrip[compound] * wearFactor;
}
