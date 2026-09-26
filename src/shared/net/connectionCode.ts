import { decodeBase64url, encodeBase64url } from './base64url';
import { deflateRaw, inflateRaw, isCompressionAvailable } from './deflate';
import type { AddressKind } from './ipAddress';
import { packAddress, unpackAddress } from './ipAddress';
import { codeFormatVersion, maxSlot, protocolVersion } from './protocol';
import type { EssentialCandidate, SdpEssentials, SdpRole } from './sdp';
import { analyzeCandidates, buildSdp, extractEssentials, maxCodeCandidates, parseSdp } from './sdp';

/**
 * 招待コード (`PLO1I.`) と返答コード (`PLO1R.`) のエンコード・デコード (network.md「コードの形式と長さ」)。
 * 招待コードは招待リンク (`<ページの URL>#join=PLO1I.…`) にして渡す。貼り付けはリンクでもコードだけでも読める。
 *
 * 中身 (多バイトはビッグエンディアン):
 *   プロトコルのバージョン u16 / ロビー ID u32 / 枠番号 u8 / フラグ u8
 *   通常形式:   ufrag (長さ u8 + 文字) / pwd (長さ u8 + 文字) / 指紋 32 / 候補数 u8 + [種類 u8 + アドレス 4 or 16 + ポート u16]
 *   SDP 全文形式: SDP 全文を deflate (raw) したもの
 *   チェックサム u16 (CRC-16/CCITT-FALSE、ここより前の全バイト)
 */

export type CodeKind = 'invite' | 'reply';

/**
 * malformed = 壊れている (途中で切れた、PLO で始まらない、Base64url でない、チェックサム違い)、
 * wrongKind = 種類違い (招待を待っているのに返答など)、version = バージョン違い (コード形式またはプロトコル)、
 * unsupported = SDP 全文形式を展開できない環境 (CompressionStream がない)
 */
export type CodeError = 'malformed' | 'wrongKind' | 'version' | 'unsupported';

export interface CodeHeader {
  kind: CodeKind;
  protocolVersion: number;
  lobbyId: number;
  /** 1〜7 */
  slot: number;
  /** 発行した側の STUN の応答がなかった (同じ LAN の相手とだけつながる) */
  isStunUnreachable: boolean;
  /** 発行した側が対称 NAT の疑い */
  isSymmetricNatSuspected: boolean;
  /** SDP 全文形式 (想定外の SDP だったためのフォールバック) */
  isFullSdp: boolean;
}

export interface ConnectionCode extends CodeHeader {
  /** setRemoteDescription に渡す SDP */
  sdp: string;
  /** 相手の接続先候補 (「同じ LAN にいるのに失敗」の判定用) */
  candidates: EssentialCandidate[];
}

export type CodeCheckResult =
  | { ok: true; header: CodeHeader }
  | { ok: false; error: CodeError; kind: CodeKind | null; theirVersion: number | null };

export type CodeDecodeResult =
  | { ok: true; code: ConnectionCode }
  | { ok: false; error: CodeError; kind: CodeKind | null; theirVersion: number | null };

export interface ConnectionCodeInput {
  kind: CodeKind;
  lobbyId: number;
  slot: number;
  /** 候補の収集を終えた localDescription.sdp */
  sdp: string;
  /** 省略時は SDP の候補から判定する */
  isStunUnreachable?: boolean;
  isSymmetricNatSuspected?: boolean;
  /** 確認用: 値を取り出せる SDP でも全文形式にする */
  forceFullSdp?: boolean;
}

const flagStunUnreachable = 1;
const flagSymmetricNat = 2;
const flagFullSdp = 4;

const headerBytes = 8;
const checksumBytes = 2;
/** SDP 全文形式で展開する上限 (壊れたデータ・悪意のあるデータで大きく膨らむのを防ぐ) */
const maxSdpBytes = 16 * 1024;

const kindLetters: Record<CodeKind, string> = { invite: 'I', reply: 'R' };
const addressKinds: readonly AddressKind[] = ['ipv4', 'ipv6', 'mdns'];
const addressLengths: Record<AddressKind, number> = { ipv4: 4, ipv6: 16, mdns: 16 };
const kindSrflxBit = 0x80;
/** 空白・改行とゼロ幅文字 (チャットで混ざる) */
const ignoredChars = /[\s​-‍⁠﻿]+/g;
const codePattern = /PLO(\d+)([A-Z])\.([A-Za-z0-9_-]*)/;

function roleOf(kind: CodeKind): SdpRole {
  return kind === 'invite' ? 'offer' : 'answer';
}

/** CRC-16/CCITT-FALSE */
function crc16(bytes: Uint8Array, length: number): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** o= 行の番号。コードには入れず、ロビー ID・枠・役割から決める */
function sessionIdOf(lobbyId: number, slot: number, kind: CodeKind): string {
  return String(lobbyId * 16 + slot * 2 + (kind === 'reply' ? 1 : 0) + 1);
}

/** ロビー ID (32 ビットの乱数)。ホストがロビーを作るときに 1 回呼ぶ */
export function createLobbyId(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

class ByteWriter {
  private buf = new Uint8Array(256);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.length++] = v & 0xff;
  }

  u16(v: number): void {
    this.u8(v >> 8);
    this.u8(v);
  }

  u32(v: number): void {
    this.u16(v >>> 16);
    this.u16(v & 0xffff);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  ascii(text: string): void {
    this.u8(text.length);
    for (let i = 0; i < text.length; i++) this.u8(text.charCodeAt(i));
  }

  finish(): Uint8Array<ArrayBuffer> {
    this.u16(crc16(this.buf, this.length));
    return this.buf.slice(0, this.length);
  }
}

class ByteReader {
  pos: number;

  constructor(private readonly bytes: Uint8Array, start: number, private readonly end: number) {
    this.pos = start;
  }

  has(n: number): boolean {
    return this.pos + n <= this.end;
  }

  u8(): number {
    return this.bytes[this.pos++];
  }

  u16(): number {
    const v = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1];
    this.pos += 2;
    return v;
  }

  take(n: number): Uint8Array {
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  ascii(): string | null {
    if (!this.has(1)) return null;
    const n = this.u8();
    if (n === 0 || !this.has(n)) return null;
    return String.fromCharCode(...this.take(n));
  }
}

/** 値をバイナリに詰める。詰められない候補があれば null (全文形式にする) */
function writeEssentials(w: ByteWriter, e: SdpEssentials): boolean {
  w.ascii(e.ufrag);
  w.ascii(e.pwd);
  w.bytes(e.fingerprint);
  if (e.candidates.length > maxCodeCandidates) return false;
  w.u8(e.candidates.length);
  for (const c of e.candidates) {
    const packed = packAddress(c.address);
    if (!packed) return false;
    w.u8(addressKinds.indexOf(packed.kind) | (c.type === 'srflx' ? kindSrflxBit : 0));
    w.bytes(packed.bytes);
    w.u16(c.port);
  }
  return true;
}

function readEssentials(r: ByteReader): SdpEssentials | null {
  const ufrag = r.ascii();
  const pwd = r.ascii();
  if (!ufrag || !pwd || !/^[A-Za-z0-9+/]+$/.test(ufrag + pwd) || !r.has(33)) return null;
  const fingerprint = r.take(32).slice();
  const count = r.u8();
  if (count > maxCodeCandidates) return null;
  const candidates: EssentialCandidate[] = [];
  for (let i = 0; i < count; i++) {
    if (!r.has(1)) return null;
    const kindByte = r.u8();
    const addressKind = addressKinds[kindByte & 0x7f];
    if (!addressKind) return null;
    const n = addressLengths[addressKind];
    if (!r.has(n + 2)) return null;
    const address = unpackAddress(addressKind, r.take(n));
    const port = r.u16();
    if (port === 0) return null;
    candidates.push({ type: kindByte & kindSrflxBit ? 'srflx' : 'host', address, port });
  }
  if (r.has(1)) return null;
  return { ufrag, pwd, fingerprint, candidates };
}

export async function encodeConnectionCode(input: ConnectionCodeInput): Promise<string> {
  if (!Number.isInteger(input.slot) || input.slot < 1 || input.slot > maxSlot) throw new Error(`invalid slot ${input.slot}`);
  const info = parseSdp(input.sdp);
  const analysis = analyzeCandidates(info.candidates);
  const isStunUnreachable = input.isStunUnreachable ?? analysis.isStunUnreachable;
  const isSymmetricNat = input.isSymmetricNatSuspected ?? analysis.isSymmetricNatSuspected;
  const essentials = input.forceFullSdp ? null : extractEssentials(info, roleOf(input.kind));

  const writeHeader = (w: ByteWriter, full: boolean) => {
    w.u16(protocolVersion);
    w.u32(input.lobbyId >>> 0);
    w.u8(input.slot);
    w.u8((isStunUnreachable ? flagStunUnreachable : 0) | (isSymmetricNat ? flagSymmetricNat : 0) | (full ? flagFullSdp : 0));
  };

  let bytes: Uint8Array | null = null;
  if (essentials) {
    const w = new ByteWriter();
    writeHeader(w, false);
    if (writeEssentials(w, essentials)) bytes = w.finish();
  }
  if (!bytes) {
    const w = new ByteWriter();
    writeHeader(w, true);
    w.bytes(await deflateRaw(new TextEncoder().encode(input.sdp)));
    bytes = w.finish();
  }
  return `PLO${codeFormatVersion}${kindLetters[input.kind]}.${encodeBase64url(bytes)}`;
}

type Parsed =
  | { ok: true; header: CodeHeader; bytes: Uint8Array<ArrayBuffer>; bodyEnd: number }
  | { ok: false; error: CodeError; kind: CodeKind | null; theirVersion: number | null };

/** 招待リンクのフラグメントの前置き (`#join=PLO1I.…`)。フラグメントはサーバーに送られない */
const inviteLinkMark = '#join=';

/** 招待リンク `<ページの URL>#join=PLO1I.…` を作る。pageUrl は origin + pathname (フラグメントが付いていれば除く) */
export function inviteLinkOf(pageUrl: string, inviteCode: string): string {
  return `${pageUrl.replace(/#.*$/, '')}${inviteLinkMark}${inviteCode}`;
}

/** URL のフラグメント (location.hash) から招待コードを取り出す。招待リンクでなければ null */
export function inviteCodeFromHash(hash: string): string | null {
  if (!hash.startsWith(inviteLinkMark)) return null;
  return extractConnectionCode(hash);
}

/**
 * 貼り付けた文字 (コードだけ・招待リンク・前後の文や改行を含むもの) から `PLO…` のコードを取り出す。見つからなければ null。
 * 招待リンクなら `#join=` より後から探す (ページの URL に似た文字があっても取り違えない)。
 * 空白・改行を除いてつないだもの (チャットの折り返しで切れたコード) と、空白で区切ったもの (後ろに英単語が続くリンク) の
 * 両方を試し、チェックサムが合うほうを返す
 */
export function extractConnectionCode(text: string): string | null {
  const candidates: string[] = [];
  const add = (s: string) => {
    const at = s.lastIndexOf(inviteLinkMark);
    const m = codePattern.exec(at >= 0 ? s.slice(at + inviteLinkMark.length) : s);
    if (m && !candidates.includes(m[0])) candidates.push(m[0]);
  };
  add(text.replace(ignoredChars, ''));
  for (const token of text.split(ignoredChars)) add(token);
  return candidates.find(hasValidChecksum) ?? candidates[0] ?? null;
}

function hasValidChecksum(code: string): boolean {
  const m = codePattern.exec(code);
  const bytes = m ? decodeBase64url(m[3]) : null;
  if (!bytes || bytes.length < headerBytes + checksumBytes) return false;
  const end = bytes.length - checksumBytes;
  return crc16(bytes, end) === ((bytes[end] << 8) | bytes[end + 1]);
}

function parse(text: string, expectedKind: CodeKind | null): Parsed {
  const fail = (error: CodeError, kind: CodeKind | null = null, theirVersion: number | null = null): Parsed =>
    ({ ok: false, error, kind, theirVersion });
  const code = extractConnectionCode(text);
  const m = code === null ? null : codePattern.exec(code);
  if (!m) return fail('malformed');
  const kind = m[2] === 'I' ? 'invite' : m[2] === 'R' ? 'reply' : null;
  if (!kind) return fail('malformed');
  if (Number(m[1]) !== codeFormatVersion) return fail('version', kind);
  const bytes = decodeBase64url(m[3]);
  if (!bytes || bytes.length < headerBytes + checksumBytes) return fail('malformed', kind);
  const bodyEnd = bytes.length - checksumBytes;
  if (crc16(bytes, bodyEnd) !== ((bytes[bodyEnd] << 8) | bytes[bodyEnd + 1])) return fail('malformed', kind);
  if (expectedKind && kind !== expectedKind) return fail('wrongKind', kind);
  const view = new DataView(bytes.buffer);
  const theirVersion = view.getUint16(0);
  if (theirVersion !== protocolVersion) return fail('version', kind, theirVersion);
  const slot = bytes[6];
  if (slot < 1 || slot > maxSlot) return fail('malformed', kind);
  const flags = bytes[7];
  return {
    ok: true,
    bytes,
    bodyEnd,
    header: {
      kind,
      protocolVersion: theirVersion,
      lobbyId: view.getUint32(2),
      slot,
      isStunUnreachable: (flags & flagStunUnreachable) !== 0,
      isSymmetricNatSuspected: (flags & flagSymmetricNat) !== 0,
      isFullSdp: (flags & flagFullSdp) !== 0,
    },
  };
}

/**
 * 形式・種類・バージョンだけを確かめる (同期)。貼り付けた瞬間の判定と、返答コードの振り分け (lobbyId・slot) に使う。
 * expectedKind を渡すと、違う種類なら wrongKind を返す
 */
export function checkConnectionCode(text: string, expectedKind: CodeKind | null = null): CodeCheckResult {
  const p = parse(text, expectedKind);
  return p.ok ? { ok: true, header: p.header } : p;
}

/** コードを読み、setRemoteDescription に渡す SDP を組み立てる */
export async function decodeConnectionCode(text: string, expectedKind: CodeKind | null = null): Promise<CodeDecodeResult> {
  const p = parse(text, expectedKind);
  if (!p.ok) return p;
  const { header, bytes, bodyEnd } = p;
  const fail = (error: CodeError): CodeDecodeResult => ({ ok: false, error, kind: header.kind, theirVersion: header.protocolVersion });
  if (header.isFullSdp) {
    if (!isCompressionAvailable()) return fail('unsupported');
    const raw = await inflateRaw(bytes.slice(headerBytes, bodyEnd), maxSdpBytes);
    if (!raw) return fail('malformed');
    let sdp: string;
    try {
      sdp = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return fail('malformed');
    }
    if (!sdp.startsWith('v=0')) return fail('malformed');
    const candidates: EssentialCandidate[] = [];
    for (const c of parseSdp(sdp).candidates) {
      if (c.type === 'host' || c.type === 'srflx') candidates.push({ type: c.type, address: c.address, port: c.port });
    }
    return { ok: true, code: { ...header, sdp, candidates } };
  }
  const essentials = readEssentials(new ByteReader(bytes, headerBytes, bodyEnd));
  if (!essentials) return fail('malformed');
  const sdp = buildSdp(essentials, roleOf(header.kind), sessionIdOf(header.lobbyId, header.slot, header.kind));
  return { ok: true, code: { ...header, sdp, candidates: essentials.candidates } };
}
