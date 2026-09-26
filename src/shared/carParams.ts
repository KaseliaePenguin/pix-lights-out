/**
 * 車の物理とレースのルールのパラメータ (car-physics.md 第 5 版 15 節、game-design.md 7・9 章)。
 * 数値を変えたら physicsVersion を上げる。コースデータを変えたときは、そのコースの TrackData.version を上げる。
 * ゴースト・自己ベストは、両方の組 (recordVersionOf) が保存時と違えば破棄する。
 */

/** 物理のバージョン番号。CarParams・路面テーブル・当たり判定の計算を変えたら上げる (2: 第 4 版、3: 第 4 版からドリフト・ERS を除いた版) */
export const physicsVersion = 3;

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
  /** 最高速の上乗せ (スリップストリーム + DRS) の合計の上限 */
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
  // 8 節: 路面
  surfaces: Readonly<Record<SurfaceKind, SurfaceParams>>;
  // 14 節: 演出
  squealStart: number;
  squealRange: number;
  squealMinSpeed: number;
  squealRateMin: number;
  squealRateGain: number;
  skidMarkUReq: number;
  skidMarkMinSpeed: number;
  lockupMarkTime: number;
  lockupMinSpeed: number;
  // 11 節: スリップストリーム (決勝だけ。fSlip は RaceSession が更新する)
  slipBonus: number;
  slipRange: number;
  slipRearOffset: number;
  slipAngle: number;
  slipHeading: number;
  slipMinSpeed: number;
  slipRate: number;
  // 12 節: DRS
  drsBonus: number;
  drsGripMul: number;
  drsRate: number;
  // 10 節: タイヤ (M2 までは摩耗なし。グリップの式だけ使う)
  compoundGrip: Readonly<Record<TyreCompound, number>>;
  wearRate: Readonly<Record<TyreCompound, number>>;
  cliffStart: number;
  wearSlope: number;
  cliffSlope: number;
  // 9 節: 接触
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
  // 7 節: スピン (短い = 壁への強い衝突、長い = 車同士の接触)
  spinTimeLight: number;
  spinYawLight: number;
  spinDecelLight: number;
  spinTimeContact: number;
  spinYaw: number;
  spinDecel: number;
  pairCooldown: number;
  // 13 節: ピットレーン
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
 * car-physics.md 第 5 版の初期値 (第 4 版からドリフト・ERS ブーストを除いたもの)。ただし brakeDecel・steerRise・yawMaxLow は、
 * ユーザーが調整パネルで選んだ値。ユーザーの「緩やかな操作」に合わせて steerReturn も穏やかにした (仕様の値は specCarParamValues)。
 * 調整パネルがこのオブジェクトを書き換えるので、車は毎フレームここを読む
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

/** 最初の案の値のうち、ユーザーの選んだ値で置き換えたもの (car-physics.md 第 5 版の表の括弧内。sim で比べるときに使う) */
export const specCarParamValues: Readonly<Partial<CarParams>> = {
  brakeDecel: 650,
  steerRise: 15,
  steerReturn: 20,
  yawMaxLow: 3.6,
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
  kmhPerPxPerSec: 0.6,
};

/** 決勝のルール (game-design.md 7.2〜7.7・7.10 節、car-physics.md 12 節) */
export interface RaceSessionRules {
  /** スタートランプ: グリッドに並んでから最初の点灯まで・点灯の間隔・ユニット数 */
  firstLampDelay: number;
  lampInterval: number;
  lampCount: number;
  /** 5 つ点灯してから消灯までのランダムな待ち (一様分布) */
  lightsOutWaitMin: number;
  lightsOutWaitMax: number;
  /** フライング: グリッド位置からこの距離以上動いたら成立。罰則 (ゴールタイムに加算) */
  jumpStartDistance: number;
  jumpStartPenalty: number;
  /** 先頭のゴールからこの秒数でゴールしていない車は未完走 */
  finishTimeout: number;
  /** 周回遅れの関係 (ゴースト): 進行距離の差が 1 周のこの割合以上 */
  lappedGhostRatio: number;
  /** BLUE FLAG: 周回遅れにする側の車が後ろこの距離 (中心線沿い) 以内に来た */
  blueFlagDistance: number;
  /** ピット出口を出てからゴーストでいる時間 */
  pitExitGhostTime: number;
  /** 決勝の DRS: 検知ラインで前の車との差がこの秒数以内。この周回以降 */
  drsGapThreshold: number;
  drsMinLap: number;
  /** 予選をスキップしたときの CPU の予選タイム (7.8 節): 基準 × (1 + (1 − 腕前) × 係数) + 乱数 */
  qualifyingSkillFactor: number;
  qualifyingNoiseMin: number;
  qualifyingNoiseMax: number;
}

export const raceSessionRules: Readonly<RaceSessionRules> = {
  firstLampDelay: 1.0,
  lampInterval: 1.0,
  lampCount: 5,
  lightsOutWaitMin: 0.5,
  lightsOutWaitMax: 2.5,
  jumpStartDistance: 5,
  jumpStartPenalty: 3,
  finishTimeout: 30,
  lappedGhostRatio: 0.5,
  blueFlagDistance: 190,
  pitExitGhostTime: 1.0,
  drsGapThreshold: 1.0,
  drsMinLap: 2,
  qualifyingSkillFactor: 1.2,
  qualifyingNoiseMin: -0.2,
  qualifyingNoiseMax: 0.4,
};

export type CpuDifficulty = 'easy' | 'normal' | 'hard';

/** CPU の難易度ごとの値 (game-design.md 9.2 節) */
export interface CpuDifficultyParams {
  /** 腕前 (目標速度とブレーキの倍率) */
  skill: number;
  /** コーナーごとにブレーキ開始が遅れる確率 */
  mistakeRate: number;
  /** スタートの反応時間の範囲 (秒) */
  reactionMin: number;
  reactionMax: number;
}

/** CPU の走り方 (game-design.md 9 章)。仕様にない値は実装で決めたもの (★) */
export interface CpuParams {
  difficulties: Readonly<Record<CpuDifficulty, CpuDifficultyParams>>;
  /** 個体差: 腕前に ±この値の一様乱数を足す */
  skillSpread: number;
  /** ミスのときにブレーキ開始が遅れる距離 (px) */
  mistakeDelay: number;
  /** ★ ミスを抽選する範囲: コーナーの円弧の手前この距離から */
  mistakeWindow: number;
  /** 追い抜き: 前の車がこの距離 (中心間、前方向) 以内で自分より遅いとき、ラインを最大 overtakeOffset ずらす (最大 overtakeTime 秒) */
  overtakeRange: number;
  overtakeOffset: number;
  overtakeTime: number;
  /** ★ 追い抜きのあと、次の追い抜きを始めるまでの間 (秒) と、ラインをずらす速さ (px/秒) */
  overtakeCooldown: number;
  overtakeShiftRate: number;
  /** ★ 「前にいる」とみなす横の幅 (自車の中心線からの距離、px) */
  aheadLateral: number;
  /** 追突回避: 前の車との隙間 (車の長さを除く) がこの距離以内で近づいているときはブレーキ */
  avoidGap: number;
  /** ★ 追突回避の先読み: 隙間の中で止まるのに要る減速度が brakeDecel × この値を超えたらブレーキ */
  avoidDecelRatio: number;
  /** スタック: この速度未満がこの秒数続いたらコース復帰 */
  stuckSpeed: number;
  stuckTime: number;
}

export const cpuParams: Readonly<CpuParams> = {
  difficulties: {
    easy: { skill: 0.88, mistakeRate: 0.08, reactionMin: 0.3, reactionMax: 0.4 },
    normal: { skill: 0.94, mistakeRate: 0.04, reactionMin: 0.2, reactionMax: 0.32 },
    hard: { skill: 0.98, mistakeRate: 0.015, reactionMin: 0.15, reactionMax: 0.25 },
  },
  skillSpread: 0.01,
  mistakeDelay: 37.5,
  mistakeWindow: 700,
  overtakeRange: 100,
  overtakeOffset: 25,
  overtakeTime: 3,
  overtakeCooldown: 1.5,
  overtakeShiftRate: 50,
  aheadLateral: 24,
  avoidGap: 50,
  avoidDecelRatio: 0.6,
  stuckSpeed: 62.5,
  stuckTime: 2,
};

/** タイヤのグリップ倍率 (car-physics.md 10.1 節) */
export function tyreGrip(params: Readonly<CarParams>, compound: TyreCompound, wear: number): number {
  const w = Math.min(Math.max(wear, 0), 1);
  const wearFactor = w < params.cliffStart
    ? 1 - params.wearSlope * w
    : 1 - params.wearSlope * params.cliffStart - params.cliffSlope * (w - params.cliffStart);
  return params.compoundGrip[compound] * wearFactor;
}
