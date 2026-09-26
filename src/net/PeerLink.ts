import type { CodeKind, ConnectionCode } from '../shared/net/connectionCode';
import { encodeConnectionCode } from '../shared/net/connectionCode';
import { eventChannelId, eventMaxBytes, stateBufferLimit, stateChannelId, stateMaxBytes } from '../shared/net/protocol';
import type { CandidateAnalysis, NetRoute } from '../shared/net/sdp';
import { analyzeCandidates, classifyRoute, parseSdp } from '../shared/net/sdp';
import { readStateType } from '../shared/net/stateCodec';
import { StateSequencer } from '../shared/net/StateSequencer';
import { netTimings, stunServers } from './netConfig';

/** closed = 相手が閉じた (DataChannel の close)、failed = ICE・DTLS の失敗、timeout = 時間内に開かなかった */
export type LinkCloseReason = 'closed' | 'failed' | 'timeout';

/** 受信サイズの上限超え・形式違い。ホストは送り主を切断し、参加者は捨てるだけにする */
export type LinkViolation = 'stateTooLarge' | 'eventTooLarge' | 'badState' | 'badEvent';

export interface GatherReport {
  /** 候補の収集にかかった時間 (ms) */
  elapsedMs: number;
  /** 5 秒で打ち切った */
  isTimedOut: boolean;
  analysis: CandidateAnalysis;
}

export interface LinkOffer {
  link: PeerLink;
  /** 招待コード / 返答コード */
  code: string;
  gather: GatherReport;
}

/** [詳細をコピー] 用の記録。IP アドレスは含めない */
export interface LinkDiagnostics {
  role: CodeKind;
  lobbyId: number;
  slot: number;
  gather: GatherReport | null;
  /** 相手のコードのフラグと候補の種類 */
  remote: { isStunUnreachable: boolean; isSymmetricNatSuspected: boolean; isFullSdp: boolean; candidateTypes: string[] } | null;
  /** 状態の移り変わり (作ってからの ms と `ice:checking` などの名前) */
  history: { atMs: number; state: string }[];
  route: NetRoute | null;
  closeReason: LinkCloseReason | null;
}

export interface PeerLinkConfig {
  iceServers: readonly RTCIceServer[];
  gatherTimeoutMs: number;
}

/** UTF-8 で eventMaxBytes を超えるか。文字数 × 3 が上限以下なら必ず収まるので、超えそうなときだけ数える */
function isTextTooLarge(text: string): boolean {
  return text.length > eventMaxBytes || (text.length * 3 > eventMaxBytes && new TextEncoder().encode(text).length > eventMaxBytes);
}

const defaultConfig: PeerLinkConfig = { iceServers: stunServers, gatherTimeoutMs: netTimings.gatherTimeoutMs };

/**
 * 1 人の相手との WebRTC 接続 (RTCPeerConnection 1 つ + negotiated な DataChannel 2 本)。
 * ホストは枠ごとに createInvite で作り、返答コードを acceptReply に渡す。参加者は createReply で作る。
 * 両方の DataChannel が開くと onOpen が呼ばれる。候補は収集を終えてからコードにする (non-trickle)。
 *
 * ```ts
 * // ホスト
 * const { link, code } = await PeerLink.createInvite(lobbyId, 3);   // code を参加者に渡す
 * const r = await decodeConnectionCode(replyText, 'reply');
 * if (r.ok) await link.acceptReply(r.code);                           // 15 秒以内に onOpen か onClose
 * // 参加者
 * const inv = await decodeConnectionCode(inviteText, 'invite');
 * if (inv.ok) { const { link, code } = await PeerLink.createReply(inv.code); }  // code をホストに返す
 * ```
 */
export class PeerLink {
  onOpen: (() => void) | null = null;
  onState: ((data: ArrayBuffer) => void) | null = null;
  onEvent: ((text: string) => void) | null = null;
  /** 閉じたとき 1 回だけ呼ばれる (自分で close したときは呼ばれない) */
  onClose: ((reason: LinkCloseReason) => void) | null = null;
  onViolation: ((violation: LinkViolation) => void) | null = null;

  private readonly pc: RTCPeerConnection;
  private readonly stateChannel: RTCDataChannel;
  private readonly eventChannel: RTCDataChannel;
  private readonly sequencer = new StateSequencer();
  private readonly createdAt = performance.now();
  private readonly diagnostics: LinkDiagnostics;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private isOpenValue = false;
  private isClosed = false;

  private constructor(role: CodeKind, lobbyId: number, slot: number, config: PeerLinkConfig) {
    this.diagnostics = { role, lobbyId, slot, gather: null, remote: null, history: [], route: null, closeReason: null };
    this.pc = new RTCPeerConnection({ iceServers: [...config.iceServers] });
    // 両側が同じ id で作るので、相手の ondatachannel を待つ必要がない
    this.stateChannel = this.pc.createDataChannel('state', { negotiated: true, id: stateChannelId, ordered: false, maxRetransmits: 0 });
    this.eventChannel = this.pc.createDataChannel('event', { negotiated: true, id: eventChannelId, ordered: true });
    for (const ch of [this.stateChannel, this.eventChannel]) {
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => this.checkOpen();
      ch.onclose = () => this.closeWith('closed');
    }
    this.stateChannel.onmessage = (e) => this.receiveState(e.data);
    this.eventChannel.onmessage = (e) => this.receiveEvent(e.data);
    this.pc.addEventListener('iceconnectionstatechange', () => {
      this.record(`ice:${this.pc.iceConnectionState}`);
      if (this.pc.iceConnectionState === 'failed') this.closeWith('failed');
    });
    this.pc.addEventListener('connectionstatechange', () => {
      this.record(`conn:${this.pc.connectionState}`);
      // disconnected は一時的に戻ることがあるので切断扱いにしない
      if (this.pc.connectionState === 'failed') this.closeWith('failed');
    });
    this.pc.addEventListener('icegatheringstatechange', () => this.record(`gather:${this.pc.iceGatheringState}`));
  }

  /** 招待コードを作る (ホスト)。候補の収集に最大 5 秒かかる */
  static async createInvite(lobbyId: number, slot: number, config: PeerLinkConfig = defaultConfig): Promise<LinkOffer> {
    const link = new PeerLink('invite', lobbyId, slot, config);
    try {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      return await link.finishLocal('invite', config);
    } catch (e) {
      link.close();
      throw e;
    }
  }

  /**
   * 招待コードに答えて返答コードを作る (参加者)。候補の収集に最大 5 秒かかる。
   * ホストが貼り付けるまでの 120 秒 + 接続の 15 秒のうちに開かなければ onClose('timeout')
   */
  static async createReply(invite: ConnectionCode, config: PeerLinkConfig = defaultConfig): Promise<LinkOffer> {
    const link = new PeerLink('reply', invite.lobbyId, invite.slot, config);
    try {
      link.noteRemote(invite);
      await link.pc.setRemoteDescription({ type: 'offer', sdp: invite.sdp });
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      const offer = await link.finishLocal('reply', config);
      link.startTimeout(netTimings.replyWaitMs + netTimings.connectTimeoutMs);
      return offer;
    } catch (e) {
      link.close();
      throw e;
    }
  }

  /** 返答コードを受け取って接続を始める (ホスト)。15 秒のうちに開かなければ onClose('timeout') */
  async acceptReply(reply: ConnectionCode): Promise<void> {
    this.noteRemote(reply);
    this.startTimeout(netTimings.connectTimeoutMs);
    await this.pc.setRemoteDescription({ type: 'answer', sdp: reply.sdp });
  }

  get isOpen(): boolean {
    return this.isOpenValue;
  }

  /** 状態を送る。開いていない・送信待ちが 16KB を超えているときは捨てて false。data の連番の欄は書き換わる */
  sendState(data: ArrayBuffer): boolean {
    if (data.byteLength > stateMaxBytes) throw new Error(`state message too large: ${data.byteLength}`);
    const ch = this.stateChannel;
    if (!this.isOpenValue || ch.readyState !== 'open' || ch.bufferedAmount > stateBufferLimit) return false;
    this.sequencer.stamp(data);
    // 閉じかけ (closing) の間は send が例外を投げるので、送れなかったものとして扱う (一斉送信のループを止めない)
    try {
      ch.send(data);
      return true;
    } catch {
      return false;
    }
  }

  /** イベント (JSON 文字列) を送る。捨てない (開いていなければ false) */
  sendEvent(text: string): boolean {
    if (isTextTooLarge(text)) throw new Error(`event message too large: ${text.length}`);
    const ch = this.eventChannel;
    if (!this.isOpenValue || ch.readyState !== 'open') return false;
    try {
      ch.send(text);
      return true;
    } catch {
      return false;
    }
  }

  /** 実際に使われている候補の組から接続経路を調べる。まだ決まっていなければ null */
  async getRoute(): Promise<NetRoute | null> {
    if (this.isClosed) return this.diagnostics.route;
    const report = await this.pc.getStats();
    let pair: Record<string, unknown> | undefined;
    report.forEach((s: Record<string, unknown>) => {
      if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') pair = report.get(s.selectedCandidatePairId);
    });
    if (!pair) {
      // Firefox は transport に選択中の組を書かないので、candidate-pair の selected を見る
      report.forEach((s: Record<string, unknown>) => {
        if (s.type === 'candidate-pair' && (s.selected === true || (s.nominated === true && s.state === 'succeeded'))) pair ??= s;
      });
    }
    if (!pair) return null;
    const local = report.get(pair.localCandidateId as string) as Record<string, unknown> | undefined;
    const remote = report.get(pair.remoteCandidateId as string) as Record<string, unknown> | undefined;
    if (!local || !remote) return null;
    const remoteAddress = (remote.address ?? remote.ip ?? null) as string | null;
    const route = classifyRoute(String(local.candidateType), String(remote.candidateType), remoteAddress);
    this.diagnostics.route = route;
    return route;
  }

  /** [詳細をコピー] 用の記録 (IP アドレスを含まない) */
  getDiagnostics(): LinkDiagnostics {
    return structuredClone(this.diagnostics);
  }

  /** 閉じる。onClose は呼ばれない */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.isOpenValue = false;
    this.clearTimeout();
    this.stateChannel.close();
    this.eventChannel.close();
    this.pc.close();
  }

  private async finishLocal(kind: CodeKind, config: PeerLinkConfig): Promise<LinkOffer> {
    const started = performance.now();
    const isTimedOut = await this.waitForGathering(config.gatherTimeoutMs);
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp) throw new Error('no local description');
    const analysis = analyzeCandidates(parseSdp(sdp).candidates);
    const gather: GatherReport = { elapsedMs: Math.round(performance.now() - started), isTimedOut, analysis };
    this.diagnostics.gather = gather;
    const code = await encodeConnectionCode({ kind, lobbyId: this.diagnostics.lobbyId, slot: this.diagnostics.slot, sdp });
    return { link: this, code, gather };
  }

  /** 候補の収集が終わるのを待つ。打ち切ったら true */
  private waitForGathering(timeoutMs: number): Promise<boolean> {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve(false);
    return new Promise((resolve) => {
      let isDone = false;
      const finish = (isTimedOut: boolean) => {
        if (isDone) return;
        isDone = true;
        clearTimeout(timer);
        this.pc.removeEventListener('icegatheringstatechange', onState);
        this.pc.removeEventListener('icecandidate', onCandidate);
        resolve(isTimedOut);
      };
      const onState = () => {
        if (this.pc.iceGatheringState === 'complete') finish(false);
      };
      const onCandidate = (e: RTCPeerConnectionIceEvent) => {
        if (!e.candidate) finish(false);
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      this.pc.addEventListener('icegatheringstatechange', onState);
      this.pc.addEventListener('icecandidate', onCandidate);
    });
  }

  private noteRemote(code: ConnectionCode): void {
    this.diagnostics.remote = {
      isStunUnreachable: code.isStunUnreachable,
      isSymmetricNatSuspected: code.isSymmetricNatSuspected,
      isFullSdp: code.isFullSdp,
      candidateTypes: code.candidates.map((c) => c.type),
    };
  }

  private startTimeout(ms: number): void {
    this.clearTimeout();
    this.timeoutTimer = setTimeout(() => {
      if (!this.isOpenValue) this.closeWith('timeout');
    }, ms);
  }

  private clearTimeout(): void {
    if (this.timeoutTimer !== null) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
  }

  private checkOpen(): void {
    if (this.isOpenValue || this.isClosed) return;
    if (this.stateChannel.readyState !== 'open' || this.eventChannel.readyState !== 'open') return;
    this.isOpenValue = true;
    this.clearTimeout();
    this.record('open');
    this.onOpen?.();
  }

  private closeWith(reason: LinkCloseReason): void {
    if (this.isClosed) return;
    this.diagnostics.closeReason = reason;
    this.record(`closed:${reason}`);
    this.close();
    this.onClose?.(reason);
  }

  private record(state: string): void {
    const history = this.diagnostics.history;
    if (history.length < 100) history.push({ atMs: Math.round(performance.now() - this.createdAt), state });
  }

  private receiveState(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) {
      this.onViolation?.('badState');
      return;
    }
    if (data.byteLength > stateMaxBytes) {
      this.onViolation?.('stateTooLarge');
      return;
    }
    if (readStateType(data) === null) {
      this.onViolation?.('badState');
      return;
    }
    if (this.sequencer.accept(data)) this.onState?.(data);
  }

  private receiveEvent(data: unknown): void {
    if (typeof data !== 'string') {
      this.onViolation?.('badEvent');
      return;
    }
    if (isTextTooLarge(data)) {
      this.onViolation?.('eventTooLarge');
      return;
    }
    this.onEvent?.(data);
  }
}
