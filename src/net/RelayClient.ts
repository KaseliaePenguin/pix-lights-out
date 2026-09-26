import type { RelayClientFrame, RelayCloseName, RelayServerFrame } from '../shared/net/relayProtocol';
import { parseRelayServerFrame, relayCloseNameOf, relayPingText, relayPongText } from '../shared/net/relayProtocol';
import { netTimings } from './netConfig';

/**
 * unreachable = 名乗りが通る前に切れた・時間切れ (中継が動いていない、URL 違い、Origin の拒否、ネットワーク)、
 * lost = 名乗りが通ったあとに、理由のコードなしで切れた (通信の切り替わりなど)、それ以外は中継が付けた理由 (relayCloseCodes)
 */
export type RelayClientEnd = 'unreachable' | 'lost' | RelayCloseName;

/**
 * 中継 (signaling/) への WebSocket 1 本。名乗り (hello) を送り、ready が届いたら onReady。
 * 生存確認に 30 秒ごとに ping を送る (中継は Durable Object を起こさずに pong を返す)。
 * 中身の暗号化はしない (呼び出し側が RelayCipher で暗号化した文字列を data に入れる)。
 */
export class RelayClient {
  onReady: ((frame: Extract<RelayServerFrame, { t: 'ready' }>) => void) | null = null;
  /** ready 以外のフレーム (joined / left / msg) */
  onFrame: ((frame: RelayServerFrame) => void) | null = null;
  /** 閉じたとき 1 回だけ (自分で close したときは呼ばれない) */
  onEnd: ((end: RelayClientEnd) => void) | null = null;

  /** URL が壊れている・https のページから ws:// を開こうとした、などで作れなかったときは null */
  private readonly ws: WebSocket | null;
  private isReadyValue = false;
  private isEnded = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(url: string, roomId: string, hello: RelayClientFrame) {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${url}/rooms/${roomId}`);
    } catch {
      ws = null;
    }
    this.ws = ws;
    if (!ws) {
      // 呼び出し側が onEnd を設定してから知らせる
      setTimeout(() => this.end('unreachable'), 0);
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = (e) => this.end(this.endOf(e.code));
    // error のあとには必ず close が来るので、ここでは何もしない
    ws.onerror = () => undefined;
    this.connectTimer = setTimeout(() => {
      if (!this.isReadyValue) this.end('unreachable');
    }, netTimings.relayConnectTimeoutMs);
  }

  /** 中継につなぎ、hello ({ t: 'host', secret } か { t: 'join' }) で名乗る */
  static connect(url: string, roomId: string, hello: RelayClientFrame): RelayClient {
    return new RelayClient(url, roomId, hello);
  }

  get isReady(): boolean {
    return this.isReadyValue;
  }

  /** 送る。名乗りが通る前・閉じたあとは false */
  send(frame: RelayClientFrame): boolean {
    const ws = this.ws;
    if (!this.isReadyValue || this.isEnded || !ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  /** 閉じる。onEnd は呼ばれない */
  close(): void {
    if (this.isEnded) return;
    this.isEnded = true;
    this.clearTimers();
    try {
      this.ws?.close(1000, 'bye');
    } catch {
      // すでに閉じている
    }
  }

  private receive(data: unknown): void {
    if (this.isEnded || typeof data !== 'string' || data === relayPongText) return;
    const frame = parseRelayServerFrame(data);
    if (!frame) return;
    if (frame.t === 'ready') {
      if (this.isReadyValue) return;
      this.isReadyValue = true;
      if (this.connectTimer !== null) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.keepaliveTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(relayPingText);
      }, netTimings.relayKeepaliveMs);
      this.onReady?.(frame);
      return;
    }
    this.onFrame?.(frame);
  }

  private endOf(code: number): RelayClientEnd {
    const name = relayCloseNameOf(code);
    if (name) return name;
    return this.isReadyValue ? 'lost' : 'unreachable';
  }

  private end(end: RelayClientEnd): void {
    if (this.isEnded) return;
    this.isEnded = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      // すでに閉じている
    }
    this.onEnd?.(end);
  }

  private clearTimers(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    if (this.keepaliveTimer !== null) clearInterval(this.keepaliveTimer);
    this.connectTimer = null;
    this.keepaliveTimer = null;
  }
}
