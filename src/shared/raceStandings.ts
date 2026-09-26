import type { RaceSessionRules } from './carParams';
import type { RaceCar } from './RaceCar';
import { gapLeader, gapNone, gapOut, gapPit } from './RaceCar';
import type { RaceGap } from './raceGap';
import type { RaceResult } from './RaceSession';
import type { TimingResult } from './TimeAttackSession';
import type { Track } from './Track';

/**
 * 決勝の順位・タイム差・結果の判定 (game-design.md 7.5・7.7・7.10 節)。RaceCar の値だけを見る純粋な計算で、
 * 1 人用 (全車をこの端末で計算) とマルチ (ホストの判定・参加者の表示) の両方から使う。DOM に依存しない。
 */

/**
 * 進行距離 P = (周 − 1) × 1 周の長さ + 中心線上の位置。中心線上の位置は「直前のチェックポイント〜次のチェックポイント」の
 * 間に制限する (ショートカットで順位が上がって見えないように)。lap は LapTracker.lap (まだコントロールラインを通っていなければ 0)
 */
export function raceDistanceOf(track: Track, lap: number, nextCheckpoint: number, s: number): number {
  const cps = track.checkpoints;
  const n = cps.length;
  const next = ((nextCheckpoint % n) + n) % n;
  const prevS = cps[(next - 1 + n) % n].s;
  const span = track.deltaS(prevS, cps[next].s);
  const d = Math.max(0, Math.min(span, track.deltaS(prevS, s)));
  // 1 周の中の位置は、次のチェックポイントが 0 (コントロールライン) なら最後の区間 (L の手前)
  return (lap - 1) * track.length + prevS + d;
}

/** 順位の比較 (負なら a が前)。ゴールした車は周回数とゴール順、走っている車は進行距離、リタイアは最後 */
export function compareStanding(a: RaceCar, b: RaceCar): number {
  const ra = a.status === 'retired' ? 1 : 0;
  const rb = b.status === 'retired' ? 1 : 0;
  if (ra !== rb) return ra - rb;
  // ゴールした車の進行距離は「終えた周回 × 1 周」で止めてあるので、同じ周回どうしはゴール順になる
  if (a.distance !== b.distance) return b.distance - a.distance;
  const fa = a.finishOrder < 0 ? Infinity : a.finishOrder;
  const fb = b.finishOrder < 0 ? Infinity : b.finishOrder;
  return fa === fb ? 0 : fa - fb;
}

/**
 * order を並べ替え (安定な挿入ソート。同じ値なら前のフレームの並びを保つ)、各車の position と orderNumbers を更新する
 */
export function sortStandings(order: RaceCar[], orderNumbers: number[]): void {
  for (let i = 1; i < order.length; i++) {
    const x = order[i];
    let j = i - 1;
    while (j >= 0 && compareStanding(order[j], x) > 0) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = x;
  }
  for (let i = 0; i < order.length; i++) {
    order[i].position = i + 1;
    orderNumbers[i] = order[i].carNumber;
  }
  orderNumbers.length = order.length;
}

/** タイミングラインの通過時刻を記録する。key = 周 × 本数 + 番号 */
export function recordTiming(rc: RaceCar, key: number, at: number): void {
  if (key < 0 || key >= rc.timingTimes.length) return;
  rc.timingTimes[key] = at;
  rc.lastTimingKey = key;
}

/**
 * 進行距離が d0 (時刻 t0) から d1 (時刻 t1) に進んだ間に通ったタイミングラインの時刻を記録する
 * (自分で周回を判定しない車用: マルチの他車)。時刻は線形に補間する。1 周目の開始前 (lap 0) の線は数えない
 */
export function recordTimingByDistance(rc: RaceCar, track: Track, d0: number, t0: number, d1: number, t1: number): void {
  if (!(d1 > d0) || d1 - d0 > track.length / 4) return;
  const L = track.length;
  const lines = track.timingLines;
  const count = lines.length;
  let lap = Math.floor(d0 / L) + 1;
  let i = 0;
  const s0 = d0 - (lap - 1) * L;
  while (i < count && lines[i] <= s0) i++;
  for (;;) {
    if (i >= count) {
      lap++;
      i = 0;
    }
    const at = (lap - 1) * L + lines[i];
    if (at > d1) break;
    const key = lap * count + i;
    if (lap >= 1 && key > rc.lastTimingKey) recordTiming(rc, key, t0 + ((at - d0) / (d1 - d0)) * (t1 - t0));
    i++;
  }
}

/** 前の車との差・先頭との差・後ろの車との差を更新する (order は並べ替え済み) */
export function updateRaceGaps(order: readonly RaceCar[], track: Track): void {
  const leader = order[0];
  for (let i = 0; i < order.length; i++) {
    const rc = order[i];
    if (rc.status === 'retired') {
      rc.gapToAhead = gapOut;
      rc.gapToLeader = gapOut;
    } else if (rc.lap.isInPitLane) {
      rc.gapToAhead = gapPit;
      rc.gapToLeader = gapPit;
    } else if (i === 0) {
      rc.gapToAhead = gapLeader;
      rc.gapToLeader = gapLeader;
    } else {
      rc.gapToAhead = gapBetween(track, rc, order[i - 1], rc.gapToAhead);
      rc.gapToLeader = gapBetween(track, rc, leader, rc.gapToLeader);
    }
    const behind = i + 1 < order.length ? order[i + 1] : null;
    if (behind === null || behind.status === 'retired') rc.gapToBehind = null;
    else if (rc.status === 'retired') rc.gapToBehind = gapOut;
    else rc.gapToBehind = gapBetween(track, behind, rc, rc.gapToBehind ?? gapNone);
  }
}

/**
 * me が ahead からどれだけ遅れているか。同じ周・同じタイミングラインの通過時刻の差。
 * 進行距離の差が 1 周以上なら周回遅れ。値が変わらなければ前の値 (オブジェクト) をそのまま返す
 */
export function gapBetween(track: Track, me: RaceCar, ahead: RaceCar, previous: RaceGap): RaceGap {
  const L = track.length;
  if (me.status === 'finished' && ahead.status === 'finished') {
    const laps = ahead.lapsCompleted - me.lapsCompleted;
    if (laps > 0) return lapsGap(previous, laps);
    return timeGap(previous, (me.finishTime ?? 0) - (ahead.finishTime ?? 0));
  }
  const diff = ahead.distance - me.distance;
  if (diff >= L) return lapsGap(previous, Math.floor(diff / L));
  const key = me.lastTimingKey;
  if (key < 0) return gapNone;
  const t = ahead.timingTimes[key];
  if (Number.isNaN(t)) return previous;
  return timeGap(previous, me.timingTimes[key] - t);
}

function lapsGap(previous: RaceGap, laps: number): RaceGap {
  return previous.kind === 'laps' && previous.laps === laps ? previous : { kind: 'laps', laps };
}

function timeGap(previous: RaceGap, seconds: number): RaceGap {
  return previous.kind === 'time' && previous.seconds === seconds ? previous : { kind: 'time', seconds };
}

/** 2 台が周回遅れの関係 (進行距離の差が 1 周の半分以上) か (7.10 節) */
export function isLappedPair(track: Track, a: RaceCar, b: RaceCar, rules: Readonly<RaceSessionRules>): boolean {
  return Math.abs(a.distance - b.distance) >= track.length * rules.lappedGhostRatio;
}

/** BLUE FLAG (7.10 節): x を周回遅れにする側の車が、x の後ろ 190 px 以内に来ている */
export function isBlueFlagged(x: RaceCar, cars: readonly RaceCar[], track: Track, rules: Readonly<RaceSessionRules>): boolean {
  if (x.status !== 'racing') return false;
  const L = track.length;
  for (const y of cars) {
    if (y === x || y.status !== 'racing') continue;
    const lead = y.distance - x.distance;
    if (lead < L * rules.lappedGhostRatio) continue;
    const behindOnTrack = (((x.distance - y.distance) % L) + L) % L;
    if (behindOnTrack > 0 && behindOnTrack <= rules.blueFlagDistance) return true;
  }
  return false;
}

/** ゴールした車の、ゴール時点の見込み順位 (まだ結果が確定していないとき。ペナルティを含まない) */
export function provisionalPosition(rc: RaceCar, cars: readonly RaceCar[]): number {
  let ahead = 0;
  for (const o of cars) {
    if (o === rc || o.status === 'retired' || o.status === 'unclassified') continue;
    if (o.status === 'finished' && o.lapsCompleted >= rc.lapsCompleted && o.finishOrder < rc.finishOrder) ahead++;
    else if (o.status === 'racing' && o.lapsCompleted >= rc.lapsCompleted) ahead++;
  }
  return ahead + 1;
}

/** ゴールタイム + ペナルティ (ゴールしていなければ Infinity) */
export function totalTimeOf(rc: RaceCar): number {
  return (rc.finishTime ?? Infinity) + rc.penalty;
}

/**
 * 最終順位 (7.7 節): ゴールした車 (周回数の多い順 → ゴールタイム + ペナルティの小さい順) → 未完走 (進行距離順) → リタイア
 */
export function buildRaceResults(cars: readonly RaceCar[], track: Track): RaceResult[] {
  const L = track.length;
  const finished = cars.filter((rc) => rc.status === 'finished');
  finished.sort((a, b) => b.lapsCompleted - a.lapsCompleted || totalTimeOf(a) - totalTimeOf(b) || a.finishOrder - b.finishOrder);
  const unclassified = cars.filter((rc) => rc.status === 'unclassified' || rc.status === 'racing');
  unclassified.sort((a, b) => b.distance - a.distance);
  const retired = cars.filter((rc) => rc.status === 'retired');
  retired.sort((a, b) => b.distance - a.distance);
  const all = [...finished, ...unclassified, ...retired];
  const winner = finished.length > 0 ? finished[0] : null;
  return all.map((rc, i) => {
    const status = rc.status === 'finished' ? 'finished' : rc.status === 'retired' ? 'retired' : 'unclassified';
    let gap: RaceGap = gapNone;
    if (status === 'retired') gap = gapOut;
    else if (rc === winner) gap = gapLeader;
    else if (winner) {
      const laps = status === 'finished' ? winner.lapsCompleted - rc.lapsCompleted : Math.max(1, Math.ceil((winner.lapsCompleted * L - rc.distance) / L));
      gap = laps > 0 ? { kind: 'laps', laps } : { kind: 'time', seconds: totalTimeOf(rc) - totalTimeOf(winner) };
    }
    const total = status === 'finished' ? totalTimeOf(rc) : null;
    return {
      carNumber: rc.carNumber,
      isPlayer: rc.isPlayer,
      position: i + 1,
      status,
      lapsCompleted: rc.lapsCompleted,
      finishTime: status === 'finished' ? rc.finishTime : null,
      penalty: rc.penalty,
      totalTime: total,
      gapToWinner: gap,
      bestLap: rc.bestLap,
      isJumpStart: rc.isJumpStart,
      isEstimated: rc.isEstimated,
    };
  });
}

/**
 * セッション全体のベスト (区間ごと・ラップ) と色分け (紫 = overall、緑 = personal、黄 = slower)。
 * 車ごとのベストは RaceCar.bestSectors・bestLap に書く
 */
export class SessionBests {
  readonly bestSectors: (number | null)[] = [null, null, null];
  /** 全体ベストラップとその車番 (まだなければ null) */
  fastestLap: number | null = null;
  fastestLapCarNumber: number | null = null;

  classifySector(rc: RaceCar, index: number, time: number, valid: boolean): TimingResult {
    if (!valid) return 'none';
    let result: TimingResult = 'slower';
    const own = rc.bestSectors[index];
    if (own === null || time <= own) {
      rc.bestSectors[index] = time;
      result = 'personal';
    }
    const all = this.bestSectors[index];
    if (all === null || time <= all) {
      this.bestSectors[index] = time;
      result = 'overall';
    }
    return result;
  }

  /** ラップを分類し、自己ベスト・全体ベストを更新する。'overall' なら全体ベストを更新した */
  classifyLap(rc: RaceCar, time: number, valid: boolean): TimingResult {
    if (!valid) return 'none';
    let result: TimingResult = 'slower';
    if (rc.bestLap === null || time <= rc.bestLap) {
      rc.bestLap = time;
      result = 'personal';
    }
    if (this.fastestLap === null || time < this.fastestLap) {
      this.fastestLap = time;
      this.fastestLapCarNumber = rc.carNumber;
      result = 'overall';
    }
    return result;
  }
}
