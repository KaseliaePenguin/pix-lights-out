import type { Car } from './Car';
import type { ContactOutcome, ContactResult } from './carContact';
import { createContactOutcome, detectContact, resolveContact } from './carContact';

/** 車同士の接触 1 件 (演出用。衝撃がなく押し戻しだけのものは出さない) */
export interface CarContactEvent {
  /** step に渡した配列での番号 */
  indexA: number;
  indexB: number;
  /** 衝撃の強さ J (px/秒)。火花は 50 以上、画面揺れは 187.5 以上 (game-design.md 10.4 節) */
  impact: number;
  /** 接触点の目安 (ワールド座標) */
  x: number;
  y: number;
  isAAttacker: boolean;
  isBAttacker: boolean;
  spinA: boolean;
  spinB: boolean;
}

/** 押し戻しを繰り返す回数 (3 台以上が固まったとき・壁との間に挟まれたときに、重なりを解ききるため) */
const passes = 3;

/**
 * 全車の接触処理 (car-physics.md 9.1 節)。全車の update のあとに 1 回 step を呼ぶ。
 * - ゴーストの組み合わせ (isGhostPair が true) は判定しない
 * - 同じ 2 台の最後の衝撃から pairCooldown (0.2 秒) 以内は押し戻しだけ
 * - 押し戻しで壁に押し込まれた車は、壁の外へ戻す
 * 1 人用 (全車をこの端末で計算) の処理。両方の車を動かす。
 */
export class ContactSystem {
  private readonly lastImpact: Float64Array;
  private readonly contact: ContactResult = { depth: 0, nx: 0, ny: 0, x: 0, y: 0 };
  private readonly outcome: ContactOutcome = createContactOutcome();
  private readonly pool: CarContactEvent[] = [];
  private readonly events: CarContactEvent[] = [];

  constructor(readonly carCount: number) {
    this.lastImpact = new Float64Array(carCount * carCount).fill(-Infinity);
  }

  /** レースをやり直すときに呼ぶ */
  reset(): void {
    this.lastImpact.fill(-Infinity);
  }

  /**
   * time はセッションの経過時間 (秒)。返す配列と中身は次の step で使い回す
   */
  step(cars: readonly Car[], isGhostPair: (a: number, b: number) => boolean, time: number): readonly CarContactEvent[] {
    this.events.length = 0;
    const n = Math.min(cars.length, this.carCount);
    for (let pass = 0; pass < passes; pass++) {
      let touched = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (isGhostPair(i, j)) continue;
          const a = cars[i];
          const b = cars[j];
          if (!detectContact(a, b, this.contact)) continue;
          touched = true;
          const key = i * this.carCount + j;
          // 衝撃は最初の回だけ。2 回目以降は重なりを解くだけ
          const cooledDown = time - this.lastImpact[key] >= a.params.pairCooldown;
          const o = resolveContact(a, b, this.contact, pass === 0 && cooledDown, true, this.outcome);
          if (o.impact > 0) {
            this.lastImpact[key] = time;
            this.push(i, j, o);
          }
          a.pushOutOfWalls();
          b.pushOutOfWalls();
        }
      }
      if (!touched) break;
    }
    return this.events;
  }

  private push(i: number, j: number, o: ContactOutcome): void {
    const k = this.events.length;
    if (k >= this.pool.length) {
      this.pool.push({ indexA: 0, indexB: 0, impact: 0, x: 0, y: 0, isAAttacker: false, isBAttacker: false, spinA: false, spinB: false });
    }
    const e = this.pool[k];
    e.indexA = i;
    e.indexB = j;
    e.impact = o.impact;
    e.x = this.contact.x;
    e.y = this.contact.y;
    e.isAAttacker = o.isAAttacker;
    e.isBAttacker = o.isBAttacker;
    e.spinA = o.spinA;
    e.spinB = o.spinB;
    this.events.push(e);
  }
}
