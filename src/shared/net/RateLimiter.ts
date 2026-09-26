/**
 * 受信頻度の上限 (network.md「ホストによる判定と不正対策」)。1 秒の窓ごとに数え、上限を超えた分は捨てる。
 * 上限を超える窓が途切れずに続いた時間を覚えておき、呼び出し側が一定時間 (10 秒) で切断する
 */
export class RateLimiter {
  private windowStart = -Infinity;
  private count = 0;
  private isWindowOver = false;
  private overSince: number | null = null;

  constructor(private readonly limit: number, private readonly windowMs = 1000) {}

  /** 1 件受け取るたびに呼ぶ (now は ms)。上限内なら true、超えていれば false (捨てる) */
  allow(now: number): boolean {
    if (now - this.windowStart >= this.windowMs) {
      // 直前の窓で超えていない、または何も届かない窓を挟んだら、超えている状態は途切れる
      if (!this.isWindowOver || now - this.windowStart >= this.windowMs * 2) this.overSince = null;
      this.windowStart = now;
      this.count = 0;
      this.isWindowOver = false;
    }
    this.count++;
    if (this.count <= this.limit) return true;
    if (!this.isWindowOver) {
      this.isWindowOver = true;
      this.overSince ??= this.windowStart;
    }
    return false;
  }

  /** 上限を超える状態が ms 以上続いているか */
  isOverFor(now: number, ms: number): boolean {
    return this.overSince !== null && now - this.overSince >= ms;
  }
}
