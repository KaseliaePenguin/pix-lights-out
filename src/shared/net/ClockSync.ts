/**
 * ping / pong の往復から相手の時計とのずれを推定する (network.md「時刻合わせ」、NTP と同じ考え方)。
 * 直近 windowSize 回のうち、往復時間の短い bestCount 回の平均を使う (往復時間が短いほど片道の偏りが小さいため)。
 */
export class ClockSync {
  private readonly rtts: Float64Array;
  private readonly offsets: Float64Array;
  private readonly picked: Uint8Array;
  private count = 0;
  private next = 0;
  private offsetMs = 0;
  private rttMsValue = 0;

  constructor(private readonly windowSize = 10, private readonly bestCount = 3) {
    this.rtts = new Float64Array(windowSize);
    this.offsets = new Float64Array(windowSize);
    this.picked = new Uint8Array(windowSize);
  }

  /** 1 回でも測れたか */
  get hasEstimate(): boolean {
    return this.count > 0;
  }

  /** 相手の時計 − 自分の時計 (ms)。未測定なら 0 */
  get offset(): number {
    return this.offsetMs;
  }

  /** 往復時間 (ms)。選んだ回の平均。未測定なら 0 */
  get rtt(): number {
    return this.rttMsValue;
  }

  get sampleCount(): number {
    return this.count;
  }

  /** 自分の時刻を相手の時刻に直す */
  toRemote(localTime: number): number {
    return localTime + this.offsetMs;
  }

  /**
   * 1 往復分を加える。sentAt = ping を送った自分の時刻、remoteTime = pong に書かれた相手の時刻、
   * receivedAt = pong を受けた自分の時刻 (すべて ms)
   */
  addSample(sentAt: number, remoteTime: number, receivedAt: number): void {
    const rtt = receivedAt - sentAt;
    if (!(rtt >= 0) || !Number.isFinite(remoteTime)) return;
    this.rtts[this.next] = rtt;
    this.offsets[this.next] = remoteTime - (sentAt + receivedAt) / 2;
    this.next = (this.next + 1) % this.windowSize;
    if (this.count < this.windowSize) this.count++;
    this.recompute();
  }

  reset(): void {
    this.count = 0;
    this.next = 0;
    this.offsetMs = 0;
    this.rttMsValue = 0;
  }

  private recompute(): void {
    const n = Math.min(this.bestCount, this.count);
    this.picked.fill(0);
    let offsetSum = 0;
    let rttSum = 0;
    for (let k = 0; k < n; k++) {
      let best = -1;
      for (let i = 0; i < this.count; i++) {
        if (!this.picked[i] && (best < 0 || this.rtts[i] < this.rtts[best])) best = i;
      }
      this.picked[best] = 1;
      offsetSum += this.offsets[best];
      rttSum += this.rtts[best];
    }
    this.offsetMs = offsetSum / n;
    this.rttMsValue = rttSum / n;
  }
}
