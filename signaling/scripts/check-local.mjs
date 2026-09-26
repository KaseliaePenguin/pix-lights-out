// 中継 (signaling/) を wrangler dev で動かし、Node 24 の WebSocket で確かめる。終わったら wrangler dev を止める。
//   cd signaling && npm run check:local     (または node signaling/scripts/check-local.mjs)
// 部屋の作成・参加・中継・生存確認 (ping)・1 通の上限・送信回数の上限・満員・kick・名乗らない接続・ホストの退出・
// 期限切れ (確認用に寿命を 8 秒にする)・Origin の確認・なりすましの拒否。
// 別の wrangler dev と重ならないようにポート 8788 を使う。すでに動いている中継を確かめるときは SIGNAL_URL=ws://… を付ける
// (その場合は wrangler を起動せず、期限切れの確認は飛ばす)。
import { spawn, execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const signalingDir = path.resolve(here, '..');
const port = 8788;
const lifetimeSec = 8;
const external = process.env.SIGNAL_URL ?? null;
const base = external ?? `ws://127.0.0.1:${port}`;
const origin = process.env.SIGNAL_ORIGIN ?? 'http://localhost:5173';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  [${ok ? 'OK' : 'NG'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** src/shared/net/relayProtocol.ts の roomIdOfSecret と同じ計算 (別の実装で一致を確かめる) */
function newRoom() {
  const secretBytes = randomBytes(32);
  const secret = secretBytes.toString('base64url');
  const roomId = createHash('sha256').update(Buffer.concat([Buffer.from('PLO-room-v1.'), secretBytes])).digest().subarray(0, 16).toString('base64url');
  return { secret, roomId };
}

/** WebSocket 1 本。届いたフレームをためて、待てるようにする */
function connect(roomId, { originHeader = origin } = {}) {
  const ws = originHeader === null
    ? new WebSocket(`${base}/rooms/${roomId}`)
    : new WebSocket(`${base}/rooms/${roomId}`, { headers: { Origin: originHeader } });
  const c = { ws, frames: [], texts: [], closed: null, opened: false, waiters: [] };
  const wake = () => { for (const w of c.waiters.splice(0)) w(); };
  ws.onopen = () => { c.opened = true; wake(); };
  ws.onmessage = (e) => {
    c.texts.push(e.data);
    if (e.data !== 'pong') c.frames.push(JSON.parse(e.data));
    wake();
  };
  ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; wake(); };
  ws.onerror = () => undefined;
  c.send = (v) => ws.send(typeof v === 'string' ? v : JSON.stringify(v));
  c.until = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred(c)) {
      const left = end - Date.now();
      if (left <= 0) return false;
      await new Promise((r) => { c.waiters.push(r); setTimeout(r, left); });
    }
    return true;
  };
  c.frame = (t) => c.until((x) => x.frames.some((f) => f.t === t)).then(() => c.frames.find((f) => f.t === t) ?? null);
  c.untilClosed = (ms) => c.until((x) => x.closed !== null, ms).then(() => c.closed);
  return c;
}

/** Upgrade の HTTP の応答コードを見る (Origin の拒否は 403) */
function upgradeStatus(roomId, originHeader) {
  const url = new URL(`${base.replace(/^ws/, 'http')}/rooms/${roomId}`);
  const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64') };
  if (originHeader) headers.Origin = originHeader;
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(url, { headers });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function hostRoom() {
  const room = newRoom();
  const host = connect(room.roomId);
  await host.until((x) => x.opened || x.closed);
  host.send({ t: 'host', secret: room.secret });
  const ready = await host.frame('ready');
  return { room, host, ready };
}

async function joinRoom(roomId) {
  const g = connect(roomId);
  await g.until((x) => x.opened || x.closed);
  if (!g.closed) g.send({ t: 'join' });
  await g.until((x) => x.frames.some((f) => f.t === 'ready') || x.closed);
  return g;
}

// ---------------------------------------------------------------- wrangler dev の起動
let wrangler = null;
function stopWrangler() {
  if (!wrangler || wrangler.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${wrangler.pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-wrangler.pid, 'SIGTERM');
  } catch {
    // すでに止まっている
  }
}
process.on('exit', stopWrangler);
process.on('SIGINT', () => { stopWrangler(); process.exit(130); });

if (!external) {
  const cli = path.join(signalingDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  wrangler = spawn(process.execPath, [cli, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--var', `ROOM_LIFETIME_SEC:${lifetimeSec}`], {
    cwd: signalingDir, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let log = '';
  const ready = new Promise((resolve) => {
    const onData = (d) => {
      log += d.toString();
      if (/Ready on/.test(log)) resolve(true);
    };
    wrangler.stdout.on('data', onData);
    wrangler.stderr.on('data', onData);
    wrangler.on('exit', () => resolve(false));
    setTimeout(() => resolve(false), 60000);
  });
  if (!(await ready)) {
    console.log(log);
    console.log('wrangler dev が起動しませんでした');
    stopWrangler();
    process.exit(1);
  }
  console.log(`wrangler dev: ${base} (部屋の寿命 ${lifetimeSec} 秒)`);
}

try {
  console.log('\n== HTTP・Origin ==');
  {
    const { roomId } = newRoom();
    const httpBase = base.replace(/^ws/, 'http');
    const plain = await fetch(`${httpBase}/rooms/${roomId}`, { headers: { Origin: origin } });
    check(plain.status === 426, 'WebSocket でない要求は 426', `${plain.status}`);
    const other = await fetch(`${httpBase}/`);
    check(other.status === 404, '部屋以外の URL は 404', `${other.status}`);
    const badId = await fetch(`${httpBase}/rooms/short`);
    check(badId.status === 404, '形の違う部屋 ID は 404', `${badId.status}`);
    check(await upgradeStatus(roomId, 'https://evil.example') === 403, 'ほかの Origin は 403');
    check(await upgradeStatus(roomId, null) === 403, 'Origin がない要求は 403');
    check(await upgradeStatus(roomId, 'https://kaseliaepenguin.github.io') === 101, '配信先 (GitHub Pages) の Origin は通す (101)');
    const evil = connect(roomId, { originHeader: 'https://evil.example' });
    const closed = await evil.untilClosed();
    check(!evil.opened && closed !== null, 'ほかの Origin からの WebSocket はつながらない');
  }

  console.log('\n== 部屋の作成・参加・中継 ==');
  {
    const fakeRoom = newRoom();
    const fake = connect(fakeRoom.roomId);
    await fake.until((x) => x.opened);
    fake.send({ t: 'host', secret: newRoom().secret });
    check((await fake.untilClosed())?.code === 4001, '別の秘密でホストを名乗ると 4001 (なりすまし不可)');

    const nobody = await joinRoom(newRoom().roomId);
    check((await nobody.untilClosed())?.code === 4004, 'ホストのいない部屋に入ると 4004');

    const { room, host, ready } = await hostRoom();
    check(ready?.role === 'host' && ready.remainingMs > 0 && ready.remainingMs <= lifetimeSec * 1000, '部屋を作る (ready)', `残り ${ready?.remainingMs} ms`);
    const g1 = await joinRoom(room.roomId);
    const g1Ready = g1.frames.find((f) => f.t === 'ready');
    check(g1Ready?.role === 'guest' && g1Ready.peer === 1, '参加者が入る (番号 1)');
    const joined = await host.frame('joined');
    check(joined?.peer === 1, 'ホストに joined が届く');
    g1.send({ t: 'send', to: 0, data: 'opaque-offer' });
    await host.until((x) => x.frames.some((f) => f.t === 'msg'));
    const msg = host.frames.find((f) => f.t === 'msg');
    check(msg?.from === 1 && msg.data === 'opaque-offer', '参加者 → ホストへ中継');
    host.send({ t: 'send', to: 1, data: 'opaque-answer' });
    const back = await g1.frame('msg');
    check(back?.from === 0 && back.data === 'opaque-answer', 'ホスト → 参加者へ中継');
    g1.send('ping');
    await g1.until((x) => x.texts.includes('pong'));
    check(g1.texts.includes('pong'), 'ping に pong (自動応答)');

    const big = await joinRoom(room.roomId);
    big.send({ t: 'send', to: 0, data: 'x'.repeat(5000) });
    check((await big.untilClosed())?.code === 4013, '4KB を超える 1 通は 4013');
    const spam = await joinRoom(room.roomId);
    for (let i = 0; i < 45; i++) spam.send({ t: 'send', to: 0, data: 'spam' });
    check((await spam.untilClosed())?.code === 4029, '短い間に送りすぎると 4029');
    await host.until((x) => x.frames.filter((f) => f.t === 'left').length >= 2);
    check(host.frames.filter((f) => f.t === 'left').length >= 2, '切られた参加者はホストに left で知らせる');

    const more = [];
    for (let i = 0; i < 7; i++) more.push(await joinRoom(room.roomId));
    const open = more.filter((g) => !g.closed).length;
    const last = more[more.length - 1];
    check(open === 6 && last.closed?.code === 4009, '同時に入れる参加者は 7 人まで (8 人目は 4009)', `入れた ${open + 1} 人`);
    const victim = more[0];
    const victimPeer = victim.frames.find((f) => f.t === 'ready')?.peer;
    host.send({ t: 'kick', peer: victimPeer });
    check((await victim.untilClosed())?.code === 4003, 'ホストが外した参加者は 4003');

    host.ws.close(1000, 'bye');
    const codes = await Promise.all([g1, ...more.slice(1, 6)].map((g) => g.untilClosed()));
    check(codes.every((c) => c?.code === 4010), 'ホストが抜けたら参加者は 4010 (部屋はすぐ消える)');
    const late = await joinRoom(room.roomId);
    check((await late.untilClosed())?.code === 4004, 'ホストが抜けた部屋には入れない (4004)');
  }

  console.log('\n== 名乗らない接続・期限切れ ==');
  {
    const tasks = [];
    tasks.push((async () => {
      const silent = connect(newRoom().roomId);
      // ping (自動応答。名乗りには数えない) だけ送る。wrangler dev では、一度も送らない接続には中継が閉じても close が届かない
      await silent.until((x) => x.opened || x.closed);
      if (!silent.closed) silent.send('ping');
      const started = Date.now();
      const c = await silent.untilClosed(15000);
      check(c?.code === 4408, '名乗らない接続は 10 秒で 4408', `${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    })());
    if (!external) {
      tasks.push((async () => {
        const { room, host } = await hostRoom();
        const g = await joinRoom(room.roomId);
        const started = Date.now();
        const [hc, gc] = await Promise.all([host.untilClosed(15000), g.untilClosed(15000)]);
        check(hc?.code === 4008 && gc?.code === 4008, `部屋の寿命 (確認用 ${lifetimeSec} 秒) で全員 4008`, `${((Date.now() - started) / 1000).toFixed(1)} 秒`);
        const again = connect(room.roomId);
        await again.until((x) => x.opened);
        again.send({ t: 'host', secret: room.secret });
        const r = await again.frame('ready');
        check(r !== null && r.remainingMs > lifetimeSec * 1000 - 2000, '期限切れのあと同じ秘密で作り直すと新しい部屋 (寿命は数え直し)');
        again.ws.close();
      })());
    }
    await Promise.all(tasks);
  }
} finally {
  stopWrangler();
}

await sleep(300);
console.log(failures === 0 ? '\nすべての確認が OK' : `\nNG が ${failures} 件`);
process.exitCode = failures === 0 ? 0 : 1;
