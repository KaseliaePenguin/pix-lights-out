/**
 * seed 付きの乱数 (mulberry32)。同じ seed なら同じ並びになるので、レースの再現・ホストとの一致・sim の確認に使う。
 * Math.random は使わない。
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** 0 以上 1 未満 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** min 以上 max 未満 */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** 確率 p で true */
  chance(p: number): boolean {
    return this.next() < p;
  }
}
