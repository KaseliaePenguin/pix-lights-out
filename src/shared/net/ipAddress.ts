/**
 * 接続先候補のアドレス (IPv4 / IPv6 / mDNS 名) とバイト列の相互変換。
 * mDNS 名はブラウザがローカル IP を隠すために付ける `<UUID>.local` 形式 (Chrome・Firefox 共通)。
 */

export type AddressKind = 'ipv4' | 'ipv6' | 'mdns';

const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const mdnsPattern = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
const hexGroupPattern = /^[0-9a-f]{1,4}$/i;

export function parseIpv4(text: string): Uint8Array<ArrayBuffer> | null {
  const m = ipv4Pattern.exec(text);
  if (!m) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const v = Number(m[i + 1]);
    if (v > 255) return null;
    out[i] = v;
  }
  return out;
}

export function formatIpv4(bytes: Uint8Array): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/** 省略形 (`::`)・末尾の IPv4 表記に対応する。ゾーン (`%eth0`) 付きは扱わない */
export function parseIpv6(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.includes('%')) return null;
  let s = text;
  const groups: number[] = [];
  let v4Tail: Uint8Array | null = null;
  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0 && s.slice(lastColon + 1).includes('.')) {
    v4Tail = parseIpv4(s.slice(lastColon + 1));
    if (!v4Tail) return null;
    s = s.slice(0, lastColon + 1) + '0:0';
  }
  const doubleAt = s.indexOf('::');
  if (doubleAt !== s.lastIndexOf('::')) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!hexGroupPattern.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  if (doubleAt >= 0) {
    const head = parseGroups(s.slice(0, doubleAt));
    const tail = parseGroups(s.slice(doubleAt + 2));
    if (!head || !tail || head.length + tail.length > 7) return null;
    groups.push(...head);
    for (let i = head.length + tail.length; i < 8; i++) groups.push(0);
    groups.push(...tail);
  } else {
    const all = parseGroups(s);
    if (!all || all.length !== 8) return null;
    groups.push(...all);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = groups[i] >> 8;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  if (v4Tail) out.set(v4Tail, 12);
  return out;
}

/** RFC 5952 の表記 (小文字、最長の 0 の並びを `::` に) */
export function formatIpv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push((bytes[i * 2] << 8) | bytes[i * 2 + 1]);
  let bestStart = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = (list: number[]) => list.map((g) => g.toString(16)).join(':');
  if (bestStart < 0) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLen))}`;
}

export function parseMdnsName(text: string): Uint8Array<ArrayBuffer> | null {
  const m = mdnsPattern.exec(text);
  if (!m) return null;
  const hex = m.slice(1).join('');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function formatMdnsName(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.local`;
}

/** アドレスの種類とバイト列。コードに詰められない形なら null */
export function packAddress(text: string): { kind: AddressKind; bytes: Uint8Array<ArrayBuffer> } | null {
  const v4 = parseIpv4(text);
  if (v4) return { kind: 'ipv4', bytes: v4 };
  const mdns = parseMdnsName(text);
  if (mdns) return { kind: 'mdns', bytes: mdns };
  const v6 = text.includes(':') ? parseIpv6(text) : null;
  if (v6) return { kind: 'ipv6', bytes: v6 };
  return null;
}

export function unpackAddress(kind: AddressKind, bytes: Uint8Array): string {
  if (kind === 'ipv4') return formatIpv4(bytes);
  if (kind === 'ipv6') return formatIpv6(bytes);
  return formatMdnsName(bytes);
}

/** 比べるための正規化 (IPv6 の表記ゆれ・mDNS 名の大文字小文字をそろえる)。読めなければそのまま */
export function normalizeAddress(text: string): string {
  const packed = packAddress(text);
  return packed ? unpackAddress(packed.kind, packed.bytes) : text;
}

/**
 * LAN の中のアドレスか (mDNS 名、プライベート IPv4、リンクローカル、IPv6 のユニークローカル)。
 * キャリアグレード NAT の 100.64.0.0/10 は LAN ではないので含めない
 */
export function isPrivateAddress(text: string): boolean {
  if (text.toLowerCase().endsWith('.local')) return true;
  const v4 = parseIpv4(text);
  if (v4) {
    return v4[0] === 10 || v4[0] === 127
      || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31)
      || (v4[0] === 192 && v4[1] === 168)
      || (v4[0] === 169 && v4[1] === 254);
  }
  const v6 = text.includes(':') ? parseIpv6(text) : null;
  if (v6) {
    const isLoopback = v6.every((b, i) => b === (i === 15 ? 1 : 0));
    return isLoopback || (v6[0] & 0xfe) === 0xfc || (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80);
  }
  return false;
}
