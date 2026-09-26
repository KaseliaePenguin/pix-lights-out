import { encodeBase64url } from './base64url';
import { hostSecretBytes, isRoomId, isRoomKey, roomIdOfSecret, roomKeyBytes } from './relayProtocol';

/**
 * 中継を使う招待リンク (network.md「中継による接続」)。ロビーに 1 本で、全員に同じリンクを送る。
 *   `<ページの URL>#room=<部屋 ID>.<鍵>`   (部屋 ID・鍵は Base64url 22 文字ずつ)
 * フラグメントはサーバー (ゲームの配信先) に送られない。部屋 ID は中継に送るが、鍵はどこにも送らない (暗号化にだけ使う)。
 * 従来の招待リンク (`#join=PLO1I.…`、connectionCode.ts) とは前置きで見分ける
 */

export interface RoomLink {
  roomId: string;
  key: string;
}

/** ホストだけが持つ値。secret は中継に部屋を作るときに送る (リンクには入れない) */
export interface RoomCredentials extends RoomLink {
  secret: string;
}

const roomLinkMark = '#room=';
const roomLinkPattern = /#room=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/;
/** 空白・改行とゼロ幅文字 (チャットで混ざる) */
const ignoredChars = /[\s​-‍⁠﻿]+/g;

function randomToken(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return encodeBase64url(b);
}

/** 部屋を作るための値 (ホストの秘密 256 ビット、部屋 ID = 秘密のハッシュ、鍵 128 ビット) */
export async function createRoomCredentials(): Promise<RoomCredentials> {
  const secret = randomToken(hostSecretBytes);
  const roomId = await roomIdOfSecret(secret);
  if (!roomId) throw new Error('failed to derive room id');
  return { roomId, key: randomToken(roomKeyBytes), secret };
}

/** 招待リンクを作る。pageUrl は origin + pathname (フラグメントが付いていれば除く) */
export function roomLinkOf(pageUrl: string, room: RoomLink): string {
  return `${pageUrl.replace(/#.*$/, '')}${roomLinkMark}${room.roomId}.${room.key}`;
}

/** URL のフラグメント (location.hash) から読む。中継の招待リンクでなければ null */
export function roomLinkFromHash(hash: string): RoomLink | null {
  if (!hash.startsWith(roomLinkMark)) return null;
  return parseRoomLink(hash);
}

/** フラグメントが中継の招待リンクの形か (中身が壊れていても前置きが合えば true。URL から消すかどうかの判定用) */
export function isRoomLinkHash(hash: string): boolean {
  return hash.startsWith(roomLinkMark);
}

/**
 * 貼り付けた文字 (リンクだけ・前後に文があるもの・折り返しで切れたもの) から部屋 ID と鍵を取り出す。見つからなければ null
 */
export function parseRoomLink(text: string): RoomLink | null {
  for (const s of [text, text.replace(ignoredChars, '')]) {
    const m = roomLinkPattern.exec(s);
    if (m && isRoomId(m[1]) && isRoomKey(m[2])) return { roomId: m[1], key: m[2] };
  }
  return null;
}
