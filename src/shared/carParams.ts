/**
 * 車の物理とレースのルールのパラメータ (car-physics.md 第 4 版 18 節、game-design.md 7 章)。
 * 数値を変えたら physicsVersion を上げる。コースデータを変えたときは、そのコースの TrackData.version を上げる。
 * ゴースト・自己ベストは、両方の組 (recordVersionOf) が保存時と違えば破棄する。
 */

/** 物理のバージョン番号。CarParams・路面テーブル・当たり判定の計算を変えたら上げる (2: car-physics.md 第 4 版) */
export const physicsVersion = 2;

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
  // 5 節: 前後方向
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
  /** 最高速の上乗せ (スリップストリーム + DRS + ブースト) の合計の上限 */
  bonusCap: number;
  // 4 節: ステア
  steerRise: number;
  steerReturn: number;
  padSteerDeadzone: number;
  padSteerCurve: number;
  padTriggerDeadzone: number;
  // 6 節: グリップ走行
  latGrip: number;
  yawMaxLow: number;
  yawRampSpeed: number;
  steerDemand: number;
  /** 限界を超えたときに曲がりを削る強さ (yawCmd / uReq^この値)。1 で第 3 版と同じ、0 で削らない */
  understeerSoftness: number;
  scrubRate: number;
  scrubMax: number;
  brakeGripLoss: number;
  lateralDecay: number;
  /** 見た目の滑り角 (6.5 節) の開始 uReq・傾き (rad / uReq)・上限 */
  visualSlipStart: number;
  visualSlipGain: number;
  visualSlipMax: number;
  // 7 節: ドリフト
  driftEnterBrake: number;
  driftEnterSteer: number;
  driftEnterSpeed: number;
  /** ブレーキ・ハンドル・速さの条件がこの時間そろい続けたらドリフトに入る (一瞬のブレーキで急に滑らないように) */
  driftEnterTime: number;
  driftKickAngle: number;
  driftAngleNeutral: number;
  driftAngleIn: number;
  driftAngleThrottle: number;
  driftAngleBrake: number;
  driftBrakeGrace: number;
  driftReleaseTime: number;
  driftAngleResponse: number;
  driftLatLow: number;
  driftLatHigh: number;
  driftGainSpeedLow: number;
  driftGainSpeedHigh: number;
  driftAngleRef: number;
  driftLatMaxFactor: number;
  driftDrag: number;
  driftThrottleMul: number;
  driftBrakeMul: number;
  driftExitAngle: number;
  driftExitTime: number;
  driftMinSpeed: number;
  /** コース外の車輪がこの数以上でドリフトが終わる */
  driftExitOffWheels: number;
  /** この強さ以上の衝撃でドリフトが終わる (px/秒) */
  driftExitImpulse: number;
  // 9 節: ドリフトのやりすぎによるスピン
  driftSpinAngle: number;
  driftSpinTime: number;
  /** スピンの兆候を見せる角度 (16 節) */
  driftSpinWarnAngle: number;
  // 8 節: ERS とブースト
  ersMinAngle: number;
  ersMaxOffWheels: number;
  /** 段階 1〜3 になる溜まり (秒) */
  ersTierTime: number[];
  /** 段階 1〜3 のブーストの追加の加速 (px/秒²)・最高速の上乗せ・続く時間 (秒) */
  boostAccel: number[];
  boostTop: number[];
  boostTime: number[];
  // 10 節: 路面
  surfaces: Readonly<Record<SurfaceKind, SurfaceParams>>;
  // 16 節: 演出
  squealStart: number;
  squealRange: number;
  squealMinSpeed: number;
  squealRateMin: number;
  squealRateGain: number;
  squealFadeTime: number;
  /** ドリフト中のスキール音: 基本の音量。driftSquealAngle の角度で最大になる */
  driftSquealBase: number;
  driftSquealAngle: number;
  skidMarkUReq: number;
  skidMarkMinSpeed: number;
  /** ドリフト中、この角度以上で前輪からもタイヤ痕 */
  driftFrontMarkAngle: number;
  lockupMarkTime: number;
  lockupMinSpeed: number;
  /** ドリフトのスモーク: 速度の下限と、量の基準 (beta / smokeAngleRef × s / smokeSpeedRef) */
  smokeMinSpeed: number;
  smokeAngleRef: number;
  smokeSpeedRef: number;
  // 13 節: スリップストリーム (M2 で使う。M1 では fSlip は常に 0)
  slipBonus: number;
  slipRange: number;
  slipRearOffset: number;
  slipAngle: number;
  slipHeading: number;
  slipMinSpeed: number;
  slipRate: number;
  // 14 節: DRS
  drsBonus: number;
  drsGripMul: number;
  drsRate: number;
  // 12 節: タイヤ (M1 は摩耗なし。グリップの式だけ使う)
  compoundGrip: Readonly<Record<TyreCompound, number>>;
  wearRate: Readonly<Record<TyreCompound, number>>;
  cliffStart: number;
  wearSlope: number;
  cliffSlope: number;
  driftWearLoad: number;
  // 11 節: 接触
  restitution: number;
  attackerMargin: number;
  attackerLossMax: number;
  attackerLossDiv: number;
  wallRestitution: number;
  wallTangentLossDiv: number;
  wallTangentLossMax: number;
  wallAlignMaxAngle: number;
  wallAlignRate: number;
  spinImpulseCar: number;
  spinImpulseWall: number;
  spinWallMinAngle: number;
  // 9 節: スピン (短い = ドリフト・壁、長い = 車同士の接触)
  spinTimeLight: number;
  spinYawLight: number;
  spinDecelLight: number;
  spinTimeContact: number;
  spinYaw: number;
  spinDecel: number;
  pairCooldown: number;
  // 15 節
  pitSpeedLimit: number;
  // 1 節: 寸法
  hitWidth: number;
  hitLength: number;
  wheelFront: number;
  wheelRear: number;
  wheelSide: number;
}

const deg = Math.PI / 180;

/**
 * car-physics.md 第 4 版の初期値。ただし brakeDecel・steerRise・yawMaxLow は、ユーザーが調整パネルで選んだ値。
 * ユーザーの「緩やかな操作」に合わせて steerReturn・driftKickAngle・driftAngleResponse・driftReleaseTime も調整し、
 * driftEnterTime を足した (仕様の値は specCarParamValues)。調整パネルがこのオブジェクトを書き換えるので、車は毎フレームここを読む
 */
export const carParams: Readonly<CarParams> = {
  vBase: 525,
  accel0: 500,
  brakeDecel: 312.5,
  coastBase: 37.5,
  coastDrag: 87.5,
  reverseAccel: 187.5,
  reverseMax: 112.5,
  reverseDelay: 0.3,
  reverseEnterSpeed: 6,
  bonusCap: 0.25,
  steerRise: 3.5,
  steerReturn: 6,
  padSteerDeadzone: 0.15,
  padSteerCurve: 1.5,
  padTriggerDeadzone: 0.05,
  latGrip: 750,
  yawMaxLow: 2.0,
  yawRampSpeed: 40,
  steerDemand: 1.0,
  understeerSoftness: 0.5,
  scrubRate: 0.25,
  scrubMax: 80,
  brakeGripLoss: 0.2,
  lateralDecay: 1200,
  visualSlipStart: 0.9,
  visualSlipGain: 25 * deg,
  visualSlipMax: 6 * deg,
  driftEnterBrake: 0.3,
  driftEnterSteer: 0.5,
  driftEnterSpeed: 200,
  driftEnterTime: 0.08,
  driftKickAngle: 5 * deg,
  driftAngleNeutral: 20 * deg,
  driftAngleIn: 45 * deg,
  driftAngleThrottle: 5 * deg,
  driftAngleBrake: 12 * deg,
  driftBrakeGrace: 0.4,
  driftReleaseTime: 0.3,
  driftAngleResponse: 6,
  driftLatLow: 1.25,
  driftLatHigh: 0.75,
  driftGainSpeedLow: 250,
  driftGainSpeedHigh: 450,
  driftAngleRef: 40 * deg,
  driftLatMaxFactor: 1.25,
  driftDrag: 260,
  driftThrottleMul: 0.85,
  driftBrakeMul: 0.5,
  driftExitAngle: 6 * deg,
  driftExitTime: 0.1,
  driftMinSpeed: 120,
  driftExitOffWheels: 3,
  driftExitImpulse: 187.5,
  driftSpinAngle: 52 * deg,
  driftSpinTime: 0.35,
  driftSpinWarnAngle: 48 * deg,
  ersMinAngle: 15 * deg,
  ersMaxOffWheels: 2,
  ersTierTime: [0.5, 1.1, 1.8],
  boostAccel: [150, 200, 250],
  boostTop: [0.04, 0.06, 0.08],
  boostTime: [0.5, 0.8, 1.1],
  surfaces: {
    asphalt: { grip: 1.0, brake: 1.0, accel: 1.0, speedCap: Infinity, capDecel: 0, isOffTrack: false },
    kerb: { grip: 0.97, brake: 0.95, accel: 1.0, speedCap: Infinity, capDecel: 0, isOffTrack: false },
    pit: { grip: 1.0, brake: 1.0, accel: 1.0, speedCap: Infinity, capDecel: 0, isOffTrack: false },
    grass: { grip: 0.7, brake: 0.55, accel: 0.75, speedCap: 260, capDecel: 400, isOffTrack: true },
    gravel: { grip: 0.5, brake: 0.45, accel: 0.6, speedCap: 180, capDecel: 500, isOffTrack: true },
  },
  squealStart: 0.95,
  squealRange: 0.25,
  squealMinSpeed: 150,
  squealRateMin: 0.9,
  squealRateGain: 0.25,
  squealFadeTime: 0.15,
  driftSquealBase: 0.6,
  driftSquealAngle: 45 * deg,
  skidMarkUReq: 1.0,
  skidMarkMinSpeed: 187.5,
  driftFrontMarkAngle: 25 * deg,
  lockupMarkTime: 0.25,
  lockupMinSpeed: 375,
  smokeMinSpeed: 150,
  smokeAngleRef: 45 * deg,
  smokeSpeedRef: 400,
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
  driftWearLoad: 1.3,
  restitution: 0.2,
  attackerMargin: 25,
  attackerLossMax: 0.3,
  attackerLossDiv: 1000,
  wallRestitution: 0.3,
  wallTangentLossDiv: 1000,
  wallTangentLossMax: 0.35,
  wallAlignMaxAngle: 35 * deg,
  wallAlignRate: 6,
  spinImpulseCar: 375,
  spinImpulseWall: 500,
  spinWallMinAngle: 60 * deg,
  spinTimeLight: 0.6,
  spinYawLight: 6,
  spinDecelLight: 450,
  spinTimeContact: 1.0,
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

/** car-physics.md 第 4 版の仕様の値のうち、ユーザーの選んだ値で置き換えたもの (sim で比べるときに使う) */
export const specCarParamValues: Readonly<Partial<CarParams>> = {
  brakeDecel: 650,
  steerRise: 15,
  steerReturn: 20,
  yawMaxLow: 3.6,
  driftKickAngle: 8 * deg,
  driftAngleResponse: 8,
  driftReleaseTime: 0.4,
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
  soloStartDistance: 600,
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
