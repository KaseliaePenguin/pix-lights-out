import type { RaceSessionRules } from '../carParams';
import { raceSessionRules } from '../carParams';
import { Random } from '../Random';

/**
 * オンライン対戦のレース進行の値 (network.md「同期方式」「切断時の扱い」「ホストによる判定と不正対策」)。
 * 時間は ms (ホスト時刻と同じ単位)。仕様にない値は実装で決めたもの (★)。DOM に依存しない
 */
export const netRaceRules = {
  /** 参加者が carState を送る間隔 (30 回/秒) */
  stateIntervalMs: 1000 / 30,
  /** ホストがスナップショットを送る間隔 (30 回/秒) */
  snapshotIntervalMs: 1000 / 30,
  /** 他車を何 ms 過去の状態で補間して表示するか */
  interpolationDelayMs: 100,
  /** 自車からこの距離 (車 3 台分、px) 以内の他車は、最新の状態と速度から今の位置を予測して表示・判定する */
  predictRadius: 3 * 38,
  /** ★ 予測で先へ進める時間の上限 (状態が途切れた車が走り去って見えないように) */
  predictMaxMs: 250,
  /** 状態が届かない車: この時間でゴースト、この時間でリタイア */
  staleGhostMs: 3000,
  staleRetireMs: 60 * 1000,
  /** 参加者: この時間スナップショットが届かなければホストとの接続が切れたとみなす */
  hostSilenceMs: 3000,
  /** 受け取った collision は、接触時刻からこの時間を過ぎていれば適用しない */
  collisionMaxAgeMs: 250,
  /** ★ ホストが collision を中継する条件: 2 台の最後の位置がこの距離 (px) 以内 (離れた車を押す不正を防ぐ) */
  collisionRelayDistance: 200,
  /** 受信頻度の上限 (1 人あたり 1 秒の窓で数える)。超えた分は捨て、超える状態が続いたら切断する */
  stateRateLimit: 60,
  eventRateLimit: 20,
  rateViolationKickMs: 10 * 1000,
  /** ★ ありえない移動の判定: 速さの上限 = 基本の最高速 × (1 + 上乗せの上限) × この倍率 */
  speedLimitFactor: 1.3,
  /** ★ 移動量の余裕 (px)。位置の丸め・壁の押し戻しの分 */
  moveSlackPx: 30,
  /** ★ 直前に接触があった車は、この時間だけ速さの上限をこの倍率に緩める */
  collisionLeniencyMs: 1000,
  collisionLeniencyFactor: 2,
  /** ★ コース復帰の置き直しとして受け付ける距離 (ホストの判定した置き直し先からの px) */
  resetSnapRadius: 400,
  /** ★ carState の時刻は、ホストの今の時刻よりこれ以上先なら今の時刻に丸める (時刻を先へずらす不正を防ぐ) */
  maxStateLeadMs: 100,
  /** ★ スナップショットで、状態の時刻からスナップショットの時刻まで位置を進める上限 */
  snapshotExtrapolateMaxMs: 100,
  /** ★ raceStart を送ってからグリッドに並ぶまで (全員に届くまでの余裕) */
  raceStartLeadMs: 1500,
  /** ★ ロビーで参加者一覧 (往復遅延・接続経路) を送り直す間隔 */
  lobbyRefreshMs: 2000,
  /** ★ reject (バージョン違い・レース中) を送ってから切断するまで (reject が先に届くように) */
  rejectKickDelayMs: 1000,
  /** ★ 参加者の時計合わせ: 自分のシミュレーション時刻とホスト時刻のずれがこれを超えたら合わせ直す */
  timeSnapMs: 250,
  /** ★ それ以下のずれは 1 フレームにこの割合ずつ寄せる */
  timeSlewRate: 0.05,
} as const;

/** スタートの時刻表 (すべてホスト時刻 ms) */
export interface RaceStartSchedule {
  /** グリッドに並んだ時刻 (セッションの時刻 0) */
  gridAt: number;
  /** スタートランプ k 個目 (1〜5) の点灯時刻。lampAt[k - 1] */
  lampAt: number[];
  /** 全消灯 = スタート */
  lightsOutAt: number;
}

/** 5 つ点灯してから消灯までの待ち時間 (秒、0.5〜2.5 の一様乱数)。seed から決めるので全員で一致する */
export function lightsOutWaitOf(seed: number, rules: Readonly<RaceSessionRules> = raceSessionRules): number {
  return new Random(seed).range(rules.lightsOutWaitMin, rules.lightsOutWaitMax);
}

/** グリッドに並んでから消灯までの時間 (秒) */
export function gridToLightsOutOf(seed: number, rules: Readonly<RaceSessionRules> = raceSessionRules): number {
  return rules.firstLampDelay + rules.lampInterval * (rules.lampCount - 1) + lightsOutWaitOf(seed, rules);
}

/** raceStart の startTime (消灯の時刻) と seed から、グリッド・ランプの時刻を決める (ホスト・参加者で同じ計算) */
export function raceStartSchedule(startTime: number, seed: number, rules: Readonly<RaceSessionRules> = raceSessionRules): RaceStartSchedule {
  const gridAt = startTime - gridToLightsOutOf(seed, rules) * 1000;
  const lampAt: number[] = [];
  for (let k = 1; k <= rules.lampCount; k++) lampAt.push(gridAt + (rules.firstLampDelay + rules.lampInterval * (k - 1)) * 1000);
  return { gridAt, lampAt, lightsOutAt: startTime };
}
