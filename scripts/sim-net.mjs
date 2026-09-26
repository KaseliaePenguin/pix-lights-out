// ヘッドレスの確認: オンライン対戦の通信部品 (src/shared/net/、src/net/LoopbackTransport.ts) を node で動かして確かめる。
//   node scripts/sim-net.mjs
// 招待・返答コードの往復 (Chrome・Firefox 形式の SDP)、コードの長さ、壊れたコードの判定、バイナリ形式、
// LoopbackTransport での ping / pong と時刻合わせ、RaceHost + NetClientSession でのオンラインの決勝
// (CPU の運転で全員が完走、接触の中継、状態が届かない車のゴースト・リタイア、切断、ホストの終了、不正対策)、
// 中継 (シグナリング) の招待リンク (#room=)・暗号化と認証・部屋の処理 (signaling/ の RoomCore)・Origin の確認。
// WebRTC そのものと Worker はブラウザでしか確かめられない。中継の Worker そのものは signaling/scripts/check-local.mjs (wrangler dev) で確かめる。
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
export { RaceHost } from './src/host/RaceHost';
export { NetClientSession } from './src/net/NetClientSession';
export { RateLimiter } from './src/shared/net/RateLimiter';
export { Track } from './src/shared/Track';
export { course1 } from './src/shared/tracks/course1';
export { RacingLine } from './src/shared/RacingLine';
export { CpuDriver, createCpuSurroundings } from './src/shared/CpuDriver';
export { carParams, raceRules } from './src/shared/carParams';
export { createControls } from './src/shared/controls';
export { Random } from './src/shared/Random';
export { HostRaceJudge } from './src/shared/net/HostRaceJudge';
export { netRaceRules } from './src/shared/net/netRaceRules';
export { PingSession } from './src/shared/net/PingSession';
export { recordTimingByDistance } from './src/shared/raceStandings';
export { SurfaceCode } from './src/shared/Track';
export * from './src/shared/net/relayProtocol';
export * from './src/shared/net/relayCrypto';
export * from './src/shared/net/roomLink';
export { RoomCore } from './signaling/src/RoomCore';
export { isAllowedOrigin } from './signaling/src/origin';
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

console.log('\n== 招待リンク ==');
{
  const invite = await m.encodeConnectionCode({ kind: 'invite', lobbyId, slot: 2, sdp: chromeSdp({ setup: 'actpass', candidates: chromeCandidates() }) });
  const link = m.inviteLinkOf('https://example.com/pix/', invite);
  check(link === `https://example.com/pix/#join=${invite}`, '招待リンクの形 (<ページの URL>#join=PLO1I.…)', `${link.length} 文字`);
  check(m.inviteLinkOf('https://example.com/pix/#join=PLO1I.old', invite) === link, '元の URL のフラグメントは付け替える');
  check(m.inviteCodeFromHash(`#join=${invite}`) === invite, 'location.hash から招待コードを取り出す');
  check(m.inviteCodeFromHash('') === null && m.inviteCodeFromHash('#top') === null && m.inviteCodeFromHash('#join=') === null
    && m.inviteCodeFromHash(`#x=${invite}`) === null, '招待リンクでないフラグメントは null');
  check(m.extractConnectionCode(link) === invite && m.extractConnectionCode(invite) === invite, '貼り付け: リンクでもコードだけでも取り出せる');
  check(m.extractConnectionCode(`招待だよ ${link.slice(0, 50)}\n${link.slice(50)} よろしく`) === invite, '貼り付け: 改行・前後の文が混ざったリンク');
  check(m.extractConnectionCode(`join me: ${link} thanks!`) === invite && m.extractConnectionCode(`${invite}\nsee you`) === invite,
    '貼り付け: 後ろに英単語が続いても、空白で区切ってチェックサムが合うほうを取る');
  check(m.checkConnectionCode(`join me: ${link} thanks`, 'invite').ok, '後ろに英単語が続くリンクも招待コードとして読める');
  check(m.extractConnectionCode(`https://example.com/PLO9X.abc/#join=${invite}`) === invite, 'ページの URL にコードに似た文字があっても #join= 以降を読む');
  check(m.extractConnectionCode('https://example.com/pix/') === null && m.extractConnectionCode('') === null, 'コードがなければ null');
  const d = await m.decodeConnectionCode(link, 'invite');
  check(d.ok && d.code.slot === 2 && m.checkConnectionCode(link, 'invite').ok, 'リンクをそのまま読んでも招待コードとして読める');
  const asReply = m.checkConnectionCode(link, 'reply');
  check(!asReply.ok && asReply.error === 'wrongKind', 'ホストが招待リンクを貼った → 種類違い');
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
    { type: 'result', session: 'race', entries: [{ playerId: 2, position: 1, status: 'finished', totalTime: 190.5, bestLap: 37.1, lapsCompleted: 5, penalty: 0 }] },
    { type: 'collision', other: 2, impulseX: 10, impulseY: -5, time: 1.7e12, spin: -1 },
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

console.log('\n== RateLimiter ==');
{
  const r = new m.RateLimiter(60);
  let dropped = 0;
  for (let t = 0; t < 12000; t += 5) if (!r.allow(t)) dropped++; // 200 回/秒
  check(dropped > 0 && r.isOverFor(12000, 10000), '上限を超える状態が 10 秒続くと isOverFor');
  const q = new m.RateLimiter(60);
  for (let t = 0; t < 12000; t += 5) if (Math.floor(t / 1000) % 2 === 0) q.allow(t); // 超える秒と何も来ない秒が交互
  check(!q.isOverFor(12000, 10000), '途切れたら数え直す');
}

// ---------------------------------------------------------------- オンラインの決勝 (RaceHost + NetClientSession)
const track = new m.Track(m.course1);
const racingLine = new m.RacingLine(track, { tyreGrip: m.carParams.compoundGrip.soft, params: m.carParams });
const dtStep = m.raceRules.step;

/** ホスト (RaceHost を LoopbackNetwork の host に直接つなぐ) と参加者 (CPU が自車を運転する) */
/** 改造したクライアントの代わり: 物理を通さずに車を前へ 3 px ずらす (1 フレームぶん) */
function creep(car) {
  car.pushBy(Math.sin(car.heading) * 3, -Math.cos(car.heading) * 3);
}

function createRaceWorld({ seed, profiles, laps = 3, latencyMs = 30, jitterMs = 50, lossRate = 0.05 }) {
  const clock = new VirtualClock();
  const net = new m.LoopbackNetwork({ clock, latencyMs, jitterMs, lossRate, seed });
  const relayed = [];
  const sendEvent = net.host.sendEvent.bind(net.host);
  net.host.sendEvent = (id, msg) => {
    if (msg.type === 'collision') relayed.push({ to: id, from: msg.other });
    sendEvent(id, msg);
  };
  const host = new m.RaceHost({ transport: net.host, clock, track, laps, createSeed: () => seed * 7919 });
  const warnings = [];
  host.onWarning = (id, detail) => warnings.push(`${id}:${detail}`);
  const players = profiles.map((p, i) => {
    const transport = net.connect(p.link ?? {});
    const session = new m.NetClientSession(transport, { name: p.name, team: p.team }, track);
    const driver = new m.CpuDriver(racingLine, track, p.difficulty ?? 'normal', new m.Random(seed * 31 + i), m.carParams.compoundGrip.soft);
    const player = { ...p, transport, session, driver, controls: m.createControls(), env: m.createCpuSurroundings(8), events: [], paused: false, lightsOutHostTime: null };
    session.onRaceStart = () => { player.events.length = 0; };
    return player;
  });
  return { clock, net, host, players, relayed, warnings };
}

/** 1/60 秒進めて、全員の自車を CPU で運転する */
function driveStep(w, beforeStep) {
  w.clock.advance(1000 / 60);
  for (const p of w.players) {
    const race = p.session.race;
    // 接続が切れたあとも step を呼ぶ (connectionLost は step で返る)
    if (!race || p.paused) continue;
    const self = race.player;
    const env = p.env;
    let n = 0;
    for (const rc of race.cars) if (rc !== self && race.isOnTrack(rc) && !race.isGhostPair(self.index, rc.index)) env.others[n++] = rc.car;
    env.othersCount = n;
    env.canDrive = race.phase === 'racing' && self.status !== 'retired';
    env.timeSinceStart = race.time - race.lightsOutAt;
    env.wantsReset = self.lap.isWrongWay || self.lap.isCheckpointMissed;
    p.driver.update(self.car, env, dtStep, p.controls);
    beforeStep?.(p, race);
    for (const e of race.step(p.controls, dtStep)) {
      if (e.type === 'lap' && e.event.type === 'timingLine') continue;
      p.events.push({ ...e, raceTime: race.raceTime });
      if (e.type === 'resetPlaced') p.driver.resetTracking();
      if (e.type === 'lightsOut') p.lightsOutHostTime = race.hostNow();
    }
  }
}

const hasEvent = (p, pred) => p.events.some(pred);
const fmtTime = (t) => (t == null ? '-' : `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`);

console.log('\n== オンラインの決勝: ロビー ==');
const worldA = createRaceWorld({
  seed: 11,
  profiles: [
    // ホスト本人 (LocalTransport 相当: 遅延なし)
    { name: 'HOST', team: 1, link: { latencyMs: 0, jitterMs: 0, lossRate: 0 } },
    { name: 'AAA', team: 2 },
    { name: 'BBB', team: 5 },
    { name: 'CCC', team: 8 },
  ],
});
{
  const w = worldA;
  w.clock.advance(2000);
  const ids = w.players.map((p) => p.session.playerId);
  check(w.players.every((p) => p.session.state === 'lobby' && p.session.players.length === 4) && new Set(ids).size === 4,
    '4 人が join してロビーに入り、全員に参加者一覧が届く', ids.join(','));
  check(w.players.every((p) => p.session.transport.isClockSynced), '全員の時刻合わせが済んでいる');

  // 名前・チームの重複、バージョン違い
  const extra = w.net.connect();
  const got = [];
  let extraClosed = null;
  extra.onEvent = (msg) => got.push(msg.type === 'reject' ? `reject:${msg.reason}` : msg.type);
  extra.onClose = (r) => { extraClosed = r; };
  extra.sendEvent({ type: 'join', protocolVersion: m.protocolVersion, name: 'AAA', team: 3 });
  extra.sendEvent({ type: 'join', protocolVersion: m.protocolVersion, name: 'DDD', team: 2 });
  extra.sendEvent({ type: 'join', protocolVersion: m.protocolVersion, name: 'dd', team: 3 });
  w.clock.advance(500);
  check(got.join(',') === 'reject:nameTaken,reject:teamTaken,reject:invalidName', '名前の重複・チームの重複・名前の規則違反を拒否 (接続は切らない)', got.join(','));
  extra.sendEvent({ type: 'join', protocolVersion: m.protocolVersion + 1, name: 'DDD', team: 3 });
  w.clock.advance(2000);
  check(got.includes('reject:version') && extraClosed !== null, 'バージョン違いは拒否して切断', `${got.at(-1)} / ${extraClosed}`);
  check(w.players.every((p) => p.session.players.length === 4), '拒否した相手は参加者一覧に入らない');

  check(w.host.startRace() === 'notReady', '全員が準備完了でなければ始められない');
  w.host.setLaps(3);
  for (const p of w.players) p.session.setReady(true, 'soft');
  w.clock.advance(300);
  check(w.players.every((p) => p.session.players.every((q) => q.isReady)), '準備完了が全員の一覧に反映される');
}

console.log('\n== オンラインの決勝: 3 周 (遅延 30〜80 ms、ロス 5%、4 台) ==');
{
  const w = worldA;
  const [hostP, aaa, bbb, ccc] = w.players;
  check(w.host.startRace() === 'ok', 'ホストがレースを始める');
  w.clock.advance(300);
  check(w.players.every((p) => p.session.state === 'race' && p.session.race), '全員に raceStart が届く');
  const grids = w.players.map((p) => p.session.race.entries.map((e) => e.playerId).join(''));
  check(new Set(grids).size === 1, '全員のグリッドが同じ', grids[0]);

  let deviation = null;
  let gaps = null;
  let teleportSent = false;
  let steps = 0;
  const maxSteps = 60 * 400;
  while (steps++ < maxSteps) {
    driveStep(w, (p, race) => {
      // BBB: 改造したクライアントのつもりで、消灯の 0.3 秒前から車を前へずらす (正規の操作では消灯まで動けない)
      if (p === bbb && race.phase === 'grid' && race.time > race.lightsOutAt - 0.3) creep(race.player.car);
    });
    const race = hostP.session.race;
    const t = race.raceTime;
    // CCC: 20〜25 秒の間、タブを裏に回したつもりで止める (状態が届かない → 3 秒でゴースト)
    ccc.paused = t >= 20 && t < 25;
    // AAA: 60 秒で切断
    if (t >= 60 && !aaa.left) {
      aaa.left = true;
      aaa.paused = true;
      aaa.session.leave();
    }
    // CCC から瞬間移動の状態を 1 回送る (ホストは捨てて警告)
    if (t >= 40 && !teleportSent) {
      teleportSent = true;
      const fake = m.createCarNetState(ccc.session.playerId);
      const real = ccc.session.race.player.car;
      Object.assign(fake, { x: real.x + 3000, y: real.y, heading: real.heading, sF: 400, lap: 1, checkpoint: 0 });
      ccc.transport.sendState(m.encodeCarState(ccc.session.race.hostNow(), fake));
    }
    // 50 秒の時点で、ホストの画面の順位表の差 (前の車との差が秒で出ている)
    if (gaps === null && t >= 50) {
      gaps = race.order.slice(1).filter((rc) => rc.status === 'racing').map((rc) => rc.gapToAhead);
    }
    // 30 秒の時点で、ホストの画面の BBB の表示位置と BBB 本人の位置のずれ
    if (deviation === null && t >= 30) {
      const shown = race.carByPlayerId(bbb.session.playerId).car;
      const real = bbb.session.race.player.car;
      deviation = Math.hypot(shown.x - real.x, shown.y - real.y);
    }
    const running = w.players.filter((p) => !p.left);
    if (running.every((p) => p.session.race.phase === 'finished')) break;
  }
  const remaining = [hostP, bbb, ccc];
  const results = remaining.map((p) => JSON.stringify(p.session.race.resultEntries));
  console.log(`  ${(steps / 60).toFixed(1)} 秒で終了`);
  for (const r of hostP.session.race.results) {
    console.log(`    ${r.position}. ${hostP.session.race.nameOf(r.carNumber).padEnd(4)} #${r.carNumber} ${r.status.padEnd(12)} 周 ${r.lapsCompleted} 合計 ${fmtTime(r.totalTime)} ベスト ${fmtTime(r.bestLap)} ペナルティ ${r.penalty}`);
  }
  check(remaining.every((p) => p.session.race.phase === 'finished'), '残った全員に結果が届く (レースが最後まで進む)');
  check(new Set(results).size === 1 && results[0] === JSON.stringify(w.host.judge.results), '全員の結果がホストの確定結果と一致');
  const entries = hostP.session.race.resultEntries ?? [];
  const byId = (id) => entries.find((e) => e.playerId === id);
  check([hostP, bbb, ccc].every((p) => byId(p.session.playerId)?.status === 'finished' && byId(p.session.playerId)?.lapsCompleted === 3), '走り続けた 3 人は 3 周を完走');
  check(byId(aaa.session.playerId)?.status === 'retired', '途中で切断した AAA はリタイア');
  const winner = entries.find((e) => e.position === 1);
  check(winner && winner.totalTime > 100 && winner.totalTime < 140, '優勝タイムが 3 周の目安 (100〜140 秒)', fmtTime(winner?.totalTime));
  check(byId(bbb.session.playerId)?.penalty === 3 && remaining.every((p) => hasEvent(p, (e) => e.type === 'jumpStart' && e.carNumber === 5)),
    'BBB のフライング: 結果に +3 秒、全員に jumpStart');
  const lightsOut = w.players.map((p) => p.lightsOutHostTime);
  const spread = Math.max(...lightsOut) - Math.min(...lightsOut);
  check(spread < 40, '全員の消灯がホスト時刻でそろう', `ずれ ${spread.toFixed(1)} ms`);
  check(remaining.filter((p) => p !== ccc).every((p) => hasEvent(p, (e) => e.type === 'carGhosted' && e.carNumber === 8) && hasEvent(p, (e) => e.type === 'carUnghosted' && e.carNumber === 8)),
    '状態が 3 秒届かない CCC はゴーストになり、戻ると通常に戻る');
  check([hostP, bbb, ccc].every((p) => hasEvent(p, (e) => e.type === 'carDisconnected' && e.carNumber === 2) && hasEvent(p, (e) => e.type === 'retired' && e.carNumber === 2)),
    '切断した AAA を全員がリタイアとして受け取り、レースは続く');
  check(w.warnings.length >= 1 && w.warnings.every((x) => x.startsWith(`${ccc.session.playerId}:`)), 'ありえない移動の状態は捨てて警告', w.warnings[0] ?? '');
  check(deviation !== null && deviation < 150, '他車の表示位置のずれ (補間の遅れ + 遅延ぶん)', `${deviation?.toFixed(1)} px`);
  check(gaps !== null && gaps.length > 0 && gaps.every((g) => (g.kind === 'time' && g.seconds >= 0 && g.seconds < 20) || g.kind === 'laps'),
    '順位表の前の車との差が出る (タイミングラインの通過時刻から)', (gaps ?? []).map((g) => (g.kind === 'time' ? `+${g.seconds.toFixed(3)}` : g.kind)).join(' '));

  const detected = w.players.reduce((s, p) => s + p.session.race.stats.contactsDetected, 0);
  const applied = w.players.reduce((s, p) => s + p.session.race.stats.collisionsApplied, 0);
  const duplicate = w.players.reduce((s, p) => s + p.session.race.stats.collisionsDuplicate, 0);
  const tooOld = w.players.reduce((s, p) => s + p.session.race.stats.collisionsTooOld, 0);
  console.log(`  接触: 自分で検出 ${detected} / 中継 ${w.relayed.length} / 相手で適用 ${applied}・自分でも検出済み ${duplicate}・古すぎ ${tooOld}`);
  check(detected > 0 && w.relayed.length > 0, '接触が起き、collision がホスト経由で相手に中継される');
  check(applied + duplicate > 0 && applied + duplicate + tooOld <= w.relayed.length, '中継された接触が相手の車に反映される (適用、または相手も検出済みで二重適用なし)');
  const sent = w.players.map((p) => p.session.race.stats.statesSent / Math.max(1, p.session.race.time));
  check(sent.every((r) => r > 20 && r <= 31), 'carState を約 30 回/秒で送る', sent.map((r) => r.toFixed(1)).join(', '));
  const snaps = remaining.map((p) => p.session.race.stats.snapshotsReceived / p.session.race.time);
  check(snaps.every((r) => r > 25 && r <= 31), 'スナップショットを約 30 回/秒で受ける (ロス 5%)', snaps.map((r) => r.toFixed(1)).join(', '));

  w.clock.advance(500);
  check(w.host.phase === 'lobby' && remaining.every((p) => p.session.state === 'lobby' && p.session.players.length === 3 && p.session.players.every((q) => !q.isReady)),
    'レース後はロビーに戻り、準備完了が戻る (接続は保つ)');
  w.host.close();
  w.clock.advance(500);
  check(remaining.every((p) => p.session.state === 'closed' && p.session.closeReason === 'hostClosed'), 'ホストが閉じると全員が hostClosed を検出');
}

console.log('\n== オンラインの決勝: リタイア・不正な頻度・ホストの異常終了 ==');
{
  const w = createRaceWorld({
    seed: 23, laps: 3, latencyMs: 20, jitterMs: 20, lossRate: 0.02,
    profiles: [{ name: 'HOST', team: 3 }, { name: 'SLEEP', team: 4 }, { name: 'SPAM', team: 6 }],
  });
  const [hostP, sleep, spam] = w.players;
  w.clock.advance(2000);
  for (const p of w.players) p.session.setReady(true, 'soft');
  w.clock.advance(300);
  check(w.host.startRace() === 'ok', 'レース開始');
  w.clock.advance(300);
  sleep.paused = true; // 最初から状態を送らない (接続は生きている)
  let crashedAt = null;
  let abortedAt = null;
  for (let steps = 0; steps < 60 * 90; steps++) {
    driveStep(w, (p, race) => {
      // SPAM: 5 秒から毎フレーム 3 回ずつ余計に送る (180 回/秒)
      if (p === spam && race.raceTime > 5) for (let k = 0; k < 3; k++) p.transport.sendState(m.encodeCarState(race.hostNow(), m.createCarNetState(p.session.playerId)));
    });
    const race = hostP.session.race;
    if (crashedAt === null && race.raceTime >= 66) {
      crashedAt = w.clock.now();
      w.host.dispose(); // hostClosed を送らずに止まる
    }
    if (crashedAt !== null && abortedAt === null && race.phase === 'aborted') abortedAt = w.clock.now();
    if (abortedAt !== null) break;
  }
  const race = hostP.session.race;
  const sleepCar = race.carByPlayerId(sleep.session.playerId);
  check(hasEvent(hostP, (e) => e.type === 'carGhosted' && e.carNumber === 4), '状態を送らない車は 3 秒でゴースト');
  const retiredAt = hostP.events.find((e) => e.type === 'retired' && e.carNumber === 4)?.raceTime;
  check(sleepCar.status === 'retired' && !hasEvent(hostP, (e) => e.type === 'carDisconnected' && e.carNumber === 4), '60 秒届かなければリタイア (接続は切らない)', `消灯から ${retiredAt?.toFixed(1)} 秒`);
  check(sleep.session.state !== 'closed' || sleep.session.closeReason === 'timeout', 'SLEEP の接続は保たれている (ホストが落ちるまで)');
  const spamKick = hostP.events.find((e) => e.type === 'carDisconnected' && e.carNumber === 6)?.raceTime;
  check(spamKick !== undefined && spamKick > 14 && spamKick < 18, 'state を上限 (60 回/秒) を超えて送り続けた参加者は 10 秒で切断', `消灯から ${spamKick?.toFixed(1)} 秒`);
  check(abortedAt !== null && race.abortReason === 'noSnapshot' && abortedAt - crashedAt >= 3000 && abortedAt - crashedAt < 3200,
    'ホストが落ちたら 3 秒スナップショットが届かないことで検出', abortedAt === null ? '未検出' : `${(abortedAt - crashedAt).toFixed(0)} ms`);
  check(hasEvent(hostP, (e) => e.type === 'connectionLost' && e.reason === 'noSnapshot') && hostP.session.state === 'closed', 'connectionLost が出てセッションも閉じる');
}

console.log('\n== オンラインの決勝: レース中にホストが閉じる ==');
{
  const w = createRaceWorld({ seed: 5, profiles: [{ name: 'HOST', team: 1 }, { name: 'P2P', team: 2 }, { name: 'P3P', team: 3 }] });
  w.clock.advance(2000);
  for (const p of w.players) p.session.setReady(true, 'soft');
  w.clock.advance(300);
  w.host.startRace();
  for (let steps = 0; steps < 60 * 15; steps++) driveStep(w);
  const closedAt = w.clock.now();
  w.host.close();
  for (let steps = 0; steps < 30; steps++) driveStep(w);
  check(w.players.every((p) => p.session.race.phase === 'aborted' && p.session.race.abortReason === 'hostClosed' && hasEvent(p, (e) => e.type === 'connectionLost')),
    '全員が hostClosed を受けてレースを止める', `${(w.clock.now() - closedAt).toFixed(0)} ms 以内`);
}

console.log('\n== 不正対策の再発確認 (HostRaceJudge を直接) ==');
{
  const maxSpeed = m.carParams.vBase * (1 + m.carParams.bonusCap) * m.netRaceRules.speedLimitFactor;
  const startTime = 1_726_000_100_000;
  const newJudge = (laps = 3) => new m.HostRaceJudge({ track, totalLaps: laps, entries: [{ playerId: 1, carNumber: 1 }], startTime, seed: 1, now: startTime - 8000 });
  const state = (time, pose, extra = {}) => {
    const car = m.createCarNetState(1);
    Object.assign(car, { x: pose.x, y: pose.y, heading: pose.heading, sF: 400 }, extra);
    return { seq: 0, time, car };
  };
  const g0 = track.project(track.gridSlots[0].x, track.gridSlots[0].y, -1);
  const lateral0 = g0.lateral;
  const poseAt = (s, lat = lateral0) => track.poseAt(((s % track.length) + track.length) % track.length, lat);

  // H1: 時刻を 0.001 ms ずつしか進めずに 1 周走る → 判定の時刻は到着時刻が基準なので、ラップは実際の時間になる
  {
    const judge = newJudge(1);
    const events = [];
    let now = startTime + 1000;
    let s = g0.s;
    let fakeTime = now;
    for (let k = 0; k < 60 * 45; k++) {
      now += 1000 / 60;
      s += 500 / 60;
      fakeTime += 0.001;
      judge.applyState(1, state(fakeTime, poseAt(s, 0)), now);
      events.push(...judge.update(now));
      if (judge.results) break;
    }
    const lap = events.find((e) => e.event === 'lap');
    const expected = track.length / 500;
    check(lap !== undefined && Math.abs(lap.value - expected) < 1, 'H1: 申告の時刻をずらしてもラップタイムは縮まない', `${lap?.value?.toFixed(3)} 秒 (目安 ${expected.toFixed(3)})`);
  }

  // H1: 1 通ごとに「最高速 + 25 px」ずつ進める → 余裕は時間で戻る分しか使えない
  {
    const judge = newJudge();
    let now = startTime + 1000;
    judge.applyState(1, state(now, track.gridSlots[0]), now);
    let s = g0.s;
    const t0 = now;
    for (let k = 0; k < 60 * 5; k++) {
      now += 1000 / 60;
      s += maxSpeed / 60 + 25;
      judge.applyState(1, state(now, poseAt(s), { sF: maxSpeed * 0.99 }), now);
    }
    const rc = judge.carOf(1);
    const progressed = track.deltaS(g0.s, rc.lap.projection.s);
    const speed = progressed / ((now - t0) / 1000);
    check(speed <= maxSpeed * 1.02 + m.netRaceRules.moveSlackRefillPxPerSec && judge.warningsOf(1) > 0,
      'H1: 1 通ごとの余裕を積み重ねても最高速を超えて進めない', `${speed.toFixed(0)} px/秒 (上限 ${maxSpeed.toFixed(0)})`);
  }

  // H4・M1・M4・M5
  {
    const judge = newJudge();
    let now = startTime + 1000;
    let s = g0.s;
    judge.applyState(1, state(now, track.gridSlots[0]), now);
    const drive = (seconds, speed = 500) => {
      for (let k = 0; k < 60 * seconds; k++) {
        now += 1000 / 60;
        s += speed / 60;
        judge.applyState(1, state(now, poseAt(s)), now);
      }
    };
    drive(10);
    const rc = judge.carOf(1);
    // H4: 前へ 250 px の「置き直し」を繰り返す → 捨てる
    const before = rc.lap.projection.s;
    let resetForward = 0;
    for (let k = 0; k < 10; k++) {
      now += 1000 / 30;
      if (judge.applyState(1, state(now, poseAt(s + 250 * (k + 1)), { isResetting: true }), now) === 'reset') resetForward++;
    }
    check(resetForward === 0 && Math.abs(track.deltaS(before, rc.lap.projection.s)) < 1, 'H4: 前へ進む置き直しは受け付けない', `受け付け ${resetForward} 回`);
    // 正しい置き直し (ホストの置き直し先へ後ろに跳ぶ) は受け付けるが、間隔の下限 (4.8 秒) 以内の 2 回目は受け付けない
    drive(1);
    const tryReset = () => {
      const pose = rc.lap.resetPose();
      now += 1000 / 30;
      const verdict = judge.applyState(1, state(now, pose, { isResetting: true, sF: 0 }), now);
      if (verdict === 'reset') s = track.project(pose.x, pose.y, -1).s;
      return verdict;
    };
    const first = tryReset();
    drive(2);
    const second = tryReset();
    drive(3);
    const third = tryReset();
    check(first === 'reset' && second === 'ignored' && third === 'reset', 'H4: 後ろへの置き直しは受け付け、4.8 秒以内の 2 回目は捨てる', `${first} / ${second} / ${third}`);
    drive(6);

    // M1: 壊れた速さは捨て、向きは -π〜π に直してから配る
    now += 1000 / 30;
    const huge = judge.applyState(1, state(now, poseAt(s), { sF: 3e38 }), now);
    now += 1000 / 30;
    s += 500 / 30;
    judge.applyState(1, state(now, poseAt(s), { heading: poseAt(s).heading + 200 * Math.PI }), now);
    const snap = [];
    judge.writeSnapshot(snap, now);
    check(huge === 'ignored' && Math.abs(snap[0].heading) <= Math.PI && Number.isFinite(snap[0].sF), 'M1: 速さ 3e38 は捨て、向きは直して配る');
    // M1: ゴーストの申告は上限 (8 秒) まで
    let ghostAt5 = false;
    for (let k = 0; k < 60 * 10; k++) {
      now += 1000 / 60;
      s += 500 / 60;
      judge.applyState(1, state(now, poseAt(s), { isGhost: true }), now);
      if (k === 60 * 5) {
        judge.writeSnapshot(snap, now);
        ghostAt5 = snap[0].isGhost;
      }
    }
    judge.writeSnapshot(snap, now);
    check(ghostAt5 && !snap[0].isGhost, 'M1: 申告のゴーストは連続 8 秒まで認める', `5 秒 ${ghostAt5} / 10 秒 ${snap[0].isGhost}`);

    // M4: 近いが壁で隔てられたコースの別の部分へ跳ぶ (インフィールドを横切るショートカット) → 捨てる
    let pair = null;
    for (let a = 0; a < track.length && !pair; a += 40) {
      const pa = track.poseAt(a, 0);
      for (let b = a + 2000; b < a + track.length - 2000; b += 40) {
        const pb = track.poseAt(b % track.length, 0);
        const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        if (d > 400) continue;
        let isWall = false;
        for (let u = 0.05; u < 1; u += 0.05) if (track.surfaceCodeAt(pa.x + (pb.x - pa.x) * u, pa.y + (pb.y - pa.y) * u) === m.SurfaceCode.wall) isWall = true;
        if (isWall) { pair = [a, b % track.length, d]; break; }
      }
    }
    if (pair) {
      const j2 = newJudge();
      let t = startTime + 1000;
      j2.applyState(1, state(t, track.gridSlots[0]), t);
      let s2 = g0.s;
      const target = pair[0];
      while (track.deltaS(s2 % track.length, target) > 5 || track.deltaS(s2 % track.length, target) < -5) {
        t += 1000 / 60;
        s2 += 500 / 60;
        j2.applyState(1, state(t, poseAt(s2, 0)), t);
      }
      t += 600;
      const verdict = j2.applyState(1, state(t, track.poseAt(pair[1], 0)), t);
      check(verdict === 'ignored', 'M4: 壁を横切る移動は捨てる (インフィールドのショートカット)', `${pair[2].toFixed(0)} px 離れた s=${pair[0]} → ${pair[1]}: ${verdict}`);
    } else {
      check(false, 'M4: 壁で隔てられた近い 2 点が見つからない');
    }

    // M5: 捨てられる状態 (壁の中) だけを送り続けると、3 秒でゴーストになる
    for (let k = 0; k < 60 * 4; k++) {
      now += 1000 / 60;
      judge.applyState(1, state(now, { x: -100, y: -100, heading: 0 }), now);
      judge.update(now);
    }
    check(judge.isStale(1), 'M5: 受け付けられない状態だけを送る車は 3 秒でゴースト');
  }
}

console.log('\n== 不正対策の再発確認 (レース中の collision・接続) ==');
{
  const w = createRaceWorld({ seed: 41, latencyMs: 20, jitterMs: 10, lossRate: 0, profiles: [{ name: 'HOST', team: 1 }, { name: 'P2P', team: 2 }, { name: 'P3P', team: 3 }] });
  // L2: DataChannel を開いたまま join しない相手は 5 秒で切断
  const silent = w.net.connect();
  let silentClosed = null;
  silent.onClose = (r) => { silentClosed = r; };
  w.clock.advance(2000);
  for (const p of w.players) p.session.setReady(true, 'soft');
  w.clock.advance(300);
  check(w.host.startRace() === 'ok', 'レース開始');
  w.clock.advance(300);
  const race0 = w.players[0].session.race;
  const bySlot = race0.entries.map((e) => w.players.find((p) => p.session.playerId === e.playerId));
  const [slot0, slot1, slot2] = bySlot;
  let fakeSent = false;
  let farSent = false;
  let relayedBefore = 0;
  for (let steps = 0; steps < 60 * 12; steps++) {
    driveStep(w, (p, race) => {
      // H3: グリッド 2 番手が、ポールの車に衝撃 0 の偽の collision を送ってからフライングする
      if (p === slot1 && race.phase === 'grid' && race.time > race.lightsOutAt - 1 && !fakeSent) {
        fakeSent = true;
        p.transport.sendEvent({ type: 'collision', other: slot0.session.playerId, impulseX: 0, impulseY: 0, time: race.hostNow() });
      }
      if (p === slot1 && race.phase === 'grid' && race.time > race.lightsOutAt - 0.3) creep(race.player.car);
      // H3: 離れた車 (3 番手とポール、100 px) への collision は中継しない
      if (p === slot2 && race.phase === 'grid' && race.time > race.lightsOutAt - 0.8 && !farSent) {
        farSent = true;
        relayedBefore = w.relayed.length;
        p.transport.sendEvent({ type: 'collision', other: slot0.session.playerId, impulseX: 0, impulseY: 0, time: race.hostNow() });
      }
    });
  }
  const pen = w.host.judge.carOf(slot1.session.playerId);
  check(pen.isJumpStart && pen.penalty === 3, 'H3: 偽の collision を送っても、送った本人はフライングを免除されない');
  const farRelayed = w.relayed.slice(relayedBefore).some((r) => r.from === slot2.session.playerId);
  check(!farRelayed, 'H3: 接触しえない距離の collision は中継しない');
  check(silentClosed !== null, 'L2: join しない相手は 5 秒で切断', String(silentClosed));

  // H2: 上限を超える衝撃は中継しない。形の上の上限 (1e4) を超えるものは送り主を切断し、相手は壊れない
  const victim = slot0;
  const attacker = slot1;
  const relayedCount = w.relayed.length;
  const victimCar = victim.session.race.player.car;
  const attackerCar = attacker.session.race.player.car;
  // 接触しうる距離に置いた状態で送る (中継の距離の条件を満たす)
  attacker.transport.sendEvent({ type: 'collision', other: victim.session.playerId, impulseX: 5000, impulseY: 0, time: attacker.session.race.hostNow() });
  attacker.transport.sendEvent({ type: 'collision', other: victim.session.playerId, impulseX: 1e300, impulseY: 1e300, time: attacker.session.race.hostNow() });
  for (let steps = 0; steps < 60; steps++) driveStep(w);
  check(w.relayed.length === relayedCount, 'H2: 上限を超える衝撃は中継しない', `中継 ${w.relayed.length - relayedCount} 件`);
  check(Number.isFinite(victimCar.x) && Number.isFinite(victimCar.vx) && victim.session.state !== 'closed', 'H2: 受け取る側の車は壊れず、切断されない');
  check(attacker.session.state === 'closed' && Number.isFinite(attackerCar.x), 'H2: 壊れた大きさの衝撃を送った参加者は切断');
}

console.log('\n== 送信の失敗・形の確認 ==');
{
  const clock = new VirtualClock();
  let attempts = 0;
  const ping = new m.PingSession({ clock, send: () => { attempts++; throw new Error('InvalidStateError'); }, intervalMs: 1000 });
  ping.start();
  clock.advance(5500);
  check(attempts >= 6 && ping.isRunning, 'M2: 送信が例外を投げても ping は止まらない', `${attempts} 回`);
  ping.stop();
  const noLines = { length: 1000, timingLines: [] };
  const rc = { timingTimes: new Float64Array(10), lastTimingKey: -1 };
  m.recordTimingByDistance(rc, noLines, 0, 0, 100, 1);
  check(rc.lastTimingKey === -1, 'L3: タイミングラインが 0 本でも止まらない');
  const settings = { course: 'course1', courseVersion: 3, laps: 3 };
  check(m.parseHostMessage(JSON.stringify({ type: 'raceStart', session: 'race', startTime: 1, settings, grid: [1, 1], seed: 1 })) === null
    && m.parseHostMessage(JSON.stringify({ type: 'raceStart', session: 'race', startTime: 1, settings, grid: [0, 1, 2, 3, 4, 5, 6, 7, 1], seed: 1 })) === null,
    'L4: raceStart のグリッドの重複・8 台超は捨てる');
  check(m.parseClientMessage(JSON.stringify({ type: 'collision', other: 1, impulseX: 1e300, impulseY: 0, time: 1 })) === null, 'H2: 形の上の上限を超える衝撃は不正なメッセージ');
}

console.log('\n== 中継: 招待リンク (#room=) ==');
{
  const cred = await m.createRoomCredentials();
  check(m.isRoomId(cred.roomId) && m.isRoomKey(cred.key) && cred.secret.length === 43, '部屋 ID・鍵は 22 文字、ホストの秘密は 43 文字 (Base64url)');
  check(await m.roomIdOfSecret(cred.secret) === cred.roomId, '部屋 ID = ホストの秘密のハッシュ (中継が同じ計算で確かめる)');
  check(await m.roomIdOfSecret('short') === null && await m.roomIdOfSecret(cred.secret.slice(1) + '!') === null, '形の違う秘密は null');
  const other = await m.createRoomCredentials();
  check(other.roomId !== cred.roomId && other.key !== cred.key, '部屋ごとに違う値');
  const link = m.roomLinkOf('https://kaseliaepenguin.github.io/pix-lights-out/#room=old', cred);
  check(link === `https://kaseliaepenguin.github.io/pix-lights-out/#room=${cred.roomId}.${cred.key}`, 'リンクの形 (<ページの URL>#room=<部屋 ID>.<鍵>)', `${link.length} 文字`);
  check(!link.includes(cred.secret), 'リンクにホストの秘密は入らない');
  const hash = link.slice(link.indexOf('#'));
  const parsed = m.roomLinkFromHash(hash);
  check(parsed?.roomId === cred.roomId && parsed?.key === cred.key, 'location.hash から部屋 ID と鍵を取り出す');
  check(m.roomLinkFromHash('#join=PLO1I.abc') === null && m.roomLinkFromHash('') === null && m.roomLinkFromHash('#room=abc.def') === null,
    '中継の招待リンクでない・短すぎるフラグメントは null');
  check(m.isRoomLinkHash('#room=broken') && !m.isRoomLinkHash('#join=PLO1I.x'), '前置きだけの判定 (URL から消すかどうか)');
  check(m.parseRoomLink(`入って! ${link} よろしく`)?.key === cred.key, '貼り付け: 前後に文があるリンク');
  check(m.parseRoomLink(`${link.slice(0, 60)}\n${link.slice(60)}`)?.key === cred.key, '貼り付け: 折り返しで切れたリンク');
  check(m.parseRoomLink(`join: ${link} thanks`)?.key === cred.key, '貼り付け: 後ろに英単語が続くリンク');
  check(m.parseRoomLink(`${link}x`) === null, '鍵が 22 文字でない (後ろに文字がくっついた) ものは読まない');
  check(m.extractConnectionCode(link) === null && m.checkConnectionCode(link, 'invite').ok === false, '従来の招待コードの読み取りは中継のリンクを拾わない');
}

console.log('\n== 中継: 暗号化と認証 (RelayCipher) ==');
{
  const cred = await m.createRoomCredentials();
  const host = await m.RelayCipher.create(cred.roomId, cred.key);
  const guest = await m.RelayCipher.create(cred.roomId, cred.key);
  const sid = m.createRelaySessionId();
  const sdp = chromeSdp({ setup: 'actpass', candidates: [] });
  const offer = { type: 'offer', sid, pv: m.protocolVersion, sdp };
  const sealed = await guest.seal('toHost', offer);
  check(!sealed.includes('v=0') && !sealed.includes(sid) && /^[A-Za-z0-9_-]+$/.test(sealed), '暗号文に SDP・sid が見えない (Base64url)', `${sealed.length} 文字`);
  check(sealed.length < m.relayLimits.maxFrameBytes - 200, '候補を除いた offer は 1 通の上限 (4KB) に余裕をもって収まる', `${sealed.length} 文字`);
  const r1 = await host.open('toHost', sealed);
  check(r1.ok && r1.payload.type === 'offer' && r1.payload.sdp === sdp && r1.payload.sid === sid, '復号できる (offer)');
  const r2 = await host.open('toHost', sealed);
  check(!r2.ok && r2.error === 'replay', '同じものの再送は拒否 (replay)');
  // 1 文字書き換え
  const bytes = m.decodeBase64url(sealed);
  bytes[20] ^= 1;
  const r3 = await host.open('toHost', m.encodeBase64url(bytes));
  check(!r3.ok && r3.error === 'auth', '書き換えたものは認証で拒否');
  const wrongKey = await m.RelayCipher.create(cred.roomId, (await m.createRoomCredentials()).key);
  const r4 = await wrongKey.open('toHost', await guest.seal('toHost', offer));
  check(!r4.ok && r4.error === 'auth', '別の鍵では読めない');
  const otherRoom = await m.createRoomCredentials();
  const sameKeyOtherRoom = await m.RelayCipher.create(otherRoom.roomId, cred.key);
  const r5 = await sameKeyOtherRoom.open('toHost', await guest.seal('toHost', offer));
  check(!r5.ok && r5.error === 'auth', '同じ鍵でも別の部屋 ID では読めない (部屋をまたいだ使い回しの拒否)');
  const r6 = await guest.open('toGuest', await host.seal('toHost', offer));
  check(!r6.ok && r6.error === 'auth', '向き違い (ホストあてのものを参加者に送り返す) は拒否');
  const now = Date.now();
  const old = await guest.seal('toHost', offer, now - 11 * 60 * 1000);
  const r7 = await host.open('toHost', old, now);
  check(!r7.ok && r7.error === 'stale', '10 分より古いものは拒否 (stale)');
  const future = await guest.seal('toHost', offer, now + 11 * 60 * 1000);
  check((await host.open('toHost', future, now)).ok === false, '10 分より先の時刻のものも拒否');
  const skewed = await guest.seal('toHost', offer, now - 3 * 60 * 1000);
  check((await host.open('toHost', skewed, now)).ok, '時計のずれが 10 分以内なら受け付ける');
  const answer = { type: 'answer', sid, lobbyId: 0xdeadbeef, slot: 3, sdp: chromeSdp({ setup: 'active', candidates: [] }) };
  const ra = await guest.open('toGuest', await host.seal('toGuest', answer));
  check(ra.ok && ra.payload.type === 'answer' && ra.payload.slot === 3 && ra.payload.lobbyId === 0xdeadbeef, '復号できる (answer)');
  const rb = await host.open('toHost', await host.seal('toHost', answer));
  check(!rb.ok && rb.error === 'malformed', '向きに合わない種類 (ホストあての answer) は拒否');
  const cand = { type: 'cand', sid, c: { candidate: 'candidate:842163049 1 udp 1677729535 203.0.113.45 50027 typ srflx raddr 0.0.0.0 rport 0', sdpMid: '0', sdpMLineIndex: 0 } };
  const rc = await host.open('toHost', await guest.seal('toHost', cand));
  check(rc.ok && rc.payload.type === 'cand' && rc.payload.c.sdpMid === '0', '復号できる (候補)');
  const badCand = { type: 'cand', sid, c: { candidate: 'x'.repeat(50), sdpMid: '0', sdpMLineIndex: 0 } };
  check((await host.open('toHost', await guest.seal('toHost', badCand))).ok === false, '形の違う候補は拒否');
  check((await host.open('toHost', await guest.seal('toHost', { type: 'offer', sid: 'short', pv: 1, sdp }))).ok === false, '形の違う sid は拒否');
  check((await host.open('toHost', await guest.seal('toHost', { ...offer, sdp: 'v=0' + 'a'.repeat(4000) }))).ok === false, '長すぎる SDP は拒否');
  const rej = await guest.open('toGuest', await host.seal('toGuest', { type: 'reject', sid, reason: 'full', pv: m.protocolVersion }));
  check(rej.ok && rej.payload.reason === 'full', '復号できる (reject)');
  check(await m.RelayCipher.create('short', cred.key) === null && await m.RelayCipher.create(cred.roomId, 'bad!') === null, '形の違う部屋 ID・鍵では作れない');
  check((await host.open('toHost', 'not-base64!')).ok === false && (await host.open('toHost', 'AAAA')).ok === false, '壊れた文字列は拒否');
}

console.log('\n== 中継: フレームの形 ==');
{
  check(m.parseRelayClientFrame('{"t":"join"}')?.t === 'join' && m.parseRelayClientFrame('{"t":"host","secret":"x"}')?.t === 'host', 'join・host を読む');
  check(m.parseRelayClientFrame('{"t":"send","to":0,"data":"abc"}')?.t === 'send' && m.parseRelayClientFrame('{"t":"send","to":-1,"data":"a"}') === null
    && m.parseRelayClientFrame('{"t":"send","to":0,"data":""}') === null && m.parseRelayClientFrame('{"t":"send","to":1.5,"data":"a"}') === null, 'send の宛先・中身を確かめる');
  check(m.parseRelayClientFrame('nope') === null && m.parseRelayClientFrame('null') === null && m.parseRelayClientFrame('{"t":"x"}') === null, '壊れたフレームは null');
  check(m.parseRelayServerFrame('{"t":"ready","role":"guest","peer":3,"remainingMs":1000}')?.peer === 3 && m.parseRelayServerFrame('{"t":"ready","role":"x","peer":3,"remainingMs":1}') === null,
    'ready を読む');
  check(m.relayCloseNameOf(4009) === 'full' && m.relayCloseNameOf(1006) === null, 'close コードから理由の名前');
  check(m.isFrameTooLarge('a'.repeat(4097)) && !m.isFrameTooLarge('a'.repeat(4096)) && m.isFrameTooLarge('あ'.repeat(1400)), '1 通の大きさの上限 (UTF-8 で数える)');
}

console.log('\n== 中継: 部屋の処理 (RoomCore、Durable Object と同じもの) ==');
{
  let now = 1_000_000;
  const sockets = [];
  const core = new m.RoomCore({ sockets: () => sockets.filter((s) => !s.closed), now: () => now });
  let nextId = 0;
  const open = (roomId) => {
    const s = {
      infoValue: m.RoomCore.initialInfo(roomId, `s${nextId++}`, now), sent: [], closed: null,
      get info() { return this.infoValue; },
      save(info) { this.infoValue = { ...info }; },
      send(text) { if (this.closed) throw new Error('closed'); this.sent.push(text); },
      close(code, reason) { this.closed = { code, reason }; },
      frames() { return this.sent.filter((t) => t !== 'pong').map((t) => JSON.parse(t)); },
      last() { const f = this.frames(); return f[f.length - 1]; },
    };
    sockets.push(s);
    return s;
  };
  const say = (s, frame) => core.onMessage(s, typeof frame === 'string' ? frame : JSON.stringify(frame));
  const cred = await m.createRoomCredentials();
  const room = cred.roomId;

  const early = open(room);
  await say(early, { t: 'join' });
  check(early.closed?.code === m.relayCloseCodes.noRoom, 'ホストがいない部屋に入る → noRoom');

  const fake = open(room);
  await say(fake, { t: 'host', secret: (await m.createRoomCredentials()).secret });
  check(fake.closed?.code === m.relayCloseCodes.unauthorized, '別の秘密でホストを名乗る → unauthorized (なりすまし不可)');
  const wrongRoom = open((await m.createRoomCredentials()).roomId);
  await say(wrongRoom, { t: 'host', secret: cred.secret });
  check(wrongRoom.closed?.code === m.relayCloseCodes.unauthorized, '本物の秘密でも別の部屋 ID では拒否');

  const host = open(room);
  await say(host, { t: 'host', secret: cred.secret });
  const ready = host.last();
  check(ready?.t === 'ready' && ready.role === 'host' && ready.remainingMs === m.relayLimits.roomLifetimeMs, 'ホストが部屋を作る (ready、寿命 30 分)');
  check(core.nextAlarmAt() === now + m.relayLimits.roomLifetimeMs, 'アラームは部屋の寿命に合わせる');

  const g1 = open(room);
  await say(g1, { t: 'join' });
  check(g1.last()?.t === 'ready' && g1.last().peer === 1 && host.last()?.t === 'joined' && host.last().peer === 1, '参加者が入る (番号 1、ホストに joined)');
  await say(g1, { t: 'send', to: 5, data: 'secret-1' });
  check(host.last()?.t === 'msg' && host.last().from === 1 && host.last().data === 'secret-1', '参加者 → ホストへ中継 (宛先は無視してホストへ)');
  await say(host, { t: 'send', to: 1, data: 'secret-2' });
  check(g1.last()?.t === 'msg' && g1.last().from === 0 && g1.last().data === 'secret-2', 'ホスト → 参加者へ中継');
  const g2 = open(room);
  await say(g2, { t: 'join' });
  const g2Count = g2.frames().length;
  await say(host, { t: 'send', to: 1, data: 'only-for-1' });
  check(g2.frames().length === g2Count, 'ほかの参加者あてのものは届かない');
  await say(g1, { t: 'kick', peer: 2 });
  check(g1.closed?.code === m.relayCloseCodes.badRequest && !g2.closed, '参加者は kick できない (送った人が切られる)');
  check(host.last()?.t === 'left' && host.last().peer === 1, '参加者が切られたらホストに left');
  await say(host, { t: 'kick', peer: 2 });
  check(g2.closed?.code === m.relayCloseCodes.kicked, 'ホストは参加者を外せる (kicked)');

  const guests = [];
  for (let i = 0; i < 8; i++) {
    const g = open(room);
    await say(g, { t: 'join' });
    guests.push(g);
  }
  check(guests.slice(0, 7).every((g) => !g.closed) && guests[7].closed?.code === m.relayCloseCodes.full, '同時に入れる参加者は 7 人 (8 人目は full)');
  await say(guests[0], { t: 'send', to: 0, data: 'x'.repeat(m.relayLimits.maxFrameBytes) });
  check(guests[0].closed?.code === m.relayCloseCodes.tooLarge, '1 通が 4KB を超えたら切る (tooLarge)');
  await core.onMessage(guests[1], new ArrayBuffer(8));
  check(guests[1].closed?.code === m.relayCloseCodes.badRequest, 'バイナリは受け付けない');
  await say(guests[2], 'ping');
  check(guests[2].sent[guests[2].sent.length - 1] === 'pong' && !guests[2].closed, 'ping には pong (回数に数えない)');
  for (let i = 0; i <= m.relayLimits.burstCount; i++) await say(guests[2], { t: 'send', to: 0, data: 'spam' });
  check(guests[2].closed?.code === m.relayCloseCodes.rateLimited, `短い間に ${m.relayLimits.burstCount} 通を超えたら切る (rateLimited)`);
  const slow = guests[3];
  for (let i = 0; i < m.relayLimits.maxGuestFrames + 1 && !slow.closed; i++) {
    now += 200;
    await say(slow, { t: 'send', to: 0, data: 'x' });
  }
  check(slow.closed?.code === m.relayCloseCodes.rateLimited, `1 本の接続で ${m.relayLimits.maxGuestFrames} 通を超えたら切る`);
  await say(guests[4], '{"t":"host","secret":"x"}');
  check(guests[4].closed?.code === m.relayCloseCodes.badRequest, '名乗ったあとにもう一度名乗ると切る');

  // 名乗らない接続
  const silent = open(room);
  check(core.nextAlarmAt() === silent.info.openedAt + m.relayLimits.helloTimeoutMs, '名乗る前の接続があれば、その締め切りにアラーム');
  now += m.relayLimits.helloTimeoutMs;
  core.onAlarm();
  check(silent.closed?.code === m.relayCloseCodes.helloTimeout && !host.closed, '10 秒名乗らない接続はアラームで切る');

  // 名乗る前の接続の数
  const pendings = [];
  while (core.canAccept()) pendings.push(open(room));
  check(pendings.length === m.relayLimits.maxPendingSockets, `名乗る前の接続は ${m.relayLimits.maxPendingSockets} 本まで (それ以上は 503)`);
  for (const p of pendings) p.close(1000, 'test');

  // ホストの入り直し (寿命は引き継ぐ)
  const createdAt = host.info.roomCreatedAt;
  const host2 = open(room);
  await say(host2, { t: 'host', secret: cred.secret });
  check(host.closed?.code === m.relayCloseCodes.replaced && host2.last()?.t === 'ready' && host2.info.roomCreatedAt === createdAt,
    '同じ秘密で入り直すと前の接続は replaced、寿命は延びない');
  const live = guests.filter((g) => !g.closed);
  check(live.length > 0, '入り直しでは参加者は切られない');
  const g9 = open(room);
  await say(g9, { t: 'join' });
  check(g9.last()?.peer > 9, '参加者の番号は使い回さない (入り直しても続きから)', `番号 ${g9.last()?.peer}`);

  // 期限切れ
  now = createdAt + m.relayLimits.roomLifetimeMs;
  core.onAlarm();
  check(host2.closed?.code === m.relayCloseCodes.expired && live.every((g) => g.closed?.code === m.relayCloseCodes.expired), '30 分で部屋を閉じる (全員 expired)');
  const after = open(room);
  await say(after, { t: 'join' });
  check(after.closed?.code === m.relayCloseCodes.noRoom, '閉じた部屋には入れない (noRoom)');

  // ホストが抜けたら参加者も切る
  const host3 = open(room);
  await say(host3, { t: 'host', secret: cred.secret });
  const g10 = open(room);
  await say(g10, { t: 'join' });
  host3.closed = { code: 1001, reason: 'gone' };
  core.onClose(host3);
  check(g10.closed?.code === m.relayCloseCodes.hostLeft, 'ホストが抜けたら参加者を切る (hostLeft)');
  check(core.nextAlarmAt() === null, '誰もいなければアラームなし');
}

console.log('\n== 中継: Origin の確認 ==');
{
  const allowed = 'https://kaseliaepenguin.github.io,http://localhost:*';
  check(m.isAllowedOrigin('https://kaseliaepenguin.github.io', allowed), '配信先の Origin は通す');
  check(m.isAllowedOrigin('http://localhost:5173', allowed) && m.isAllowedOrigin('http://localhost:4173', allowed), 'localhost はどのポートでも通す (:*)');
  check(!m.isAllowedOrigin('https://evil.example', allowed) && !m.isAllowedOrigin('https://kaseliaepenguin.github.io.evil.example', allowed)
    && !m.isAllowedOrigin('http://localhost:5173.evil.example', allowed) && !m.isAllowedOrigin('http://localhost.evil:80', allowed), 'ほかの Origin・似た名前は通さない');
  check(!m.isAllowedOrigin(null, allowed) && !m.isAllowedOrigin('null', allowed), 'Origin がない要求は通さない');
}

console.log(failures === 0 ? '\nすべての確認が OK' : `\nNG が ${failures} 件`);
process.exitCode = failures === 0 ? 0 : 1;
