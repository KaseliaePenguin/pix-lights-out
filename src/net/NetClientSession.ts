import type { HostMessage, LobbyPlayer, LobbySettings, PlayerId, RejectReason, ResultMessage, TyreChoice } from '../shared/net/messages';
import { protocolVersion } from '../shared/net/protocol';
import type { Track } from '../shared/Track';
import { NetRaceClient } from './NetRaceClient';
import type { ClientTransport, CloseReason } from './Transport';

/**
 * joining = join を送って welcome を待っている、lobby = ロビーにいる、race = レース中、
 * rejected = join を拒否された (名前・チームの重複なら join し直せる)、closed = 接続が切れた
 */
export type NetSessionState = 'joining' | 'lobby' | 'race' | 'rejected' | 'closed';

export interface NetProfile {
  /** 英大文字と数字 3〜8 文字 */
  name: string;
  /** チーム = 車番 1〜8 */
  team: number;
}

/**
 * 参加者 1 人ぶんの、ホストとのやりとり全体 (ロビー → レース → ロビー …)。ホスト本人も LocalTransport で使う。
 * Transport の受信をすべて受け持ち、レース中は NetRaceClient に渡す。DOM に依存しない。
 *
 * ```ts
 * const session = new NetClientSession(transport, { name: 'KASE', team: 3 }, getCourseTrack());
 * session.onChange = () => redrawLobby(session.players, session.settings);
 * session.onRaceStart = (race) => game.changeScene(new NetRaceScene(game, session, race));
 * session.setReady(true, 'soft');
 * // レース画面: race.step(controls, dt)。result が届くと race.phase が finished、session.state は lobby に戻る
 * ```
 */
export class NetClientSession {
  state: NetSessionState = 'joining';
  /** ホストが割り当てた ID (welcome まで null) */
  playerId: PlayerId | null = null;
  players: LobbyPlayer[] = [];
  settings: LobbySettings | null = null;
  rejectReason: RejectReason | null = null;
  closeReason: CloseReason | null = null;
  /** 今のレース (レースが終わってロビーに戻っても、次の raceStart まで残す。結果画面で読む) */
  race: NetRaceClient | null = null;
  /** 最後に届いた result */
  lastResult: ResultMessage | null = null;
  /** ロビーの状態 (参加者一覧・設定・state) が変わったとき */
  onChange: (() => void) | null = null;
  /** レースが始まったとき (raceStart が届いた) */
  onRaceStart: ((race: NetRaceClient) => void) | null = null;

  private profileValue: NetProfile;

  constructor(readonly transport: ClientTransport, profile: NetProfile, private readonly track: Track) {
    this.profileValue = { ...profile };
    transport.onEvent = (msg) => this.handleEvent(msg);
    transport.onState = (data) => this.race?.handleState(data);
    transport.onClose = (reason) => this.handleClose(reason);
    this.sendJoin();
  }

  get profile(): Readonly<NetProfile> {
    return this.profileValue;
  }

  /** 自分の行 (参加者一覧の中) */
  get me(): LobbyPlayer | null {
    return this.players.find((p) => p.id === this.playerId) ?? null;
  }

  /** ホストのコースがこの端末のコースと同じか (違えば一緒に走れない) */
  get isCourseCompatible(): boolean {
    return !this.settings || (this.settings.course === this.track.data.id && this.settings.courseVersion === this.track.version);
  }

  /** 名前・チームを変えて join し直す (拒否されたとき・ロビーで変えるとき) */
  join(profile: NetProfile): void {
    if (this.state === 'closed' || this.state === 'race') return;
    this.profileValue = { ...profile };
    if (this.state === 'rejected') this.state = 'joining';
    this.sendJoin();
  }

  /** 準備完了 (ロビーだけ) */
  setReady(isReady: boolean, tyre: TyreChoice = 'soft'): void {
    if (this.state !== 'lobby') return;
    this.transport.sendEvent({ type: 'ready', isReady, tyre });
  }

  /** 抜ける (接続を閉じる) */
  leave(): void {
    if (this.state === 'closed') return;
    this.race?.leave();
    this.transport.close();
    this.state = 'closed';
    this.closeReason = null;
    this.onChange?.();
  }

  private sendJoin(): void {
    this.transport.sendEvent({ type: 'join', protocolVersion, name: this.profileValue.name, team: this.profileValue.team });
  }

  private handleEvent(msg: HostMessage): void {
    switch (msg.type) {
      case 'welcome':
        this.playerId = msg.playerId;
        this.players = msg.players;
        this.settings = msg.settings;
        this.rejectReason = null;
        if (this.state !== 'race') this.state = 'lobby';
        this.onChange?.();
        break;
      case 'reject':
        this.rejectReason = msg.reason;
        // ロビーで名前・チームを変えようとして拒否された場合は、ロビーにいたまま
        if (this.state === 'joining') this.state = 'rejected';
        this.onChange?.();
        break;
      case 'lobby':
        this.players = msg.players;
        this.settings = msg.settings;
        if (this.state !== 'race' && this.playerId !== null) this.state = 'lobby';
        this.onChange?.();
        break;
      case 'raceStart': {
        if (this.playerId === null || !msg.grid.includes(this.playerId)) return;
        this.settings = msg.settings;
        this.race = new NetRaceClient({ transport: this.transport, track: this.track, playerId: this.playerId, start: msg, players: this.players });
        // スナップショットが途切れてレース側が接続を閉じたら、セッションも閉じる
        this.race.onAbort = () => this.handleClose('timeout');
        this.state = 'race';
        this.onChange?.();
        this.onRaceStart?.(this.race);
        break;
      }
      case 'result':
        this.lastResult = msg;
        this.race?.handleEvent(msg);
        if (this.state === 'race') this.state = 'lobby';
        this.onChange?.();
        break;
      case 'raceEvent':
      case 'collision':
        this.race?.handleEvent(msg);
        break;
      case 'hostClosed':
        break;
    }
  }

  private handleClose(reason: CloseReason): void {
    this.closeReason = reason;
    this.state = 'closed';
    this.race?.handleClose(reason);
    this.onChange?.();
  }
}
