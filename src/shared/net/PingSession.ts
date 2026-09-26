import { ClockSync } from './ClockSync';
import type { NetClock } from './netClock';
import type { PingMessage, PongMessage } from './stateCodec';
import { decodePing, decodePong, encodePing, encodePong, readStateType, stateType } from './stateCodec';

export interface PingSessionOptions {
  clock: NetClock;
  /** 自分の時刻 (ms)。省略時は clock.now() */
  localNow?: () => number;
  /** state チャンネルで相手に送る */
  send: (data: ArrayBuffer) => void;
  /** ping の間隔 (ms) */
  intervalMs?: number;
  /** 始めに短い間隔で送る回数 (時刻合わせを早く収束させる) */
  burstCount?: number;
  burstIntervalMs?: number;
  /** 相手から何も届かない時間がこれを超えたら onTimeout (ms)。0 なら見ない */
  timeoutMs?: number;
  onTimeout?: () => void;
}

/** 覚えておく送信済み ping の数 (これより古い ping への pong は数えない) */
const pendingSize = 16;

/**
 * 1 本の接続の片側の ping / pong。一定間隔で ping を送り、返ってきた pong で往復時間と時計のずれを測る。
 * 相手からの ping には、自分の時刻を入れた pong をすぐ返す。失われた ping は数えない。
 */
export class PingSession {
  readonly sync = new ClockSync();
  private readonly clock: NetClock;
  private readonly localNow: () => number;
  private readonly send: (data: ArrayBuffer) => void;
  private readonly intervalMs: number;
  private readonly burstCount: number;
  private readonly burstIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly onTimeout: (() => void) | null;
  private readonly pendingSeq = new Float64Array(pendingSize).fill(-1);
  private readonly pendingAt = new Float64Array(pendingSize);
  private readonly ping: PingMessage = { seq: 0, sentAt: 0 };
  private readonly pong: PongMessage = { seq: 0, sentAt: 0, repliedAt: 0 };
  private seq = 0;
  private sentCount = 0;
  private timer: unknown = null;
  private isActive = false;
  private lastHeardAt = 0;

  constructor(options: PingSessionOptions) {
    this.clock = options.clock;
    this.localNow = options.localNow ?? (() => options.clock.now());
    this.send = options.send;
    this.intervalMs = options.intervalMs ?? 1000;
    this.burstCount = options.burstCount ?? 0;
    this.burstIntervalMs = options.burstIntervalMs ?? 200;
    this.timeoutMs = options.timeoutMs ?? 0;
    this.onTimeout = options.onTimeout ?? null;
  }

  get isRunning(): boolean {
    return this.isActive;
  }

  /** 往復時間 (ms)。未測定なら null */
  get rttMs(): number | null {
    return this.sync.hasEstimate ? this.sync.rtt : null;
  }

  start(): void {
    if (this.isActive) return;
    this.isActive = true;
    this.lastHeardAt = this.clock.now();
    this.tick();
  }

  stop(): void {
    this.isActive = false;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** 相手から何か (state・event どちらでも) 届いたときに呼ぶ */
  markAlive(): void {
    this.lastHeardAt = this.clock.now();
  }

  /** state チャンネルで受けたものを渡す。ping・pong ならここで処理して true (呼び出し側は捨てる) */
  handleState(data: ArrayBuffer): boolean {
    const type = readStateType(data);
    if (type === stateType.ping) {
      this.markAlive();
      if (decodePing(data, this.ping)) this.send(encodePong(this.ping.seq, this.ping.sentAt, this.localNow()));
      return true;
    }
    if (type === stateType.pong) {
      this.markAlive();
      if (!decodePong(data, this.pong)) return true;
      const i = this.pong.seq % pendingSize;
      // 自分が送った ping への pong で、時刻も一致するものだけを数える (二重に数えない)
      if (this.pendingSeq[i] === this.pong.seq && this.pendingAt[i] === this.pong.sentAt) {
        this.pendingSeq[i] = -1;
        this.sync.addSample(this.pong.sentAt, this.pong.repliedAt, this.localNow());
      }
      return true;
    }
    return false;
  }

  private tick(): void {
    this.timer = null;
    if (!this.isActive) return;
    if (this.timeoutMs > 0 && this.clock.now() - this.lastHeardAt > this.timeoutMs) {
      this.stop();
      this.onTimeout?.();
      return;
    }
    this.seq = (this.seq + 1) >>> 0;
    const sentAt = this.localNow();
    this.pendingSeq[this.seq % pendingSize] = this.seq;
    this.pendingAt[this.seq % pendingSize] = sentAt;
    this.sentCount++;
    // 送信が例外を投げても止まらないよう、次の ping を先に予約する
    const delay = this.sentCount < this.burstCount ? this.burstIntervalMs : this.intervalMs;
    this.timer = this.clock.setTimeout(() => this.tick(), delay);
    try {
      this.send(encodePing(this.seq, sentAt));
    } catch {
      // 送れなかった ping は数えない (pong が来ないだけ)
    }
  }
}
