import type { AcceptReplyError, HostSlotFailure } from '../host/HostLobby';
import type { HostRoomFailure } from '../host/HostRoom';
import type { GuestRoomFailure } from '../net/GuestRoomConnector';
import type { CloseReason } from '../net/Transport';
import type { LinkCloseReason } from '../net/PeerLink';
import type { CodeError } from '../shared/net/connectionCode';
import type { RejectReason } from '../shared/net/messages';

/**
 * オンライン対戦の案内文 (network.md「接続できなかったときの扱い」「セキュリティと注意」「ホストのタブが…」の 7)。
 * HUD のビットマップフォントは英大文字・数字・記号だけなので、日本語の文言を英語に訳している。
 */
export const netTexts = {
  ipWarning:
    'THIS CODE CONTAINS YOUR INTERNET IP ADDRESS. GIVE IT ONLY TO PEOPLE YOU TRUST, ONE BY ONE (E.G. BY DM). ' +
    'DO NOT POST IT ON SNS OR IN PUBLIC PLACES.',
  /** ホストの招待リンク用 (中身は招待コードなので同じ注意) */
  ipWarningLink:
    'THIS LINK CONTAINS YOUR INTERNET IP ADDRESS. GIVE IT ONLY TO PEOPLE YOU TRUST, ONE BY ONE (E.G. BY DM). ' +
    'DO NOT POST IT ON SNS OR IN PUBLIC PLACES.',
  hostNotice:
    'HOST: DO NOT CLOSE OR RELOAD THIS TAB DURING A RACE. IF YOU SWITCH TABS, THE RACE GOES ON BUT YOUR CAR STOPS.',
  hostRaceStart: 'HOST: KEEP THIS TAB IN FRONT',
  tabWasHidden: 'YOUR TAB WAS IN THE BACKGROUND, SO YOUR CAR STOPPED',
  /** タブは前面のままなのに自車の状態がホストに届かなかった (回線の詰まり) */
  connectionUnstable: 'CONNECTION UNSTABLE',
  connectionLost: 'THE CONNECTION TO THE HOST WAS LOST. THE RACE IS OVER.',
  hostClosedLobby: 'THE HOST CLOSED THE LOBBY.',
  lostInLobby: 'THE CONNECTION TO THE HOST WAS LOST.',
  stunUnreachable:
    'NO INTERNET CONNECTION INFO. YOU CAN ONLY CONNECT ON THE SAME LAN (UDP MAY BE BLOCKED ON THIS NETWORK).',
  symmetricNat: 'YOUR NETWORK MAY BE HARD TO CONNECT TO. IF IT DOES NOT WORK, ASK SOMEONE ELSE TO HOST.',
  /** つながらなかったとき (ホスト・参加者の両方) */
  connectFailedGuide: [
    'COULD NOT CONNECT.',
    'DEPENDING ON YOUR NETWORKS (SYMMETRIC NAT, CARRIER-GRADE NAT, STRICT FIREWALLS, ETC.), THIS METHOD MAY NOT WORK. TRY:',
    '1. TRY AGAIN (WITH A NEW INVITE LINK)',
    '2. ASK SOMEONE ELSE TO HOST',
    '3. ONE OF YOU USES ANOTHER LINE, E.G. PHONE TETHERING',
    '4. PLAY ON THE SAME LAN (SAME WI-FI)',
  ],
  /** 双方の srflx の IP が同じ (同じルーターの内側) なのに失敗した */
  sameLanFailed:
    'YOU SEEM TO BE ON THE SAME NETWORK, BUT COULD NOT CONNECT. NETWORKS THAT BLOCK DEVICES FROM TALKING TO EACH OTHER ' +
    '(E.G. GUEST WI-FI) CANNOT BE USED. SWITCH TO ANOTHER NETWORK.',
  noResponse: 'NO RESPONSE AFTER CONNECTING. RELOAD THE PAGE AND TRY AGAIN.',
  replyTimedOut: 'TIME IS UP. ASK THE HOST FOR A NEW INVITE LINK.',
  expired: 'EXPIRED. MAKE A NEW INVITE AND SEND THE LINK.',
  /** ホストの共通リンク (中継、#room=) 用。リンク自体に IP アドレスは入らないが、つないだ相手には伝わる */
  roomLinkWarning:
    'THE LINK LETS ANYONE WHO HAS IT JOIN. SHARE IT ONLY WITH FRIENDS. ' +
    'WHEN A PLAYER CONNECTS, YOUR INTERNET IP ADDRESS AND THEIRS ARE SHARED WITH EACH OTHER.',
  /** 参加者が共通リンクでつないでいる間 */
  roomGuestIpNote: 'CONNECTING SHARES YOUR INTERNET IP ADDRESS WITH THE HOST. JOIN ONLY LOBBIES OF PEOPLE YOU KNOW.',
  relayUnavailable: 'RELAY UNAVAILABLE. USING INVITE CODES.',
  /** 参加者がロビーで切断された (ホストに外された場合と見分けがつかない) */
  disconnectedFromLobby: 'DISCONNECTED FROM THE LOBBY. THE CONNECTION WAS LOST, OR THE HOST REMOVED YOU.',
  askForCode: 'ASK THE HOST FOR AN INVITE CODE',
  /** 共通リンクが使えなかったときの、従来の方式への案内 */
  askForCodeGuide:
    'ASK THE HOST FOR A "CODE INVITE" LINK AND OPEN IT (OR PASTE IT BELOW). YOU WILL SEND A REPLY CODE BACK.',
};

/** 貼り付けたコードの形式の誤り。expected は待っているコードの種類 */
export function codeErrorText(error: CodeError, expected: 'invite' | 'reply'): string {
  switch (error) {
    case 'malformed':
      return 'THE CODE IS NOT VALID. CHECK THAT IT IS NOT CUT OFF, AND COPY IT AGAIN.';
    case 'wrongKind':
      return expected === 'invite'
        ? 'THIS IS A REPLY CODE. PASTE THE INVITE LINK FROM THE HOST.'
        : 'THIS IS AN INVITE LINK. PASTE THE REPLY CODE FROM A PLAYER.';
    case 'version':
      return 'THE GAME VERSIONS DIFFER. EVERYONE SHOULD RELOAD THE PAGE TO GET THE LATEST VERSION.';
    case 'unsupported':
      return 'THIS BROWSER CANNOT READ THIS CODE. TRY ANOTHER BROWSER.';
  }
}

/** ホストが返答コードを受け付けられなかった理由 */
export function acceptErrorText(error: AcceptReplyError): string {
  switch (error) {
    case 'otherLobby':
      return 'THIS REPLY CODE IS NOT FOR THIS LOBBY.';
    case 'notInvited':
      return 'NO INVITE WAS MADE FOR THIS SLOT.';
    case 'slotUsed':
      return 'THIS SLOT IS ALREADY IN USE.';
    case 'expired':
      return netTexts.expired;
    case 'failed':
      return 'THIS SLOT HAS FAILED. MAKE A NEW INVITE AND SEND THE LINK.';
    default:
      return codeErrorText(error, 'reply');
  }
}

/** ホストの枠の失敗 (一覧に出す短いもの) */
export function slotFailureLabel(failure: HostSlotFailure | null): string {
  switch (failure) {
    case 'expired':
      return 'EXPIRED';
    case 'gatherFailed':
      return 'NO CODE';
    case 'timeout':
      return 'TIMED OUT';
    default:
      return 'NOT CONNECTED';
  }
}

/** 参加者の接続の失敗 */
export function guestFailureLines(reason: LinkCloseReason, wasWaitingForHost: boolean, isSamePublicAddress: boolean): readonly string[] {
  if (reason === 'timeout' && wasWaitingForHost) return [netTexts.replyTimedOut];
  return connectFailedLines(isSamePublicAddress);
}

/** つながらなかったときの案内 (同じ LAN にいるようなら、その案内) */
export function connectFailedLines(isSamePublicAddress: boolean): readonly string[] {
  return isSamePublicAddress ? ['COULD NOT CONNECT.', netTexts.sameLanFailed] : netTexts.connectFailedGuide;
}

/** ホストに参加を断られた理由 */
export function rejectText(reason: RejectReason): string {
  switch (reason) {
    case 'nameTaken':
      return 'THAT NAME IS ALREADY TAKEN. CHOOSE ANOTHER NAME.';
    case 'teamTaken':
      return 'THAT TEAM IS ALREADY TAKEN. CHOOSE ANOTHER TEAM.';
    case 'invalidName':
      return 'NAME MUST BE 3-8 LETTERS OR DIGITS.';
    case 'full':
      return 'THE LOBBY IS FULL.';
    case 'version':
      return codeErrorText('version', 'invite');
    case 'raceInProgress':
      return 'A RACE IS IN PROGRESS. ASK THE HOST FOR A NEW INVITE LINK AFTER THE RACE.';
  }
}

/** ロビー・レースでホストとの接続が切れた理由 */
export function closeText(reason: CloseReason | null): string {
  return reason === 'hostClosed' ? netTexts.hostClosedLobby : netTexts.lostInLobby;
}

/** 参加者の共通リンク (#room=) の失敗のうち、従来の方式に切り替えるもの (shouldFallbackToCode が true) の理由 */
export function guestRoomFallbackText(failure: GuestRoomFailure): string {
  switch (failure) {
    case 'relayUnavailable':
      return 'COULD NOT REACH THE RELAY SERVER, SO THE LINK DID NOT WORK.';
    case 'noRoom':
      return 'THIS LINK IS NO LONGER OPEN (REPLACED, CLOSED OR EXPIRED).';
    case 'timeout':
      return 'THE HOST DID NOT ANSWER.';
    default:
      return 'THE RELAY SERVER DROPPED THE CONNECTION.';
  }
}

/** 参加者の共通リンク (#room=) の失敗のうち、方式を変えても同じもの */
export function guestRoomFailureLines(failure: GuestRoomFailure, isSamePublicAddress: boolean): readonly string[] {
  switch (failure) {
    case 'full':
      return [rejectText('full')];
    case 'version':
      return [codeErrorText('version', 'invite')];
    case 'invalidLink':
      return ['THE INVITE LINK IS BROKEN. ASK THE HOST TO SEND IT AGAIN.'];
    default:
      return connectFailedLines(isSamePublicAddress);
  }
}

/** ホストの共通リンク (中継の部屋) が使えなくなった理由 */
export function hostRoomFailureText(failure: HostRoomFailure | null): string {
  switch (failure) {
    case 'expired':
      return 'THE LINK EXPIRED (30 MIN). SELECT "NEW LINK" TO MAKE A NEW ONE.';
    case 'replaced':
      return 'THIS LOBBY LINK WAS OPENED AS HOST IN ANOTHER TAB. SELECT "NEW LINK".';
    case 'lost':
      return 'LOST THE CONNECTION TO THE RELAY. ' + netTexts.relayUnavailable;
    default:
      return netTexts.relayUnavailable;
  }
}
