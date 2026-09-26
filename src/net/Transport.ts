import type { ClientMessage, HostMessage, PlayerId } from '../shared/net/messages';
import type { NetRoute } from '../shared/net/sdp';

/**
 * ゲーム側 (シーン、ホストのレース進行) が使う通信の窓口 (network.md「Transport の設計」)。
 * WebRTC を直接触らず、これを通して送受信する。
 *
 * state (sendState / onState) は届かなくてよいバイナリ (src/shared/net/stateCodec.ts の carState・snapshot)。
 * 連番は Transport が送るときに書き込み、古いものは受信側の Transport が捨てる。ping / pong は Transport の中で処理し、
 * onState には渡さない。event (sendEvent / onEvent) は必ず順番どおり届くメッセージ (src/shared/net/messages.ts)。
 * 受信したメッセージは形を確かめたものだけが onEvent に届く。
 */

/**
 * hostClosed = ホストが終了を知らせてきた、connectionFailed = 接続が切れた・失敗した、
 * timeout = 一定時間なにも届かない
 */
export type CloseReason = 'hostClosed' | 'connectionFailed' | 'timeout';

/**
 * left = 参加者が自分で抜けた、connectionFailed = 接続が切れた、timeout = 10 秒 pong が返らない、
 * kicked = ホストが切断した (kick、または不正なメッセージ)
 */
export type PeerLeaveReason = 'left' | 'connectionFailed' | 'timeout' | 'kicked';

export interface TransportStats {
  /** 往復遅延 (ms)。未測定なら null */
  rttMs: number | null;
  /** 接続経路。未判定なら null */
  route: NetRoute | null;
}

/** 参加者側 (ホスト本人のゲームも LocalTransport でこれを使う) */
export interface ClientTransport {
  /** 状態を送る (届かなくてよい)。送信が詰まっているときは捨てる。data の連番の欄は書き換わる */
  sendState(data: ArrayBuffer): void;
  /** イベントを送る (必ず順番どおり届く) */
  sendEvent(msg: ClientMessage): void;
  onState: ((data: ArrayBuffer) => void) | null;
  onEvent: ((msg: HostMessage) => void) | null;
  /** 切断されたとき 1 回だけ呼ばれる (自分で close したときは呼ばれない) */
  onClose: ((reason: CloseReason) => void) | null;
  close(): void;
  readonly stats: TransportStats;
  /** 時刻合わせが 1 回でも済んだか */
  readonly isClockSynced: boolean;
  /** 推定したホスト時刻 (ms)。raceStart の startTime と比べてカウントダウンする */
  hostNow(): number;
}

/** ホスト側 (ホストの Worker の中で使う) */
export interface HostTransport {
  sendState(peerId: PlayerId, data: ArrayBuffer): void;
  broadcastState(data: ArrayBuffer): void;
  sendEvent(peerId: PlayerId, msg: HostMessage): void;
  broadcastEvent(msg: HostMessage): void;
  onPeerJoin: ((peerId: PlayerId) => void) | null;
  /** 抜けたとき 1 回だけ呼ばれる (kick したときも呼ばれる) */
  onPeerLeave: ((peerId: PlayerId, reason: PeerLeaveReason) => void) | null;
  onState: ((peerId: PlayerId, data: ArrayBuffer) => void) | null;
  onEvent: ((peerId: PlayerId, msg: ClientMessage) => void) | null;
  /** 切断する (不正なメッセージなど) */
  kick(peerId: PlayerId, reason: PeerLeaveReason): void;
  /** つながっている参加者の ID */
  readonly peerIds: readonly PlayerId[];
  peerStats(peerId: PlayerId): TransportStats | null;
  /** ホスト時刻 (ms) */
  now(): number;
  /** 全員に hostClosed を送ってから接続を閉じる */
  close(): void;
}
