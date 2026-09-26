import { decodeBase64url, encodeBase64url } from './base64url';
import { maxSlot } from './protocol';
import { isRoomId, isRoomKey, roomKeyBytes } from './relayProtocol';

/**
 * 中継に流す中身の暗号化と認証 (network.md「中継による接続」の「セキュリティ」)。DOM に依存しない (WebCrypto だけ)。
 *
 * - 鍵: 招待リンクの鍵 (128 ビット) から HKDF-SHA-256 で AES-GCM-128 の鍵を作る (salt = 部屋 ID)。鍵はフラグメントにだけあり、
 *   中継にもゲームの配信先にも送られない。中継は中身を読めず、書き換えると認証で落ちる
 * - 向き: 追加認証データ (AAD) に部屋 ID と向き (toHost / toGuest) を入れる。ホストが出したものをホストに送り返す、
 *   別の部屋のものを流し込む、といった使い回しは認証で落ちる
 * - 再送: 1 通ごとに乱数の IV (12 バイト) を使い、受け取った IV を覚えて同じものを拒否する。中身には送った時刻 (ts) を入れ、
 *   受け取った側の時計と 10 分以上ずれていれば拒否する (古いものの再送)
 * - 相手の取り違え: 参加者は接続の試みごとに乱数の sid を作り、ホストの返事には同じ sid が入る (RelayPayload)
 *
 * 形式: Base64url(IV 12 バイト + 暗号文 + 認証タグ 16 バイト)。暗号文の中身は JSON (RelayPayload + ts)
 */

export type RelayDirection = 'toHost' | 'toGuest';

/** RTCIceCandidateInit のうち送るもの (DOM の型に頼らない) */
export interface RelayCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** full = 空き枠なし、version = バージョン違い (pv にホストのバージョン)、closed = ロビーが閉じた・受け付けをやめた */
export type RelayRejectReason = 'full' | 'version' | 'closed';

/**
 * 中継に流す中身。sid は参加者が接続の試みごとに作る乱数 (22 文字)。
 * offer (参加者 → ホスト) / answer (ホスト → 参加者) / cand (両方向、trickle ICE の候補) /
 * reject (ホスト → 参加者) / bye (参加者 → ホスト、やめた)
 */
export type RelayPayload =
  | { type: 'offer'; sid: string; pv: number; sdp: string }
  | { type: 'answer'; sid: string; lobbyId: number; slot: number; sdp: string }
  | { type: 'cand'; sid: string; c: RelayCandidate }
  | { type: 'reject'; sid: string; reason: RelayRejectReason; pv: number }
  | { type: 'bye'; sid: string };

/** malformed = 形が違う、auth = 認証の失敗 (別の鍵・書き換え・向き違い)、stale = 時刻が離れすぎ、replay = 同じものが 2 回届いた */
export type RelayOpenError = 'malformed' | 'auth' | 'stale' | 'replay';

export type RelayOpenResult = { ok: true; payload: RelayPayload; sentAt: number } | { ok: false; error: RelayOpenError };

/** 送った時刻と受け取った側の時計のずれの許容 (ms)。これより離れたものは古い再送として拒否する */
export const relayMaxClockSkewMs = 10 * 60 * 1000;

const ivBytes = 12;
const tagBytes = 16;
/** SDP の上限 (文字)。候補を除いた DataChannel だけの SDP は 400〜800 文字 */
const maxSdpChars = 3000;
const maxCandidateChars = 400;
/** 覚えておく IV の数の上限 (これを超えたら古いものから忘れる。忘れるのは時刻のずれの許容より古いものだけ) */
const maxSeenIvs = 20000;
const sidPattern = /^[A-Za-z0-9_-]{22}$/;
const rejectReasons: readonly RelayRejectReason[] = ['full', 'version', 'closed'];

const hkdfInfo = new TextEncoder().encode('PLO-relay-v1 aes-gcm');

/** 接続の試みの ID (sid) を作る */
export function createRelaySessionId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return encodeBase64url(b);
}

function isSid(v: unknown): v is string {
  return typeof v === 'string' && sidPattern.test(v);
}

function isSdp(v: unknown): v is string {
  return typeof v === 'string' && v.length <= maxSdpChars && v.startsWith('v=0');
}

function parseCandidateField(v: unknown): RelayCandidate | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.candidate !== 'string' || o.candidate.length > maxCandidateChars) return null;
  if (o.candidate !== '' && !o.candidate.startsWith('candidate:')) return null;
  const sdpMid = o.sdpMid === null || (typeof o.sdpMid === 'string' && o.sdpMid.length <= 32) ? (o.sdpMid as string | null) : undefined;
  const idx = o.sdpMLineIndex;
  const sdpMLineIndex = idx === null || (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < 16) ? (idx as number | null) : undefined;
  if (sdpMid === undefined || sdpMLineIndex === undefined) return null;
  return { candidate: o.candidate, sdpMid, sdpMLineIndex };
}

/** 復号した JSON を RelayPayload として確かめる (向きに合わない種類も拒否する) */
export function parseRelayPayload(v: unknown, direction: RelayDirection): RelayPayload | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isSid(o.sid)) return null;
  const sid = o.sid;
  const toHost = direction === 'toHost';
  switch (o.type) {
    case 'offer':
      return toHost && typeof o.pv === 'number' && Number.isInteger(o.pv) && isSdp(o.sdp) ? { type: 'offer', sid, pv: o.pv, sdp: o.sdp } : null;
    case 'answer': {
      if (toHost || !isSdp(o.sdp)) return null;
      const { lobbyId, slot } = o;
      if (typeof lobbyId !== 'number' || !Number.isInteger(lobbyId) || lobbyId < 0 || lobbyId > 0xffffffff) return null;
      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1 || slot > maxSlot) return null;
      return { type: 'answer', sid, lobbyId, slot, sdp: o.sdp };
    }
    case 'cand': {
      const c = parseCandidateField(o.c);
      return c ? { type: 'cand', sid, c } : null;
    }
    case 'reject':
      if (toHost || !rejectReasons.includes(o.reason as RelayRejectReason) || typeof o.pv !== 'number') return null;
      return { type: 'reject', sid, reason: o.reason as RelayRejectReason, pv: o.pv };
    case 'bye':
      return toHost ? { type: 'bye', sid } : null;
    default:
      return null;
  }
}

/**
 * 1 つの部屋の暗号化・復号 (と再送の検出)。受け取る側は同じインスタンスを使い続ける (受け取った IV を覚えるため)。
 *
 * ```ts
 * const cipher = await RelayCipher.create(link.roomId, link.key);
 * const data = await cipher.seal('toHost', { type: 'offer', sid, pv: protocolVersion, sdp });
 * const r = await cipher.open('toHost', data);   // ホスト側。r.ok なら r.payload
 * ```
 */
export class RelayCipher {
  private readonly aad: Record<RelayDirection, Uint8Array<ArrayBuffer>>;
  /** 受け取った IV と、忘れてよくなる時刻 (ms) */
  private readonly seenIvs = new Map<string, number>();

  private constructor(private readonly key: CryptoKey, roomId: string) {
    const enc = new TextEncoder();
    this.aad = {
      toHost: enc.encode(`PLO-relay-v1|${roomId}|toHost`),
      toGuest: enc.encode(`PLO-relay-v1|${roomId}|toGuest`),
    };
  }

  /** 部屋 ID と鍵 (どちらも Base64url 22 文字) から作る。形が違えば null */
  static async create(roomId: string, roomKey: string): Promise<RelayCipher | null> {
    if (!isRoomId(roomId) || !isRoomKey(roomKey)) return null;
    const raw = decodeBase64url(roomKey);
    if (!raw || raw.length !== roomKeyBytes) return null;
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(roomId), info: hkdfInfo },
      base,
      { name: 'AES-GCM', length: 128 },
      false,
      ['encrypt', 'decrypt'],
    );
    return new RelayCipher(key, roomId);
  }

  /** 暗号化する。now は送った時刻 (Date.now() の ms、確認用に差し替えられる) */
  async seal(direction: RelayDirection, payload: RelayPayload, now: number = Date.now()): Promise<string> {
    const iv = new Uint8Array(ivBytes);
    crypto.getRandomValues(iv);
    const plain = new TextEncoder().encode(JSON.stringify({ ...payload, ts: now }));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad[direction] }, this.key, plain));
    const out = new Uint8Array(ivBytes + sealed.length);
    out.set(iv);
    out.set(sealed, ivBytes);
    return encodeBase64url(out);
  }

  /** 復号して確かめる。now は受け取った時刻 (Date.now() の ms) */
  async open(direction: RelayDirection, data: string, now: number = Date.now()): Promise<RelayOpenResult> {
    const bytes = decodeBase64url(data);
    if (!bytes || bytes.length < ivBytes + tagBytes + 2) return { ok: false, error: 'malformed' };
    const iv = bytes.subarray(0, ivBytes);
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: this.aad[direction] }, this.key, bytes.subarray(ivBytes)),
      );
    } catch {
      return { ok: false, error: 'auth' };
    }
    let obj: unknown;
    try {
      obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    } catch {
      return { ok: false, error: 'malformed' };
    }
    const ts = (obj as { ts?: unknown } | null)?.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return { ok: false, error: 'malformed' };
    if (Math.abs(now - ts) > relayMaxClockSkewMs) return { ok: false, error: 'stale' };
    const ivKey = encodeBase64url(iv);
    this.forgetOldIvs(now);
    if (this.seenIvs.has(ivKey)) return { ok: false, error: 'replay' };
    const payload = parseRelayPayload(obj, direction);
    if (!payload) return { ok: false, error: 'malformed' };
    // 送った時刻の許容を過ぎれば stale で落ちるので、そこまで覚えておけばよい
    this.seenIvs.set(ivKey, Math.max(now, ts) + relayMaxClockSkewMs * 2);
    return { ok: true, payload, sentAt: ts };
  }

  private forgetOldIvs(now: number): void {
    if (this.seenIvs.size < maxSeenIvs) return;
    for (const [iv, forgetAt] of this.seenIvs) {
      if (forgetAt <= now || this.seenIvs.size >= maxSeenIvs) this.seenIvs.delete(iv);
      else break;
    }
  }
}
