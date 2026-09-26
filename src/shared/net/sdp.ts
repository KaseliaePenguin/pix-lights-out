import { isPrivateAddress, normalizeAddress } from './ipAddress';

/**
 * SDP から接続に必要な値を取り出す / ひな形から SDP を組み立て直す (network.md「コードの形式と長さ」)。
 * DataChannel だけの接続 (m=application が 1 つ) を前提にし、Chrome・Firefox の形式に合わせる。
 */

export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

export interface SdpCandidate {
  foundation: string;
  component: number;
  /** 小文字 ('udp' / 'tcp') */
  protocol: string;
  priority: number;
  address: string;
  port: number;
  type: CandidateType;
  /** srflx の元アドレス。ブラウザが隠すときは 0.0.0.0 / 0 になる。書かれていなければ null */
  relatedAddress: string | null;
  relatedPort: number | null;
}

export interface SdpInfo {
  ufrag: string | null;
  pwd: string | null;
  fingerprintAlgorithm: string | null;
  /** SHA-256 のときだけ 32 バイト */
  fingerprint: Uint8Array<ArrayBuffer> | null;
  setup: string | null;
  mid: string | null;
  sctpPort: number | null;
  /** m= 行 (`m=` を除いた中身) */
  mediaLines: string[];
  candidates: SdpCandidate[];
}

/** コードに詰める値 (固定の値はひな形側に持つ) */
export interface SdpEssentials {
  ufrag: string;
  pwd: string;
  /** SHA-256 の指紋 32 バイト */
  fingerprint: Uint8Array;
  candidates: EssentialCandidate[];
}

export interface EssentialCandidate {
  type: 'host' | 'srflx';
  address: string;
  port: number;
}

/** offer = 招待 (ホスト)、answer = 返答 (参加者) */
export type SdpRole = 'offer' | 'answer';

const candidateTypes: readonly string[] = ['host', 'srflx', 'prflx', 'relay'];
/** ICE の ufrag / pwd に使える文字 (RFC 8839 ice-char) */
const iceCharsPattern = /^[A-Za-z0-9+/]+$/;

/** `a=candidate:...` / `candidate:...` の 1 行を読む。読めなければ null */
export function parseCandidate(line: string): SdpCandidate | null {
  let s = line.trim();
  if (s.startsWith('a=')) s = s.slice(2);
  if (!s.startsWith('candidate:')) return null;
  const f = s.slice('candidate:'.length).split(/\s+/);
  if (f.length < 8 || f[6] !== 'typ') return null;
  const component = Number(f[1]);
  const priority = Number(f[3]);
  const port = Number(f[5]);
  const type = f[7];
  if (!Number.isInteger(component) || !Number.isFinite(priority) || !Number.isInteger(port)) return null;
  if (!candidateTypes.includes(type)) return null;
  let relatedAddress: string | null = null;
  let relatedPort: number | null = null;
  for (let i = 8; i + 1 < f.length; i += 2) {
    if (f[i] === 'raddr') relatedAddress = f[i + 1];
    else if (f[i] === 'rport') relatedPort = Number(f[i + 1]);
  }
  return {
    foundation: f[0], component, protocol: f[2].toLowerCase(), priority, address: f[4], port,
    type: type as CandidateType, relatedAddress, relatedPort,
  };
}

function parseFingerprint(value: string): { algorithm: string; bytes: Uint8Array<ArrayBuffer> | null } {
  const [algorithm, hex = ''] = value.trim().split(/\s+/);
  const lower = algorithm.toLowerCase();
  if (lower !== 'sha-256') return { algorithm: lower, bytes: null };
  const parts = hex.split(':');
  if (parts.length !== 32) return { algorithm: lower, bytes: null };
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    if (!/^[0-9a-fA-F]{2}$/.test(parts[i])) return { algorithm: lower, bytes: null };
    bytes[i] = parseInt(parts[i], 16);
  }
  return { algorithm: lower, bytes };
}

/** SDP 全体を読む。セッション部・メディア部のどちらに書かれた値も拾う (Firefox は指紋をセッション部に書く) */
export function parseSdp(sdp: string): SdpInfo {
  const info: SdpInfo = {
    ufrag: null, pwd: null, fingerprintAlgorithm: null, fingerprint: null,
    setup: null, mid: null, sctpPort: null, mediaLines: [], candidates: [],
  };
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      info.mediaLines.push(line.slice(2));
    } else if (line.startsWith('a=candidate:')) {
      const c = parseCandidate(line);
      if (c) info.candidates.push(c);
    } else if (line.startsWith('a=ice-ufrag:')) {
      info.ufrag ??= line.slice('a=ice-ufrag:'.length);
    } else if (line.startsWith('a=ice-pwd:')) {
      info.pwd ??= line.slice('a=ice-pwd:'.length);
    } else if (line.startsWith('a=fingerprint:')) {
      if (info.fingerprint) continue;
      const fp = parseFingerprint(line.slice('a=fingerprint:'.length));
      info.fingerprintAlgorithm = fp.algorithm;
      info.fingerprint = fp.bytes;
    } else if (line.startsWith('a=setup:')) {
      info.setup ??= line.slice('a=setup:'.length);
    } else if (line.startsWith('a=mid:')) {
      info.mid ??= line.slice('a=mid:'.length);
    } else if (line.startsWith('a=sctp-port:')) {
      info.sctpPort ??= Number(line.slice('a=sctp-port:'.length));
    }
  }
  return info;
}

/** コードに入れる候補の上限 (network.md: UDP のみ、最大 6 個) */
export const maxCodeCandidates = 6;

/**
 * ひな形で組み立て直せる形なら、コードに詰める値を返す。想定外の形 (m 行が複数、mid が 0 でない、
 * setup が役割と合わない、SHA-256 以外の指紋など) なら null (呼び出し側は SDP 全文形式にする)
 */
export function extractEssentials(info: SdpInfo, role: SdpRole): SdpEssentials | null {
  if (info.mediaLines.length !== 1) return null;
  const m = info.mediaLines[0].split(/\s+/);
  if (m[0] !== 'application' || m[2] !== 'UDP/DTLS/SCTP' || m[3] !== 'webrtc-datachannel') return null;
  if (info.mid !== '0' || info.sctpPort !== templateSctpPort) return null;
  if (info.setup !== setupOf(role)) return null;
  if (!info.ufrag || !info.pwd || !info.fingerprint) return null;
  if (info.ufrag.length > 255 || info.pwd.length > 255) return null;
  if (!iceCharsPattern.test(info.ufrag) || !iceCharsPattern.test(info.pwd)) return null;

  const seen = new Set<string>();
  const hosts: SdpCandidate[] = [];
  const srflxs: SdpCandidate[] = [];
  for (const c of info.candidates) {
    if (c.protocol !== 'udp' || c.component !== 1) continue;
    if (c.type !== 'host' && c.type !== 'srflx') continue;
    if (c.port < 1 || c.port > 65535) continue;
    const key = `${normalizeAddress(c.address)} ${c.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (c.type === 'host' ? hosts : srflxs).push(c);
  }
  // 優先度の高い順。srflx は 3 個まで残し、残りを host で埋める (インターネット越しの候補を落とさないため)
  const byPriority = (a: SdpCandidate, b: SdpCandidate) => b.priority - a.priority;
  hosts.sort(byPriority);
  srflxs.sort(byPriority);
  const keptSrflx = srflxs.slice(0, Math.min(3, srflxs.length));
  const kept = [...hosts.slice(0, maxCodeCandidates - keptSrflx.length), ...keptSrflx];
  if (kept.length < maxCodeCandidates) kept.push(...srflxs.slice(keptSrflx.length, keptSrflx.length + maxCodeCandidates - kept.length));
  kept.sort(byPriority);
  return {
    ufrag: info.ufrag,
    pwd: info.pwd,
    fingerprint: info.fingerprint,
    candidates: kept.map((c) => ({ type: c.type as 'host' | 'srflx', address: c.address, port: c.port })),
  };
}

// ---------------------------------------------------------------- ひな形

export const templateSctpPort = 5000;
/** 受け取れる 1 メッセージの上限。実際のメッセージは 16KB 以下なので、Chrome の既定値に合わせておく */
const templateMaxMessageSize = 262144;

function setupOf(role: SdpRole): string {
  return role === 'offer' ? 'actpass' : 'active';
}

const typePreference = { host: 126, srflx: 100 } as const;

/** 組み立て直す候補の優先度。種類と並び順 (コードには優先度の高い順に入っている) から決める */
function templatePriority(type: 'host' | 'srflx', index: number): number {
  return typePreference[type] * 2 ** 24 + (65535 - index) * 2 ** 8 + 255;
}

function hexFingerprint(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (i ? ':' : '') + bytes[i].toString(16).toUpperCase().padStart(2, '0');
  return out;
}

/**
 * ひな形に値を埋めて SDP を組み立てる。sessionId は o= 行の番号 (数字 1〜18 桁)。
 * 候補は収集済みなので a=end-of-candidates を付ける (相手はそれ以上の候補を待たない)
 */
export function buildSdp(essentials: SdpEssentials, role: SdpRole, sessionId: string): string {
  const lines = [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
  ];
  essentials.candidates.forEach((c, i) => {
    const foundation = String((c.type === 'host' ? 1 : 2) * 10 + i);
    const related = c.type === 'srflx' ? ' raddr 0.0.0.0 rport 0' : '';
    lines.push(`a=candidate:${foundation} 1 udp ${templatePriority(c.type, i)} ${c.address} ${c.port} typ ${c.type}${related}`);
  });
  lines.push(
    'a=end-of-candidates',
    `a=ice-ufrag:${essentials.ufrag}`,
    `a=ice-pwd:${essentials.pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${hexFingerprint(essentials.fingerprint)}`,
    `a=setup:${setupOf(role)}`,
    'a=mid:0',
    `a=sctp-port:${templateSctpPort}`,
    `a=max-message-size:${templateMaxMessageSize}`,
  );
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- 候補の分析

export interface CandidateAnalysis {
  hostCount: number;
  srflxCount: number;
  /** srflx が 1 つもない (STUN の応答なし)。同じ LAN の相手とだけつながる */
  isStunUnreachable: boolean;
  /** 対称 NAT の疑い (同じ元から、2 つの STUN サーバーに違うポートで見えている) */
  isSymmetricNatSuspected: boolean;
}

function isHiddenAddress(address: string | null): boolean {
  return address === null || address === '0.0.0.0' || address === '::';
}

/**
 * 自分の候補から、STUN の応答なし・対称 NAT の疑いを判定する (network.md「原因の見分け」)。
 * ブラウザが srflx の元アドレス (raddr) を隠すときは、同じ外向き IP に違うポートが 2 つ以上あることで判定する
 * (その場合、LAN のアダプターが複数あると誤って疑いありになることがある)
 */
export function analyzeCandidates(candidates: readonly SdpCandidate[]): CandidateAnalysis {
  let hostCount = 0;
  let srflxCount = 0;
  const portsByBase = new Map<string, Set<number>>();
  for (const c of candidates) {
    if (c.protocol !== 'udp') continue;
    if (c.type === 'host') hostCount++;
    if (c.type !== 'srflx') continue;
    srflxCount++;
    const base = isHiddenAddress(c.relatedAddress) || !c.relatedPort
      ? `ip ${normalizeAddress(c.address)}`
      : `base ${normalizeAddress(c.relatedAddress!)} ${c.relatedPort}`;
    let ports = portsByBase.get(base);
    if (!ports) portsByBase.set(base, (ports = new Set()));
    ports.add(c.port);
  }
  let isSymmetricNatSuspected = false;
  for (const ports of portsByBase.values()) if (ports.size >= 2) isSymmetricNatSuspected = true;
  return { hostCount, srflxCount, isStunUnreachable: srflxCount === 0, isSymmetricNatSuspected };
}

/** 双方の srflx に同じ IP がある (同じルーターの内側にいる) か。「同じ LAN にいるのに失敗」の判定に使う */
export function hasSharedPublicAddress(a: readonly { type: string; address: string }[], b: readonly { type: string; address: string }[]): boolean {
  const mine = new Set(a.filter((c) => c.type === 'srflx').map((c) => normalizeAddress(c.address)));
  return b.some((c) => c.type === 'srflx' && mine.has(normalizeAddress(c.address)));
}

export type NetRoute = 'lan' | 'internet';

/**
 * 実際に使われている候補の組から接続経路を決める (network.md「同一 LAN の場合」)。
 * host 同士なら LAN。ただし相手のアドレスがグローバル IP (IPv6 の直接接続など) ならインターネット扱い。
 * 同じ LAN では相手が mDNS を解決する前に prflx (通信してみて分かった候補) として見えることがあるので、
 * 自分が host で相手が prflx のときはアドレスがプライベートなら LAN とする
 */
export function classifyRoute(localType: string, remoteType: string, remoteAddress: string | null): NetRoute {
  if (localType !== 'host') return 'internet';
  if (remoteType === 'host') return !remoteAddress || isPrivateAddress(remoteAddress) ? 'lan' : 'internet';
  if (remoteType === 'prflx') return remoteAddress && isPrivateAddress(remoteAddress) ? 'lan' : 'internet';
  return 'internet';
}
