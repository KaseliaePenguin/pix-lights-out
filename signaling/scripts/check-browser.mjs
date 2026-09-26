// 中継経由の接続を、ヘッドレス Chrome (音は出さない: --mute-audio) の 3 つのタブで確かめる。
// ホストのタブで HostLobby.openRoom → 参加者 2 人のタブで GuestRoomConnector.join → WebRTC がつながりロビーに入る →
// ホストが 1 人を kick。部屋がない・中継がないときの失敗 (返答コード方式への切り替えの判定) も見る。
//   node signaling/scripts/check-browser.mjs
// Vite の開発サーバー (ポート 5174) と wrangler dev (ポート 8790) をこのスクリプトが起動し、終わったら Chrome と一緒に止める。
// すでに動いている中継を使うときは SIGNAL_URL=wss://… を付ける (wrangler は起動しない)。
// Chrome は CHROME_PATH、なければ Windows の既定の場所を使う。
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const signalingDir = path.resolve(here, '..');
const root = path.resolve(signalingDir, '..');
const vitePort = 5174;
const signalPort = 8790;
const debugPort = 9333;
const external = process.env.SIGNAL_URL ?? null;
const signalUrl = external ?? `ws://127.0.0.1:${signalPort}`;
const chromePath = process.env.CHROME_PATH ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  .find((p) => existsSync(p));

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  [${ok ? 'OK' : 'NG'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
let isStopping = false;
function stopAll() {
  isStopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // すでに止まっている
    }
  }
}
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

function start(label, cmd, args, cwd, readyPattern) {
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  children.push(child);
  let log = '';
  return new Promise((resolve) => {
    const onData = (d) => {
      log += d.toString();
      if (readyPattern.test(log)) resolve(true);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => {
      if (!isStopping) console.log(`${label} が止まりました\n${log}`);
      resolve(false);
    });
    setTimeout(() => resolve(false), 60000);
  });
}

/** CDP (Chrome DevTools Protocol) の 1 つのタブ */
async function openTab(url) {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  /** ページで async 関数の本体を動かし、JSON にできる値を返す */
  const run = async (body) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    return r.result?.result?.value;
  };
  // ページ (Vite の開発サーバー) の読み込みを待つ
  for (let i = 0; i < 100; i++) {
    const ready = await run('return document.readyState === "complete" && !!document.getElementById("game");').catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  return { run, close: () => ws.close() };
}

if (!chromePath) {
  console.log('Chrome が見つかりません (CHROME_PATH で指定する)');
  process.exit(1);
}

const profileDir = mkdtempSync(path.join(os.tmpdir(), 'plo-chrome-'));
try {
  const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const waits = [start('vite', process.execPath, [viteCli, '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'], root, /ready in/)];
  if (!external) {
    const cli = path.join(signalingDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    waits.push(start('wrangler dev', process.execPath, [cli, 'dev', '--port', String(signalPort), '--ip', '127.0.0.1'], signalingDir, /Ready on/));
  }
  if (!(await Promise.all(waits)).every(Boolean)) throw new Error('サーバーが起動しませんでした');
  // 音を出さない (--mute-audio)。終わったら必ず止める
  const chrome = spawn(chromePath, [
    '--headless=new', '--mute-audio', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore', detached: process.platform !== 'win32' });
  children.push(chrome);
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(() => true, () => false);
    if (ok) break;
    await sleep(100);
  }

  const page = `http://127.0.0.1:${vitePort}/?signal=${encodeURIComponent(signalUrl)}`;
  const imports = `
    const { HostLobby } = await import('/src/host/HostLobby.ts');
    const { GuestRoomConnector, shouldFallbackToCode } = await import('/src/net/GuestRoomConnector.ts');
    const { NetClientSession } = await import('/src/net/NetClientSession.ts');
    const { parseRoomLink } = await import('/src/shared/net/roomLink.ts');
    const { getCourseTrack } = await import('/src/scenes/courseCache.ts');
    const waitFor = async (pred, ms) => { const end = performance.now() + ms; while (!pred()) { if (performance.now() > end) return false; await new Promise((r) => setTimeout(r, 50)); } return true; };
  `;
  const hostTab = await openTab(page);
  const guestTabs = [await openTab(page), await openTab(page)];

  console.log('\n== 中継経由の接続 (ヘッドレス Chrome の 3 タブ) ==');
  const room = await hostTab.run(`${imports}
    window.lobby = HostLobby.create({ name: 'HOST', team: 1 }, getCourseTrack());
    const t0 = performance.now();
    lobby.openRoom(location.origin + location.pathname);
    await waitFor(() => lobby.room && lobby.room.state !== 'connecting', 8000);
    return { ...lobby.room, ms: Math.round(performance.now() - t0) };`);
  check(room?.state === 'open' && /#room=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/.test(room.link ?? ''), 'ホストが部屋を作り、共通の招待リンクが出る',
    `${room?.ms} ms、${room?.link}`);
  const link = room?.link ?? '';

  const guestScript = (name, team) => `${imports}
    const t0 = performance.now();
    const c = GuestRoomConnector.join(parseRoomLink(${JSON.stringify(link)}));
    const phases = [];
    c.onChange = () => phases.push(c.phase);
    const r = await new Promise((resolve) => {
      c.onOpen = (transport) => resolve({ ok: true, transport });
      c.onFail = (failure) => resolve({ ok: false, failure });
    });
    const openMs = Math.round(performance.now() - t0);
    if (!r.ok) return { ok: false, failure: r.failure, phases, diag: c.diagnostics() };
    window.session = new NetClientSession(r.transport, { name: ${JSON.stringify(name)}, team: ${team} }, getCourseTrack());
    await waitFor(() => session.state === 'lobby', 8000);
    return { ok: true, openMs, lobbyMs: Math.round(performance.now() - t0), slot: c.slot, phases, state: session.state, players: session.players.length };`;
  const results = await Promise.all([guestTabs[0].run(guestScript('GUESTA', 2)), guestTabs[1].run(guestScript('GUESTB', 3))]);
  for (const [i, r] of results.entries()) {
    check(r?.ok === true && r.state === 'lobby', `参加者 ${i + 1}: リンクだけでロビーに入る (返答コードなし)`,
      r?.ok ? `つながるまで ${r.openMs} ms、ロビーまで ${r.lobbyMs} ms、枠 ${r.slot}、${r.phases.join(' → ')}` : JSON.stringify(r).slice(0, 300));
  }
  check(results[0]?.slot !== results[1]?.slot, '枠は重ならずに自動で割り当てる', `${results[0]?.slot} / ${results[1]?.slot}`);
  const hostView = await hostTab.run(`
    await new Promise((r) => setTimeout(r, 500));
    return { slots: lobby.slots.filter((s) => s.state !== 'empty').map((s) => ({ slot: s.slot, state: s.state, via: s.via, gather: !!s.gather })),
      players: lobby.status?.players.length ?? 0 };`);
  check(hostView?.slots.length === 2 && hostView.slots.every((s) => s.state === 'joined' && s.via === 'room'), 'ホストの枠は joined (via room)', JSON.stringify(hostView?.slots));
  check(hostView?.players === 3, 'ロビーは 3 人 (ホスト + 2)', `${hostView?.players} 人`);

  const kickedSlot = results[0]?.slot;
  const kicked = await hostTab.run(`return lobby.kick(${kickedSlot});`);
  const guestAfter = await guestTabs[0].run(`
    const waitFor = async (pred, ms) => { const end = performance.now() + ms; while (!pred()) { if (performance.now() > end) return false; await new Promise((r) => setTimeout(r, 50)); } return true; };
    await waitFor(() => session.state === 'closed', 5000);
    return session.state;`);
  const hostAfter = await hostTab.run(`
    await new Promise((r) => setTimeout(r, 500));
    return { slot: lobby.slot(${kickedSlot})?.state, players: lobby.status?.players.length ?? 0 };`);
  check(kicked === true && guestAfter === 'closed' && hostAfter?.slot === 'empty' && hostAfter.players === 2, 'kick: 外した参加者は切断され、枠は空きに戻る',
    `参加者 ${guestAfter}、枠 ${hostAfter?.slot}、${hostAfter?.players} 人`);
  const other = await guestTabs[1].run('return session.state;');
  check(other === 'lobby', 'kick したのとは別の参加者はロビーに残る');

  console.log('\n== 失敗と返答コード方式への切り替え ==');
  const noRoom = await guestTabs[0].run(`${imports}
    const c = GuestRoomConnector.join({ roomId: 'AAAAAAAAAAAAAAAAAAAAAA', key: 'AAAAAAAAAAAAAAAAAAAAAA' });
    const f = await new Promise((resolve) => { c.onOpen = () => resolve('open'); c.onFail = resolve; });
    return { f, fallback: shouldFallbackToCode(f) };`);
  check(noRoom?.f === 'noRoom' && noRoom.fallback === true, '部屋がない → noRoom (返答コード方式に切り替える)');
  const noRelay = await guestTabs[0].run(`${imports}
    const t0 = performance.now();
    const c = GuestRoomConnector.join(parseRoomLink(${JSON.stringify(link)}), { url: 'ws://127.0.0.1:9' });
    const f = await new Promise((resolve) => { c.onOpen = () => resolve('open'); c.onFail = resolve; });
    return { f, fallback: shouldFallbackToCode(f), ms: Math.round(performance.now() - t0) };`);
  check(noRelay?.f === 'relayUnavailable' && noRelay.fallback === true, '中継につながらない → relayUnavailable (切り替える)', `${noRelay?.ms} ms`);
  const hostNoRelay = await hostTab.run(`${imports}
    const l2 = HostLobby.create({ name: 'HOST', team: 1 }, getCourseTrack());
    l2.openRoom(location.origin + location.pathname, { url: 'ws://127.0.0.1:9' });
    await waitFor(() => l2.room && l2.room.state !== 'connecting', 8000);
    const room = l2.room;
    const invite = await l2.issueInvite();
    l2.close();
    return { room, invite: invite?.state };`);
  check(hostNoRelay?.room?.state === 'unavailable' && hostNoRelay.room.failure === 'relayUnavailable' && hostNoRelay.invite === 'inviting',
    'ホスト: 中継がない → unavailable、従来の招待 (issueInvite) はそのまま使える');
  const closed = await hostTab.run(`${imports}
    lobby.closeRoom();
    const c = GuestRoomConnector.join(parseRoomLink(${JSON.stringify(link)}));
    const f = await new Promise((resolve) => { c.onOpen = () => resolve('open'); c.onFail = resolve; });
    const state = lobby.room;
    lobby.close();
    return { f, state };`);
  check(closed?.f === 'noRoom' && closed.state === null, 'closeRoom のあとはリンクで入れない (noRoom)');
  hostTab.close();
  for (const t of guestTabs) t.close();
} catch (e) {
  console.log(e);
  failures++;
} finally {
  stopAll();
  await sleep(500);
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    // Chrome がまだファイルを持っている
  }
}

console.log(failures === 0 ? '\nすべての確認が OK' : `\nNG が ${failures} 件`);
process.exitCode = failures === 0 ? 0 : 1;
