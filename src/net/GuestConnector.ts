import type { CodeError } from '../shared/net/connectionCode';
import { decodeConnectionCode } from '../shared/net/connectionCode';
import { netTimings } from './netConfig';
import type { GatherReport, LinkCloseReason, LinkDiagnostics } from './PeerLink';
import { PeerLink } from './PeerLink';
import { WebRtcClientTransport } from './WebRtcClientTransport';

export type GuestInviteResult =
  | { ok: true; connector: GuestConnector }
  | { ok: false; error: CodeError; theirVersion: number | null };

/**
 * 参加者の接続 (network.md「参加者の画面」)。招待コードから返答コードを作り、ホストが貼り付けて DataChannel が開いたら
 * WebRtcClientTransport を渡す。返答コードを出してから 120 秒 + 接続 15 秒で開かなければ onFail('timeout')。
 *
 * ```ts
 * const r = await GuestConnector.fromInvite(pastedText);     // 候補の収集に最大 5 秒
 * if (!r.ok) return showError(r.error);                       // 'wrongKind' なら「これは返答コードです」など
 * show(r.connector.replyCode);                                // [コピー]、残り r.connector.remainingMs
 * r.connector.onOpen = (transport) => {
 *   const session = new NetClientSession(transport, { name: 'KASE', team: 3 }, getCourseTrack());
 * };
 * r.connector.onFail = (reason) => showRetry(reason);
 * ```
 */
export class GuestConnector {
  onOpen: ((transport: WebRtcClientTransport) => void) | null = null;
  onFail: ((reason: LinkCloseReason) => void) | null = null;

  private readonly replyShownAt = performance.now();

  private constructor(private readonly link: PeerLink, readonly replyCode: string, readonly gather: GatherReport) {
    link.onOpen = () => {
      const transport = new WebRtcClientTransport(link);
      this.onOpen?.(transport);
    };
    link.onClose = (reason) => this.onFail?.(reason);
  }

  /** 招待コードを読み、返答コードを作る */
  static async fromInvite(text: string): Promise<GuestInviteResult> {
    const decoded = await decodeConnectionCode(text, 'invite');
    if (!decoded.ok) return { ok: false, error: decoded.error, theirVersion: decoded.theirVersion };
    // チェックサムは合っていても SDP が壊れている (全文形式など) と、ブラウザが setRemoteDescription で拒否する
    try {
      const offer = await PeerLink.createReply(decoded.code);
      return { ok: true, connector: new GuestConnector(offer.link, offer.code, offer.gather) };
    } catch {
      return { ok: false, error: 'malformed', theirVersion: decoded.code.protocolVersion };
    }
  }

  /** ホストが返答コードを貼り付けるまでの残り (ms、「ホストの操作を待っています (残り 120 秒)」) */
  get remainingMs(): number {
    return Math.max(0, netTimings.replyWaitMs - (performance.now() - this.replyShownAt));
  }

  get isOpen(): boolean {
    return this.link.isOpen;
  }

  /** [詳細をコピー] 用の記録 (IP アドレスを含まない) */
  diagnostics(): LinkDiagnostics {
    return this.link.getDiagnostics();
  }

  /** やめる ([やり直す])。開く前なら接続を閉じる */
  cancel(): void {
    if (!this.link.isOpen) this.link.close();
  }
}
