// ヘッドレスの確認: オンライン対戦の通信部品 (src/shared/net/、src/net/LoopbackTransport.ts) を node で動かして確かめる。
//   node scripts/sim-net.mjs
// 招待・返答コードの往復 (Chrome・Firefox 形式の SDP)、コードの長さ、壊れたコードの判定、バイナリ形式、
// LoopbackTransport での ping / pong と時刻合わせ。WebRTC そのものはブラウザでしか確かめられない。
// TypeScript を esbuild (vite に同梱) でまとめてから読み込む (sim-lap.mjs と同じ方法)。ゲーム本体では使わない。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const entry = `
export * from './src/shared/net/protocol';
export * from './src/shared/net/base64url';
export * from './src/shared/net/ipAddress';
export * from './src/shared/net/sdp';
export * from './src/shared/net/connectionCode';
export * from './src/shared/net/messages';
export * from './src/shared/net/stateCodec';
export { StateSequencer } from './src/shared/net/StateSequencer';
export { ClockSync } from './src/shared/net/ClockSync';
export { LoopbackNetwork } from './src/net/LoopbackTransport';
`;
const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
});
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  [${ok ? 'OK' : 'NG'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- SDP の例
// 実際のブラウザの出力と同じ形 (値は例)。Chrome は ufrag 4 文字・pwd 24 文字、Firefox は 8 文字・32 文字の 16 進
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const fp = () => Array.from({ length: 32 }, () => Math.floor(rnd() * 256).toString(16).toUpperCase().padStart(2, '0')).join(':');
const uuid = () => {
  const h = Array.from({ length: 32 }, () => Math.floor(rnd() * 16).toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
};
const crlf = (lines) => lines.join('\r\n') + '\r\n';

function chromeSdp({ setup, candidates, ufrag = 'Xk9f', pwd = 'aB3dE5fG7hI9jK1lM3nO5pQ7', fingerprint = fp(), mid = '0' }) {
  return crlf([
    'v=0',
    'o=- 7614219274584779017 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `a=group:BUNDLE ${mid}`,
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 50027 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 203.0.113.45',
    ...candidates.map((c) => `a=candidate:${c}`),
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${setup}`,
    `a=mid:${mid}`,
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ]);
}

function firefoxSdp({ setup, candidates, ufrag = '8a1b2c3d', pwd = '3f7c1e9a2b4d6f8091a3c5e7b9d1f3a5', fingerprint = fp() }) {
  return crlf([
    'v=0',
    'o=mozilla...THIS_IS_SDPARTA-128.0 5186584356436577426 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    `a=fingerprint:sha-256 ${fingerprint}`,
    'a=group:BUNDLE 0',
    'a=ice-options:trickle',
    'a=msid-semantic:WMS *',
    'm=application 61234 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 198.51.100.7',
    ...candidates.map((c) => `a=candidate:${c}`),
    'a=sendrecv',
    'a=end-of-candidates',
    `a=ice-pwd:${pwd}`,
    `a=ice-ufrag:${ufrag}`,
    'a=mid:0',
    `a=setup:${setup}`,
    'a=sctp-port:5000',
    'a=max-message-size:1073741823',
  ]);
}

const chromeCandidates = (a = uuid(), b = uuid()) => [
  `3510590512 1 udp 2113937151 ${a}.local 50027 typ host generation 0 network-cost 999`,
  `2789457711 1 udp 2113939711 ${b}.local 50028 typ host generation 0 network-cost 999`,
  `4210984823 1 tcp 1518157311 ${a}.local 9 typ host tcptype active generation 0 network-cost 999`,
  '842163049 1 udp 1677729535 203.0.113.45 50027 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  '1947208462 1 udp 1677732095 2001:db8:85a3::8a2e:370:7334 50028 typ srflx raddr :: rport 0 generation 0 network-cost 999',
];
const firefoxCandidates = (a = uuid(), b = uuid()) => [
  `0 1 UDP 2122252543 ${a}.local 61234 typ host`,
  `2 1 UDP 2122187007 ${b}.local 61235 typ host`,
  `4 1 TCP 2105524479 ${a}.local 9 typ host tcptype active`,
  '1 1 UDP 1686052863 198.51.100.7 61234 typ srflx raddr 0.0.0.0 rport 0',
  '3 1 UDP 1685987327 2001:DB8:0:0:0:0:0:BEEF 61235 typ srflx raddr 0.0.0.0 rport 0',
];

/** 比べる値: 接続に必要な値と、ひな形の固定値 */
function essentialsOf(sdp) {
  const info = m.parseSdp(sdp);
  const cands = info.candidates
    .filter((c) => c.protocol === 'udp' && (c.type === 'host' || c.type === 'srflx'))
    .map((c) => `${c.type} ${m.normalizeAddress(c.address)} ${c.port}`)
    .sort();
  return {
    ufrag: info.ufrag, pwd: info.pwd,
    fingerprint: info.fingerprint ? Buffer.from(info.fingerprint).toString('hex') : null,
    setup: info.setup, mid: info.mid, sctpPort: info.sctpPort, candidates: cands.join(' | '),
  };
}

const lobbyId = 0xdeadbeef;
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function roundTrip(label, kind, sdp, expectCompact = true) {
  const code = await m.encodeConnectionCode({ kind, lobbyId, slot: 3, sdp });
  const r = await m.decodeConnectionCode(code, kind);
  if (!r.ok) {
    check(false, `${label}: 往復`, `デコード失敗 ${r.error}`);
    return null;
  }
  const rebuilt = r.code.sdp;
  const a = essentialsOf(sdp);
  const b = essentialsOf(rebuilt);
  check(sameJson(a, b), `${label}: エンコード → デコード → SDP 再構成で値が一致`, sameJson(a, b) ? '' : `\n    元 ${JSON.stringify(a)}\n    再 ${JSON.stringify(b)}`);
  check(r.code.isFullSdp === !expectCompact, `${label}: ${expectCompact ? '通常形式' : 'SDP 全文形式'}`);
  check(r.code.kind === kind && r.code.lobbyId === lobbyId && r.code.slot === 3 && r.code.protocolVersion === m.protocolVersion,
    `${label}: 種類・ロビー ID・枠・バージョン`);
  if (expectCompact) {
    const lines = rebuilt.split('\r\n');
    const need = [
      'v=0', 't=0 0', 'a=group:BUNDLE 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
      'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', `a=setup:${kind === 'invite' ? 'actpass' : 'active'}`,
    ];
    const missing = need.filter((l) => !lines.includes(l));
    const ordered = lines.indexOf('m=application 9 UDP/DTLS/SCTP webrtc-datachannel') > lines.indexOf('a=group:BUNDLE 0')
      && lines.findIndex((l) => l.startsWith('a=candidate:')) > lines.indexOf('c=IN IP4 0.0.0.0');
    check(missing.length === 0 && ordered && rebuilt.endsWith('\r\n') && /^o=- \d+ 2 IN IP4 127\.0\.0\.1$/m.test(rebuilt),
      `${label}: 再構成した SDP の固定行 (BUNDLE、m=、c=、setup、mid、sctp-port、max-message-size)`, missing.join(', '));
  }
  return { code, decoded: r.code };
}

console.log('== 招待・返答コードの往復 ==');
const lengths = [];
for (const [label, make, cands] of [
  ['Chrome', chromeSdp, chromeCandidates],
  ['Firefox', firefoxSdp, firefoxCandidates],
]) {
  const inv = await roundTrip(`${label} 招待`, 'invite', make({ setup: 'actpass', candidates: cands() }));
  const rep = await roundTrip(`${label} 返答`, 'reply', make({ setup: 'active', candidates: cands() }));
  for (const r of [inv, rep]) if (r) lengths.push([`${label} ${r.decoded.kind}`, r.code.length]);
}
{
  // 候補 2 個 (mDNS + IPv4 の srflx) の最小構成と、4 個 (mDNS × 2 + IPv4 + IPv6) の構成
  const two = chromeCandidates().filter((c, i) => i === 0 || i === 3);
  const r = await roundTrip('Chrome 招待 (候補 2 個)', 'invite', chromeSdp({ setup: 'actpass', candidates: two }));
  if (r) lengths.push(['Chrome 候補 2 個', r.code.length]);
}
console.log('\n== コードの長さ (目安 140〜230 文字、上限 300) ==');
for (const [label, n] of lengths) console.log(`  ${label}: ${n} 文字`);
check(lengths.every(([, n]) => n <= 230), '通常形式 (候補 2〜4 個) が目安の 230 文字以下', lengths.map(([, n]) => n).join(', '));
check(lengths.every(([, n]) => n <= 300), '上限 300 文字以内');

console.log('\n== フラグ・候補の選び方 ==');
{
  const noStun = chromeCandidates().slice(0, 3);
  const r = await roundTrip('STUN 応答なし', 'invite', chromeSdp({ setup: 'actpass', candidates: noStun }));
  check(r?.decoded.isStunUnreachable === true && r?.decoded.isSymmetricNatSuspected === false, 'srflx がなければ「STUN の応答なし」フラグ');

  const sym = [...chromeCandidates().slice(0, 2),
    '842163049 1 udp 1677729535 203.0.113.45 50027 typ srflx raddr 0.0.0.0 rport 0 generation 0',
    '842163050 1 udp 1677729535 203.0.113.45 61999 typ srflx raddr 0.0.0.0 rport 0 generation 0'];
  const s = await roundTrip('対称 NAT', 'invite', chromeSdp({ setup: 'actpass', candidates: sym }));
  check(s?.decoded.isSymmetricNatSuspected === true && s?.decoded.isStunUnreachable === false, '同じ外向き IP に違うポート 2 つで「対称 NAT の疑い」フラグ');

  const normal = await m.decodeConnectionCode(await m.encodeConnectionCode({ kind: 'invite', lobbyId, slot: 1, sdp: chromeSdp({ setup: 'actpass', candidates: chromeCandidates() }) }));
  check(normal.ok && !normal.code.isSymmetricNatSuspected && !normal.code.isStunUnreachable, '通常の回線ではフラグなし');

  const many = [
    ...Array.from({ length: 6 }, (_, i) => `${100 + i} 1 udp ${2113937151 - i} ${uuid()}.local ${50000 + i} typ host generation 0`),
    '200 1 udp 1677729535 203.0.113.45 50000 typ srflx raddr 0.0.0.0 rport 0',
    '201 1 udp 1677729534 2001:db8::1 50001 typ srflx raddr :: rport 0',
    '202 1 udp 41885439 192.0.2.10 3478 typ relay raddr 203.0.113.45 rport 50000',
  ];
  const code = await m.encodeConnectionCode({ kind: 'invite', lobbyId, slot: 2, sdp: chromeSdp({ setup: 'actpass', candidates: many }) });
  const d = await m.decodeConnectionCode(code);
  const types = d.ok ? d.code.candidates.map((c) => c.type) : [];
  check(d.ok && !d.code.isFullSdp && types.length === 6 && types.filter((t) => t === 'srflx').length === 2,
    '候補が多いときは 6 個まで (srflx は残し、relay・TCP は入れない)', `${types.join(',')} / ${code.length} 文字`);
}

console.log('\n== SDP 全文形式 (フォールバック) ==');
{
  const odd = chromeSdp({ setup: 'actpass', candidates: chromeCandidates(), mid: 'data' });
  const code = await m.encodeConnectionCode({ kind: 'invite', lobbyId, slot: 4, sdp: odd });
  const r = await m.decodeConnectionCode(code, 'invite');
  check(r.ok && r.code.isFullSdp && r.code.sdp === odd, 'mid が 0 でない SDP は全文形式になり、元の SDP がそのまま戻る', `${code.length} 文字`);
  const sha384 = chromeSdp({ setup: 'active', candidates: chromeCandidates() }).replace(/a=fingerprint:sha-256 [^\r]+/, `a=fingerprint:sha-384 ${fp()}:${fp().slice(0, 47)}`);
  const c2 = await m.encodeConnectionCode({ kind: 'reply', lobbyId, slot: 4, sdp: sha384 });
  const r2 = await m.decodeConnectionCode(c2, 'reply');
  check(r2.ok && r2.code.isFullSdp && r2.code.sdp === sha384, 'SHA-256 以外の指紋も全文形式', `${c2.length} 文字`);
  const forced = await m.encodeConnectionCode({ kind: 'invite', lobbyId, slot: 4, sdp: firefoxSdp({ setup: 'actpass', candidates: firefoxCandidates() }), forceFullSdp: true });
  const r3 = await m.decodeConnectionCode(forced);
  check(r3.ok && r3.code.isFullSdp && r3.code.candidates.length === 5, '全文形式でも相手の候補を読める (TCP 含む host/srflx)', `Firefox の SDP 全文 ${forced.length} 文字`);
}

console.log('\n== 壊れたコード・種類違い・バージョン違い ==');
{
  const sdp = chromeSdp({ setup: 'actpass', candidates: chromeCandidates() });
  const invite = await m.encodeConnectionCode({ kind: 'invite', lobbyId, slot: 5, sdp });
  const expect = async (text, kind, error, label) => {
    const r = await m.decodeConnectionCode(text, kind);
    const peek = m.checkConnectionCode(text, kind);
    const ok = error === null ? r.ok && peek.ok : !r.ok && r.error === error && !peek.ok && peek.error === error;
    check(ok, label, r.ok ? 'ok' : r.error);
  };
  const body = invite.slice(6);
  await expect(invite, 'invite', null, '正しいコード');
  await expect(`  招待コード:\n${invite.slice(0, 40)}\n ${invite.slice(40, 90)}​ ${invite.slice(90)}  `, 'invite', null, '改行・空白・ゼロ幅文字・前後の文が混ざっても読める');
  await expect(invite.slice(0, invite.length - 5), 'invite', 'malformed', '途中で切れた → 壊れている');
  const flipped = invite.slice(0, 30) + (invite[30] === 'A' ? 'B' : 'A') + invite.slice(31);
  await expect(flipped, 'invite', 'malformed', '1 文字違う → 壊れている (チェックサム)');
  await expect(`XYZ1I.${body}`, 'invite', 'malformed', 'PLO で始まらない → 壊れている');
  await expect(`PLO1I.${body.slice(0, 20)}!!${body.slice(22)}`, 'invite', 'malformed', 'Base64url でない文字 → 壊れている');
  await expect('', 'invite', 'malformed', '空 → 壊れている');
  await expect(invite, 'reply', 'wrongKind', 'ホストが招待コードを貼った → 種類違い');
  await expect(`PLO2I.${body}`, 'invite', 'version', 'コード形式のバージョン違い (PLO2)');
  // プロトコルのバージョンだけ違うコード (チェックサムは付け直す)
  const bytes = m.decodeBase64url(body);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, m.protocolVersion + 1);
  let crc = 0xffff;
  for (let i = 0; i < bytes.length - 2; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  view.setUint16(bytes.length - 2, crc);
  const other = `PLO1I.${m.encodeBase64url(bytes)}`;
  await expect(other, 'invite', 'version', 'プロトコルのバージョン違い');
  const r = await m.decodeConnectionCode(other, 'invite');
  check(!r.ok && r.theirVersion === m.protocolVersion + 1, '相手のバージョン番号を返す', `相手 ${r.theirVersion} / 自分 ${m.protocolVersion}`);
  const h = m.checkConnectionCode(invite);
  check(h.ok && h.header.lobbyId === lobbyId && h.header.slot === 5, '同期の確認でロビー ID と枠が分かる (返答コードの振り分け)');
}
{
  // 種類の文字だけを書き換えたコード: チェックサムは中身だけなので通り、種類違いとして扱う
  const invite = await m.encodeConnectionCode({ kind: 'invite', lobbyId, slot: 5, sdp: chromeSdp({ setup: 'actpass', candidates: chromeCandidates() }) });
  const r = await m.decodeConnectionCode(`PLO1R.${invite.slice(6)}`, 'invite');
  check(!r.ok && r.error === 'wrongKind' && r.kind === 'reply', '参加者が返答コードを貼った → 種類違い (kind = reply)');
}

console.log('\n== アドレスの変換 ==');
{
  const cases = [
    ['2001:db8:85a3::8a2e:370:7334', '2001:db8:85a3::8a2e:370:7334'],
    ['2001:DB8:0:0:0:0:0:BEEF', '2001:db8::beef'],
    ['::1', '::1'],
    ['fe80::1:0:0:1', 'fe80::1:0:0:1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['::ffff:192.0.2.1', '::ffff:c000:201'],
    ['203.0.113.45', '203.0.113.45'],
  ];
  const bad = cases.filter(([a, b]) => m.normalizeAddress(a) !== b);
  check(bad.length === 0, 'IPv4・IPv6 の読み書き (RFC 5952 の表記)', bad.map(([a]) => `${a} → ${m.normalizeAddress(a)}`).join(', '));
  const name = '6b0d2f1e-9c3a-4e57-8a1b-2f3c4d5e6f70.local';
  check(m.normalizeAddress(name.toUpperCase().replace('.LOCAL', '.local')) === name, 'mDNS 名の読み書き');
  check(m.isPrivateAddress('192.168.1.5') && m.isPrivateAddress(name) && m.isPrivateAddress('fd00::1') && !m.isPrivateAddress('100.64.1.1') && !m.isPrivateAddress('2001:db8::1'),
    'LAN のアドレスの判定 (CGNAT の 100.64/10 は含めない)');
  check(m.classifyRoute('host', 'host', name) === 'lan' && m.classifyRoute('host', 'prflx', '192.168.1.9') === 'lan'
    && m.classifyRoute('srflx', 'host', name) === 'internet' && m.classifyRoute('host', 'host', '2001:db8::1') === 'internet'
    && m.classifyRoute('host', 'srflx', '203.0.113.1') === 'internet', '接続経路の判定 (host 同士 = LAN)');
  check(m.hasSharedPublicAddress([{ type: 'srflx', address: '203.0.113.45' }], [{ type: 'srflx', address: '203.0.113.45' }, { type: 'host', address: name }])
    && !m.hasSharedPublicAddress([{ type: 'srflx', address: '203.0.113.45' }], [{ type: 'srflx', address: '198.51.100.7' }]), '同じルーターの内側かの判定');
}

// ---------------------------------------------------------------- バイナリ形式
console.log('\n== state のバイナリ形式 ==');
const makeCar = (id) => ({
  id, x: 1234.5 + id * 100, y: -987.25 - id, heading: 1.25 + id * 0.1, sF: 812.5, sR: -3.5, steer: -0.5, lap: 2, checkpoint: 17,
  isDrsOpen: id % 2 === 0, isBraking: id % 3 === 0, isReversing: false, isGhost: id === 7, isInPit: id === 5, isSpinning: id === 1,
});
const closeCar = (a, b) => a.id === b.id && Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.heading - b.heading) < 1e-6
  && Math.abs(a.sF - b.sF) < 1e-3 && Math.abs(a.sR - b.sR) < 1e-3 && Math.abs(a.steer - b.steer) <= 1 / 127 && a.lap === b.lap
  && a.checkpoint === b.checkpoint && ['isDrsOpen', 'isBraking', 'isReversing', 'isGhost', 'isInPit', 'isSpinning'].every((k) => a[k] === b[k]);
{
  const car = makeCar(3);
  const buf = m.encodeCarState(1_726_000_000_123.25, car);
  const out = m.createCarStateMessage();
  check(m.decodeCarState(buf, out) && out.time === 1_726_000_000_123.25 && closeCar(car, out.car), 'carState の往復', `${buf.byteLength} バイト`);

  const cars = Array.from({ length: 8 }, (_, i) => makeCar(i));
  const snap = m.encodeSnapshot(1_726_000_000_456.5, cars);
  const so = m.createSnapshotMessage();
  const okSnap = m.decodeSnapshot(snap, so) && so.count === 8 && so.hostTime === 1_726_000_000_456.5 && cars.every((c, i) => closeCar(c, so.cars[i]));
  check(okSnap, '8 台のスナップショットの往復');
  check(snap.byteLength <= m.stateMaxBytes, '8 台のスナップショットが 1,000 バイト以下', `${snap.byteLength} バイト`);

  const ping = m.encodePing(42, 1000.5);
  const po = { seq: 0, sentAt: 0 };
  const pong = m.encodePong(42, 1000.5, 99999.75);
  const qo = { seq: 0, sentAt: 0, repliedAt: 0 };
  check(m.decodePing(ping, po) && po.seq === 42 && po.sentAt === 1000.5 && m.decodePong(pong, qo) && qo.seq === 42 && qo.repliedAt === 99999.75,
    'ping / pong の往復', `${ping.byteLength} / ${pong.byteLength} バイト`);

  const broken = snap.slice(0, snap.byteLength - 1);
  const nan = m.encodeCarState(0, { ...car, x: NaN });
  const badId = m.encodeCarState(0, car);
  new DataView(badId).setUint8(13, 9);
  check(!m.decodeSnapshot(broken, so) && !m.decodeCarState(nan, out) && !m.decodeCarState(badId, out) && !m.decodeCarState(ping, out)
    && m.readStateType(new ArrayBuffer(1001)) === null && m.readStateType(new Uint8Array([9, 0, 0, 0, 0]).buffer) === null,
  '壊れたもの (長さ違い・NaN・ID の範囲外・種類違い・1,000 バイト超え) を拒否');

  check(m.isNewerSeq(5, 4) && !m.isNewerSeq(4, 5) && !m.isNewerSeq(4, 4) && m.isNewerSeq(1, 0xffffffff) && !m.isNewerSeq(0xffffffff, 1), '連番の新旧 (u32 の一周を含む)');
  const sender = new m.StateSequencer();
  const receiver = new m.StateSequencer();
  const msgs = Array.from({ length: 4 }, () => { const b = m.encodeCarState(0, car); sender.stamp(b); return b; });
  const accepted = [msgs[0], msgs[2], msgs[1], msgs[2], msgs[3]].map((b) => receiver.accept(b));
  check(sameJson(accepted, [true, true, false, false, true]), '受信側は古い連番・同じ連番を捨てる', accepted.join(','));
}

console.log('\n== メッセージの形の確認 ==');
{
  const settings = { course: 'course1', courseVersion: 3, laps: 5 };
  const player = { id: 0, name: 'KASE', team: 1, isReady: true, tyre: 'soft', route: null, rttMs: null };
  const good = [
    { type: 'welcome', playerId: 2, players: [player, { ...player, id: 2, name: 'P2X', team: 4, route: 'lan', rttMs: 12.5 }], settings },
    { type: 'reject', reason: 'full' },
    { type: 'raceStart', session: 'race', startTime: 1.7e12, settings, grid: [0, 2], seed: 99 },
    { type: 'raceEvent', event: 'lap', playerId: 2, time: 1.7e12, lap: 3, value: 37.25 },
    { type: 'result', session: 'race', entries: [{ playerId: 2, position: 1, status: 'finished', totalTime: 190.5, bestLap: 37.1 }] },
    { type: 'collision', other: 2, impulseX: 10, impulseY: -5, time: 1.7e12 },
    { type: 'hostClosed' },
  ];
  check(good.every((g) => m.parseHostMessage(JSON.stringify(g)) !== null), 'ホスト → 参加者の正しいメッセージを通す');
  const bad = [
    'not json', '[]', '{"type":"welcome"}', JSON.stringify({ ...good[0], playerId: 9 }),
    JSON.stringify({ type: 'lobby', players: [{ ...player, name: 'lower' }], settings }),
    JSON.stringify({ type: 'raceEvent', event: 'boom', playerId: 1, time: 0 }), JSON.stringify({ type: 'unknown' }),
  ];
  check(bad.every((b) => m.parseHostMessage(b) === null), '壊れた・知らないメッセージを捨てる');
  check(m.parseClientMessage(JSON.stringify({ type: 'join', protocolVersion: m.protocolVersion, name: 'KASE', team: 3 })) !== null
    && m.parseClientMessage(JSON.stringify({ type: 'ready', isReady: true, tyre: 'hard' })) !== null
    && m.parseClientMessage(JSON.stringify({ type: 'join', name: 'KASE', team: 3 })) === null
    && m.parseClientMessage(JSON.stringify({ type: 'lobby', players: [], settings })) === null, '参加者 → ホストのメッセージの確認 (ホスト向けの種類は不正)');
  check(m.isValidPlayerName('AB1') && !m.isValidPlayerName('AB') && !m.isValidPlayerName('abc') && !m.isValidPlayerName('ABCDEFGHI'), '名前の規則 (英大文字と数字 3〜8 文字)');
}

console.log('\n== 時刻合わせ (ClockSync) ==');
{
  const sync = new m.ClockSync();
  // 真のずれ +500 ms、往復 40〜200 ms で片道の偏りがばらつく
  const trueOffset = 500;
  let worst = 0;
  for (let i = 0; i < 30; i++) {
    const t0 = i * 1000;
    const up = 20 + ((i * 37) % 80);
    const down = 20 + ((i * 53) % 80);
    sync.addSample(t0, t0 + up + trueOffset, t0 + up + down);
    if (i >= 9) worst = Math.max(worst, Math.abs(sync.offset - trueOffset));
  }
  check(worst < 30, '往復の短い 3 回の平均で、ずれの誤差が小さい', `10 回目以降の最大誤差 ${worst.toFixed(1)} ms`);
}

// ---------------------------------------------------------------- LoopbackTransport
class VirtualClock {
  t = 1_726_000_000_000;
  queue = [];
  order = 0;
  now() { return this.t; }
  setTimeout(fn, ms) { const h = { at: this.t + Math.max(0, ms), fn, order: this.order++, isCancelled: false }; this.queue.push(h); return h; }
  clearTimeout(h) { if (h) h.isCancelled = true; }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      let best = null;
      for (const h of this.queue) if (!h.isCancelled && h.at <= end && (!best || h.at < best.at || (h.at === best.at && h.order < best.order))) best = h;
      if (!best) break;
      this.queue.splice(this.queue.indexOf(best), 1);
      this.t = best.at;
      best.fn();
    }
    this.t = end;
    this.queue = this.queue.filter((h) => !h.isCancelled);
  }
}

console.log('\n== LoopbackTransport: ping / pong と時刻合わせ ==');
{
  const clock = new VirtualClock();
  const net = new m.LoopbackNetwork({ clock, latencyMs: 30, jitterMs: 20, lossRate: 0.1, seed: 7 });
  const joined = [];
  const left = [];
  const hostEvents = [];
  const hostStates = [];
  net.host.onPeerJoin = (id) => joined.push(id);
  net.host.onPeerLeave = (id, reason) => left.push(`${id}:${reason}`);
  net.host.onEvent = (id, msg) => hostEvents.push([id, msg.type]);
  net.host.onState = (id, data) => hostStates.push([id, m.readStateSeq(data)]);

  const offsets = [5000, -12345.6, 0];
  const clients = offsets.map((clockOffsetMs, i) => net.connect({ clockOffsetMs, latencyMs: 10 + i * 30, jitterMs: 20 }));
  const closes = clients.map(() => []);
  clients.forEach((c, i) => { c.onClose = (r) => closes[i].push(r); });
  const received = clients.map(() => []);
  clients.forEach((c, i) => { c.onEvent = (msg) => received[i].push(msg); });

  clock.advance(100);
  check(sameJson(joined, [1, 2, 3]), '3 人がつながり、枠 1〜3 が割り当てられる', joined.join(','));

  // 収束の速さ: 最初の短い間隔の ping (0.1 秒 × 10 回) のあと
  clock.advance(1500);
  const errAt = (c) => Math.abs(c.hostNow() - net.host.now());
  const early = clients.map(errAt);
  clock.advance(15000);
  const late = clients.map(errAt);
  const bounds = clients.map((_, i) => 10 + 20 / 2 + 1); // 片道の揺らぎ (20 ms) の半分 + 余裕
  check(clients.every((c) => c.isClockSynced), '全員の時刻合わせが済む');
  check(early.every((e, i) => e < bounds[i]), '1.6 秒後にホスト時刻との誤差が小さい', early.map((e) => `${e.toFixed(1)} ms`).join(', '));
  check(late.every((e, i) => e < bounds[i]), '16.6 秒後 (ロス 10%) も誤差が小さい', late.map((e) => `${e.toFixed(1)} ms`).join(', '));
  const rtts = clients.map((c) => c.stats.rttMs);
  const expected = [20, 80, 140];
  check(rtts.every((r, i) => r !== null && r >= expected[i] && r <= expected[i] + 40), '参加者から見た往復遅延', rtts.map((r) => `${r?.toFixed(1)} ms`).join(', '));
  const hostRtts = [1, 2, 3].map((id) => net.host.peerStats(id)?.rttMs);
  check(hostRtts.every((r, i) => r !== null && r !== undefined && r >= expected[i] && r <= expected[i] + 40), 'ホストから見た往復遅延', hostRtts.map((r) => `${r?.toFixed(1)} ms`).join(', '));

  // event は揺らぎがあっても順番どおり、全部届く
  for (let i = 0; i < 50; i++) net.host.broadcastEvent({ type: 'raceEvent', event: 'lap', playerId: 0, time: net.host.now(), lap: i });
  clients[1].sendEvent({ type: 'ready', isReady: true, tyre: 'soft' });
  clock.advance(500);
  const laps = received.map((list) => list.filter((e) => e.type === 'raceEvent').map((e) => e.lap));
  check(laps.every((l) => l.length === 50 && l.every((v, i) => v === i)), 'event は順番どおりに全部届く');
  check(hostEvents.some(([id, t]) => id === 2 && t === 'ready'), '参加者の event がホストに届く (送り主の ID 付き)');

  // state はロスがあり、届いたものは連番が増える順だけ渡る
  hostStates.length = 0;
  const car = makeCar(1);
  for (let i = 0; i < 300; i++) {
    clients[0].sendState(m.encodeCarState(clients[0].hostNow(), car));
    clock.advance(1000 / 30);
  }
  clock.advance(200);
  const seqs = hostStates.filter(([id]) => id === 1).map(([, s]) => s);
  const increasing = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  check(seqs.length > 240 && seqs.length < 300 && increasing, 'state はロス (10%) と揺らぎがあっても、古いものを捨てて新しい順に渡る', `300 回中 ${seqs.length} 回`);

  // snapshot を全員に
  const snaps = clients.map(() => 0);
  clients.forEach((c, i) => { c.onState = () => snaps[i]++; });
  for (let i = 0; i < 30; i++) {
    net.host.broadcastState(m.encodeSnapshot(net.host.now(), [makeCar(0), makeCar(1), makeCar(2), makeCar(3)]));
    clock.advance(1000 / 30);
  }
  clock.advance(200);
  check(snaps.every((n) => n >= 20 && n <= 30), 'スナップショットが全員に届く (ロスあり)', snaps.join(', '));

  // 不正なメッセージを送った参加者は切断
  clients[2].sendEvent({ type: 'welcome', playerId: 0, players: [], settings: { course: 'x', courseVersion: 1, laps: 1 } });
  clock.advance(300);
  check(left.includes('3:kicked') && closes[2].includes('connectionFailed'), '不正な event (ホスト向けの種類) を送った参加者を切断', left.join(','));

  // 参加者が自分で抜ける
  clients[1].close();
  clock.advance(300);
  check(left.includes('2:left') && closes[1].length === 0, '参加者が抜けるとホストに onPeerLeave(left)');

  // ホストの終了
  net.host.close();
  clock.advance(300);
  check(closes[0].includes('hostClosed'), 'ホストが閉じると参加者に onClose(hostClosed)', closes[0].join(','));
}

console.log('\n== LoopbackTransport: 応答がないときの切断 ==');
{
  const clock = new VirtualClock();
  const net = new m.LoopbackNetwork({ clock, latencyMs: 20, seed: 3 });
  const left = [];
  net.host.onPeerLeave = (id, reason) => left.push(`${id}:${reason}`);
  const alive = net.connect();
  const dead = net.connect({ lossRate: 1 }); // state が全部失われる (event は届く)
  const closes = [];
  dead.onClose = (r) => closes.push(r);
  alive.onClose = (r) => closes.push(`alive:${r}`);
  clock.advance(9000);
  check(left.length === 0, '9 秒ではまだ切らない');
  clock.advance(3000);
  check(left.includes('2:timeout') && !left.some((l) => l.startsWith('1:')), '10 秒 pong が返らない参加者を切断 (onPeerLeave(timeout))', left.join(','));
  check(closes.length === 1 && (closes[0] === 'timeout' || closes[0] === 'connectionFailed'), '切られた参加者にも onClose が届く', closes.join(','));
  check(alive.isClockSynced && Math.abs(alive.hostNow() - net.host.now()) < 1, 'ほかの参加者は影響を受けない');
}

console.log(failures === 0 ? '\nすべての確認が OK' : `\nNG が ${failures} 件`);
process.exitCode = failures === 0 ? 0 : 1;
