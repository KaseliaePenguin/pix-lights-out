import type { HostLobby } from '../host/HostLobby';
import type { NetClientSession } from '../net/NetClientSession';

/**
 * オンライン対戦のつながり (ロビー → レース → リザルト → ロビー の間ずっと持ち回る)。
 * host はホストのときだけ (ホスト本人の session は host.session と同じもの)
 */
export interface OnlineLink {
  session: NetClientSession;
  host: HostLobby | null;
}
