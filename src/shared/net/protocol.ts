import { physicsVersion } from '../carParams';

/**
 * オンライン対戦の通信の決まりごと (network.md)。バージョン番号と上限値はここだけに置く。
 * DOM に依存しない (ホストの Worker と node の確認スクリプトからも使う)。
 */

/** メッセージ形式 (JSON のメッセージ・バイナリ形式) のバージョン。形式を変えたら上げる (1〜65) */
export const netFormatVersion = 1;

/**
 * プロトコルのバージョン (招待・返答コードと join に入れる 2 バイトの番号)。
 * 通信の形式と物理の両方が一致しないと一緒に走れないので、2 つを合わせた 1 つの番号にする (例: 1003 = 形式 1・物理 3)
 */
export const protocolVersion = netFormatVersion * 1000 + physicsVersion;

/** 招待・返答コードの文字列形式のバージョン (`PLO1I.` の `1`)。中身のバイナリの並びを変えたら上げる */
export const codeFormatVersion = 1;

/** 最大人数 (ホスト 1 + 参加者 7) */
export const maxPlayers = 8;
/** 参加者の枠番号は 1〜7 (0 はホスト本人) */
export const maxSlot = 7;

/** DataChannel の id (negotiated: true で両側が同じ id で作る) */
export const stateChannelId = 0;
export const eventChannelId = 1;

/** state チャンネルの 1 メッセージの上限 (バイト)。超えたものは受け取らない */
export const stateMaxBytes = 1000;
/** event チャンネルの 1 メッセージの上限 (バイト) */
export const eventMaxBytes = 16 * 1024;
/** state の送信で、送信待ちがこれを超えていたらその回は捨てる (バイト) */
export const stateBufferLimit = 16 * 1024;
