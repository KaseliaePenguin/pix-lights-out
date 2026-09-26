import { decodeBase64url, encodeBase64url } from './base64url';

/**
 * 中継 (シグナリング、network.md「中継による接続」) の決まりごと。ゲーム (src/net/, src/host/) と
 * 中継の Worker (signaling/) の両方がこのファイルを使う。DOM に依存しない。
 *
 * 中継は部屋 (ロビー) ごとに 1 つの Durable Object で、ホストと参加者の WebSocket の間で「中身の読めない文字列」を
 * 受け渡すだけ。中身 (接続情報) は部屋の鍵で暗号化してあり (relayCrypto.ts)、鍵は招待リンクのフラグメントにだけ入る。
 *
 * 接続: `<中継の URL>/rooms/<部屋 ID>` に WebSocket。最初の 1 通で役割を名乗る。
 *   ホスト:  { t: 'host', secret }   部屋 ID = roomIdOfSecret(secret)。秘密を知らない人はホストになれない
 *   参加者:  { t: 'join' }
 * そのあと:
 *   送る:    { t: 'send', to, data }  参加者の to は無視され、必ずホストへ届く (参加者同士は話せない)
 *   外す:    { t: 'kick', peer }      ホストだけ
 *   受け取る: ready / joined / left / msg (RelayServerFrame)
 * 断られたとき・終わったときは WebSocket の close コード (relayCloseCodes) で理由を伝える。
 * 生存確認に 'ping' を送ると 'pong' が返る (Durable Object を起こさない自動応答)。
 */

/** 中継のプロトコルのバージョン (URL の /rooms/ の形・フレームの形を変えたら上げる) */
export const relayProtocolVersion = 1;

export const relayLimits = {
  /** 1 通の上限 (バイト)。offer の SDP (候補を除く) を暗号化して約 1KB */
  maxFrameBytes: 4096,
  /** 同時につないでいられる参加者の数 (ホスト + 7)。つながった参加者は WebSocket を閉じるので、入ろうとしている人の数 */
  maxGuests: 7,
  /** 名乗る前の接続の数の上限 (これを超えたら新しい接続を断る) */
  maxPendingSockets: 8,
  /** 部屋の寿命 (ホストが部屋を作ってから)。過ぎたら全員を切る */
  roomLifetimeMs: 30 * 60 * 1000,
  /** 接続してから名乗るまで */
  helloTimeoutMs: 10 * 1000,
  /** 送信回数: 短い間の上限 (burstWindowMs あたり burstCount 通) と、1 本の接続での合計 */
  burstWindowMs: 5000,
  burstCount: 40,
  maxGuestFrames: 300,
  maxHostFrames: 3000,
} as const;

/**
 * close コード (4000〜4999 はアプリ用)。
 * badRequest = 形が違う、unauthorized = ホストの秘密が違う、kicked = ホストが外した、noRoom = 部屋がない (ホストがいない)、
 * expired = 部屋の寿命切れ、full = 満員、hostLeft = ホストが抜けた (部屋が閉じた)、replaced = 同じホストが別の接続で入り直した、
 * tooLarge = 1 通が大きすぎる、rateLimited = 送信回数の上限、helloTimeout = 名乗らなかった、busy = 名乗る前の接続が多すぎる
 */
export const relayCloseCodes = {
  badRequest: 4000,
  unauthorized: 4001,
  kicked: 4003,
  noRoom: 4004,
  expired: 4008,
  full: 4009,
  hostLeft: 4010,
  replaced: 4011,
  tooLarge: 4013,
  rateLimited: 4029,
  helloTimeout: 4408,
  busy: 4503,
} as const;

export type RelayCloseName = keyof typeof relayCloseCodes;

/** close コードから名前を引く (アプリ用でないコードは null) */
export function relayCloseNameOf(code: number): RelayCloseName | null {
  for (const [name, value] of Object.entries(relayCloseCodes)) if (value === code) return name as RelayCloseName;
  return null;
}

/** 参加者の番号 (中継が付ける。1 から数え、部屋の中で使い回さない)。ホストは 0 */
export type RelayPeerId = number;

export type RelayClientFrame =
  | { t: 'host'; secret: string }
  | { t: 'join' }
  | { t: 'send'; to: RelayPeerId; data: string }
  | { t: 'kick'; peer: RelayPeerId };

export type RelayServerFrame =
  /** 名乗りが通った。remainingMs = 部屋の寿命の残り、peer = 自分の番号 (ホストは 0) */
  | { t: 'ready'; role: 'host' | 'guest'; peer: RelayPeerId; remainingMs: number }
  /** 参加者が入った / 抜けた (ホストにだけ届く) */
  | { t: 'joined'; peer: RelayPeerId }
  | { t: 'left'; peer: RelayPeerId }
  | { t: 'msg'; from: RelayPeerId; data: string };

/** 生存確認 (自動応答) */
export const relayPingText = 'ping';
export const relayPongText = 'pong';

/** 部屋 ID・鍵・ホストの秘密の長さ (バイト)。部屋 ID と鍵は 128 ビット、秘密は 256 ビット */
export const roomIdBytes = 16;
export const roomKeyBytes = 16;
export const hostSecretBytes = 32;

/** Base64url で 22 文字 (16 バイト) */
const roomTokenPattern = /^[A-Za-z0-9_-]{22}$/;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;

export function isRoomId(text: string): boolean {
  return roomTokenPattern.test(text);
}

export function isRoomKey(text: string): boolean {
  return roomTokenPattern.test(text);
}

const roomIdLabel = new TextEncoder().encode('PLO-room-v1.');

/**
 * ホストの秘密から部屋 ID を作る (SHA-256 の先頭 16 バイト)。中継は同じ計算で、名乗ったホストが本物かを確かめる。
 * 部屋 ID から秘密は逆算できないので、招待リンク (部屋 ID と鍵) を知っている参加者もホストにはなれない。
 * 秘密の形が違えば null
 */
export async function roomIdOfSecret(secret: string): Promise<string | null> {
  if (!secretPattern.test(secret)) return null;
  const bytes = decodeBase64url(secret);
  if (!bytes || bytes.length !== hostSecretBytes) return null;
  const input = new Uint8Array(roomIdLabel.length + bytes.length);
  input.set(roomIdLabel);
  input.set(bytes, roomIdLabel.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return encodeBase64url(digest.subarray(0, roomIdBytes));
}

function isPeerId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff;
}

/** クライアントのフレームを読む (中継が使う)。形が違えば null */
export function parseRelayClientFrame(text: string): RelayClientFrame | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  switch (o.t) {
    case 'host':
      return typeof o.secret === 'string' ? { t: 'host', secret: o.secret } : null;
    case 'join':
      return { t: 'join' };
    case 'send':
      return isPeerId(o.to) && typeof o.data === 'string' && o.data.length > 0 ? { t: 'send', to: o.to, data: o.data } : null;
    case 'kick':
      return isPeerId(o.peer) ? { t: 'kick', peer: o.peer } : null;
    default:
      return null;
  }
}

/** 中継からのフレームを読む (ゲームが使う)。形が違えば null */
export function parseRelayServerFrame(text: string): RelayServerFrame | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  switch (o.t) {
    case 'ready':
      if ((o.role !== 'host' && o.role !== 'guest') || !isPeerId(o.peer) || typeof o.remainingMs !== 'number') return null;
      return { t: 'ready', role: o.role, peer: o.peer, remainingMs: o.remainingMs };
    case 'joined':
    case 'left':
      return isPeerId(o.peer) ? { t: o.t, peer: o.peer } : null;
    case 'msg':
      return isPeerId(o.from) && typeof o.data === 'string' ? { t: 'msg', from: o.from, data: o.data } : null;
    default:
      return null;
  }
}

/** 文字列の UTF-8 でのバイト数が上限を超えるか (ASCII だけなら数えずに済ませる) */
export function isFrameTooLarge(text: string, limit: number = relayLimits.maxFrameBytes): boolean {
  return text.length > limit || (text.length * 3 > limit && new TextEncoder().encode(text).length > limit);
}
