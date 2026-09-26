import type { PeerLeaveReason } from '../net/Transport';
import type { LobbyPlayer, LobbySettings, PlayerId } from '../shared/net/messages';
import type { NetRoute } from '../shared/net/sdp';
import type { RaceHostPhase, StartRaceResult } from './RaceHost';

/**
 * ホストのメインスレッド (HostRelay・HostLobby) と Worker (hostWorker.ts) の間の postMessage の形。
 * state の ArrayBuffer は転送 (transfer) する。ホスト本人 (枠 0) は別の MessagePort (LocalTransport) で話す
 */

/** メインスレッド → Worker */
export type ToWorkerMessage =
  /** 最初に 1 回。localPort はホスト本人のゲーム (LocalTransport) とつなぐ MessagePort */
  | { kind: 'init'; laps: number; localPort: MessagePort }
  /** 参加者の DataChannel が 2 本とも開いた */
  | { kind: 'peerOpen'; peerId: PlayerId; route: NetRoute | null }
  | { kind: 'peerRoute'; peerId: PlayerId; route: NetRoute }
  /** 参加者の接続が切れた (相手が閉じた・ICE の失敗など) */
  | { kind: 'peerClosed'; peerId: PlayerId; reason: PeerLeaveReason }
  | { kind: 'state'; peerId: PlayerId; data: ArrayBuffer }
  | { kind: 'event'; peerId: PlayerId; text: string }
  /** 受信サイズの上限超え・形式違い (送り主を切断する) */
  | { kind: 'violation'; peerId: PlayerId }
  /** ホストの操作 */
  | { kind: 'setLaps'; laps: number }
  | { kind: 'startRace' }
  | { kind: 'close' };

/** Worker → メインスレッド */
export type FromWorkerMessage =
  /** peerId が null なら、開いている参加者全員に送る */
  | { kind: 'state'; peerId: PlayerId | null; data: ArrayBuffer }
  | { kind: 'event'; peerId: PlayerId | null; text: string }
  /** この参加者の接続を閉じる */
  | { kind: 'kick'; peerId: PlayerId; reason: PeerLeaveReason }
  /** hostClosed を送り終えた。全員の接続を閉じる */
  | { kind: 'closeAll' }
  /** ロビー・レースの状態 (ホストの画面用) */
  | { kind: 'status'; phase: RaceHostPhase; canStart: boolean; players: LobbyPlayer[]; settings: LobbySettings }
  | { kind: 'startResult'; result: StartRaceResult }
  | { kind: 'warning'; peerId: PlayerId; detail: string };

/** ホスト本人 (LocalTransport) ⇔ Worker の MessagePort の形 */
export type LocalPortMessage =
  | { kind: 'state'; data: ArrayBuffer }
  | { kind: 'event'; text: string }
  | { kind: 'close' };
