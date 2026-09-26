import { raceRules } from './carParams';
import type { LapEvent } from './LapTracker';
import type { Controls } from './controls';
import type { RaceCar } from './RaceCar';
import type { RaceEvent } from './RaceSession';
import type { Pose } from './Track';

/**
 * 決勝の車 1 台の 1 フレームの手順 (入力を決めたあと): 反応時間、コース復帰、DRS、物理。
 * 1 人用 (RaceSession: 全車) とマルチ (NetRaceClient: 自車だけ) で同じ手順を使う。DOM に依存しない。
 * コンテキストは呼び出し側が 1 つ作って使い回す (毎フレームのオブジェクト生成を避ける)
 */
export interface RaceCarStepContext {
  dt: number;
  /** 消灯後か */
  isStarted: boolean;
  /** 前のフレームのセッション時刻 (反応時間の計算) */
  tPrev: number;
  /** 消灯の時刻 (セッションの時刻) */
  lightsOutAt: number;
  /** イベントを積む先 (RaceEvent を含む配列ならよい) */
  events: { push(e: RaceEvent): unknown };
  /** コース復帰を使えるか (PRESS R TO RESET の条件) */
  isResetAvailable: (rc: RaceCar) => boolean;
  /** ゴーストでない他車と重なっているか (ゴーストの期間の延長) */
  overlapsAny: (rc: RaceCar) => boolean;
  /** コース復帰の置き直しで出た周回のイベントを処理する */
  handleLapEvent: (rc: RaceCar, e: LapEvent) => void;
  /** 作業用 */
  readonly tmpPose: Pose;
}

/** 消灯前に物理へ渡す入力 (何も押していない) */
const gridControls: Readonly<Controls> = {
  throttle: 0,
  brake: 0,
  steerInput: 0,
  steerIsAnalog: false,
  drsPressed: false,
  resetPressed: false,
};

/** 発進できない間に物理へ渡す入力 (アクセルだけ 0 にした写し) */
const blockedControls: Controls = { ...gridControls };

/** rc.controls を決めたあとに呼ぶ。反応時間、コース復帰、DRS、物理を 1 フレーム進める */
export function driveRaceCar(rc: RaceCar, ctx: RaceCarStepContext): void {
  const car = rc.car;
  const events = ctx.events;
  if (!ctx.isStarted && (rc.controls.throttle > 0 || rc.controls.brake > 0)) rc.hasGridInput = true;
  if (ctx.isStarted && !rc.isLaunchChecked) {
    // 消灯の瞬間に踏んでいたら、離して踏み直すまで発進させない (反応時間も踏み直した瞬間から数える)
    rc.isLaunchChecked = true;
    if (rc.controls.throttle > 0 && rc.reactionTime === null) rc.isLaunchBlocked = true;
  }
  if (rc.isLaunchBlocked && rc.controls.throttle <= 0) rc.isLaunchBlocked = false;
  if (ctx.isStarted && !rc.isLaunchBlocked && rc.reactionTime === null && rc.controls.throttle > 0 && rc.status === 'racing') {
    rc.reactionTime = Math.max(0, ctx.tPrev - ctx.lightsOutAt);
    events.push({ type: 'reaction', carNumber: rc.carNumber, time: rc.reactionTime });
  }
  if (rc.controls.resetPressed && rc.resetTimer < 0 && rc.status !== 'retired') {
    if (ctx.isResetAvailable(rc)) {
      rc.resetTimer = 0;
      car.controlLocked = true;
      events.push({ type: 'resetStarted', carNumber: rc.carNumber });
    } else if (rc.isPlayer && ctx.isStarted) {
      events.push({ type: 'resetRejected', carNumber: rc.carNumber });
    }
  }
  updateResetProcedure(rc, ctx);
  rc.drs.isEligible = rc.isDrsEligible;
  rc.drs.update(car, rc.lap.projection.s);
  if (rc.wasInDrsZone && !rc.drs.isInZone) rc.isDrsEligible = false;
  rc.wasInDrsZone = rc.drs.isInZone;
  // 消灯までは車を動かさない (グリッドでアクセルを踏んでも空ぶかしだけ)
  let controls: Readonly<Controls> = gridControls;
  if (ctx.isStarted && rc.isLaunchBlocked) {
    Object.assign(blockedControls, rc.controls);
    blockedControls.throttle = 0;
    controls = blockedControls;
  } else if (ctx.isStarted) {
    controls = rc.controls;
  }
  car.update(controls, ctx.dt);
  rc.gearbox.update(car.isSpinning ? car.speed : car.sF);
  if (rc.drs.enabledOnEntry) events.push({ type: 'drsEnabled', carNumber: rc.carNumber });
  if (car.drsOpened) events.push({ type: 'drsOpened', carNumber: rc.carNumber });
  if (car.drsClosed) events.push({ type: 'drsClosed', carNumber: rc.carNumber });
}

/**
 * コース復帰 (game-design.md 7.11 節) とゴーストの期間 (7.10 節)。置き直してから操作再開 + 3 秒まではゴースト。
 * ピット出口後・復帰後のゴーストは、期間の終わりに他車と重なっていれば重ならなくなるまで延ばす
 */
export function updateResetProcedure(rc: RaceCar, ctx: RaceCarStepContext): void {
  const dt = ctx.dt;
  const fade = raceRules.resetFadeTime;
  if (rc.pitGhostRemaining > 0) {
    rc.pitGhostRemaining = Math.max(0, rc.pitGhostRemaining - dt);
    if (rc.pitGhostRemaining === 0 && ctx.overlapsAny(rc)) rc.pitGhostRemaining = 1e-3;
  }
  if (rc.resetTimer < 0) {
    if (rc.ghostTimeRemaining > 0) {
      rc.ghostTimeRemaining = Math.max(0, rc.ghostTimeRemaining - dt);
      if (rc.ghostTimeRemaining === 0 && ctx.overlapsAny(rc)) rc.ghostTimeRemaining = 1e-3;
    }
    return;
  }
  const car = rc.car;
  const before = rc.resetTimer;
  rc.resetTimer += dt;
  const t = rc.resetTimer;
  if (before < fade && t >= fade) {
    rc.lap.resetPose(ctx.tmpPose);
    car.placeAt(ctx.tmpPose);
    car.controlLocked = true;
    rc.driver?.resetTracking();
    for (const e of rc.lap.applyReset(car)) ctx.handleLapEvent(rc, e);
    rc.prevS = rc.lap.projection.s;
    ctx.events.push({ type: 'resetPlaced', carNumber: rc.carNumber });
  }
  const lockEnd = fade + raceRules.resetLockTime;
  rc.screenFade = t < fade ? t / fade : Math.max(0, 1 - (t - fade) / fade);
  rc.resetLockRemaining = t < fade ? raceRules.resetLockTime : Math.max(0, lockEnd - t);
  if (t >= lockEnd) {
    rc.resetTimer = -1;
    rc.screenFade = 0;
    rc.resetLockRemaining = 0;
    car.controlLocked = rc.status === 'retired';
    rc.ghostTimeRemaining = raceRules.resetGhostTime;
    ctx.events.push({ type: 'resetFinished', carNumber: rc.carNumber });
  }
}
