// ヘッドレスのシミュレーション: src/shared/ の物理とコース判定を node で動かして確かめる。
//   node scripts/sim-lap.mjs            (全部)
//   node scripts/sim-lap.mjs --laps 5   (AI の計測周回数)
// src/shared/ の TypeScript を esbuild (vite に同梱) でまとめてから読み込む。ゲーム本体では使わない。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argLaps = process.argv.indexOf('--laps');
const timedLaps = argLaps > 0 ? Number(process.argv[argLaps + 1]) : 3;

const entry = `
export { Track, SurfaceCode } from './src/shared/Track';
export { course1 } from './src/shared/tracks/course1';
export { Car } from './src/shared/Car';
export { carParams, raceRules } from './src/shared/carParams';
export { createControls } from './src/shared/controls';
export { RacingLine } from './src/shared/RacingLine';
export { LineFollowerAi } from './src/shared/LineFollowerAi';
export { TimeAttackSession } from './src/shared/TimeAttackSession';
export { GhostPlayer, GhostRecorder } from './src/shared/ghost';
export { VirtualGearbox } from './src/shared/VirtualGearbox';
`;
const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
});
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const dt = m.raceRules.step;
const fmt = (t) => (t == null || !Number.isFinite(t) ? '-' : `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`);
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  [${ok ? 'OK' : 'NG'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- コース
console.log('== コース 1 ==');
let t0 = performance.now();
const track = new m.Track(m.course1);
console.log(`  生成 ${(performance.now() - t0).toFixed(0)} ms / 1 周 ${track.length.toFixed(0)} px / ワールド ${track.worldWidth}×${track.worldHeight} px`);
console.log(`  チェックポイント ${track.checkpoints.length} 個 (区間境界 ${track.sectorCheckpoints.join(', ')}) / タイミングライン ${track.timingLines.length} 本 / ピットレーン ${track.pitLength.toFixed(0)} px`);
console.log(`  DRS 区間 ${(track.drsEndS - track.drsStartS).toFixed(0)} px / 閉じる誤差 ${track.closureError.toFixed(1)} px`);
check(track.checkpoints.length >= 20 && track.checkpoints.length <= 26, 'チェックポイント数 20〜26 (7.4 節)');
const drivableAt = (p) => track.surfaceCodeAt(p.x, p.y) !== m.SurfaceCode.wall;
check(track.gridSlots.every(drivableAt) && drivableAt(track.soloStart), 'グリッド・開始位置が路面上');

// ---------------------------------------------------------------- 車の基本性能 (car-physics.md 5.5 節)
console.log('\n== 車の基本性能 (グリップ 1.0 の路面を想定した直線) ==');
const flat = { surfaceAt: () => 'asphalt', wallContact: (x, y, out) => { out.depth = -50; out.normalX = 0; out.normalY = 0; return out; } };
const hardParams = { ...m.carParams, compoundGrip: { soft: 1.0, hard: 1.0 } };
{
  const car = new m.Car(flat, hardParams);
  car.placeAt({ x: 0, y: 0, heading: 0 });
  const c = m.createControls();
  c.throttle = 1;
  let t = 0;
  while (car.sF < 500 && t < 10) { car.update(c, dt); t += dt; }
  console.log(`  0→500 px/秒: ${t.toFixed(2)} 秒、${(-car.y).toFixed(0)} px (目安 2.2 秒 / 約 730 px)`);
  for (const target of [200, 288, 375]) {
    car.placeAt({ x: 0, y: 0, heading: 0 });
    car.sF = 525;
    c.throttle = 0; c.brake = 1;
    let bt = 0;
    while (car.sF > target) { car.update(c, dt); bt += dt; }
    console.log(`  525→${target} のブレーキ: ${(-car.y).toFixed(0)} px、${bt.toFixed(2)} 秒`);
  }
}

// ---------------------------------------------------------------- レーシングライン
console.log('\n== レーシングライン (速度プロファイルからの理想ラップ) ==');
t0 = performance.now();
const lineSoft = new m.RacingLine(track, { tyreGrip: 1.08 });
const lineBase = new m.RacingLine(track, { tyreGrip: 1.0 });
const lineBaseNoDrs = new m.RacingLine(track, { tyreGrip: 1.0, useDrs: false });
console.log(`  生成 ${((performance.now() - t0) / 3).toFixed(0)} ms/本`);
console.log(`  基準 1.00: ${fmt(lineBase.estimatedLapTime)} (DRS なし ${fmt(lineBaseNoDrs.estimatedLapTime)}) / ソフト新品 1.08: ${fmt(lineSoft.estimatedLapTime)}  (仕様の目安: 基準 40.2 秒・ソフト 39.6 秒)`);
{
  // コーナーごとの最低速度
  const seg = m.course1.segments.filter((s) => s.kind === 'turn');
  const parts = [];
  for (const s of seg) {
    const a = track.resolveRef({ seg: s.id, t: 0 });
    const b = track.resolveRef({ seg: s.id, t: 1 });
    let vmin = Infinity;
    for (let k = 0; k < lineBase.count; k++) {
      const ts = lineBase.trackS[k];
      if (ts >= a - 20 && ts <= b + 20) vmin = Math.min(vmin, lineBase.speeds[k]);
    }
    parts.push(`${s.id} ${vmin.toFixed(0)}`);
  }
  console.log(`  コーナーの最低速度 (基準, px/秒): ${parts.join(' / ')}`);
}

// ---------------------------------------------------------------- AI でタイムアタック
function runAttack(label, line, aiOptions, params) {
  const session = new m.TimeAttackSession(track, null, params);
  const ai = new m.LineFollowerAi(line, aiOptions);
  const c = m.createControls();
  const laps = [];
  const sectors = [];
  const events = { missed: 0, invalid: 0, wrongWay: 0, wallHits: 0, spins: 0 };
  let maxDepth = 0;
  let maxExcess = 0;
  let maxExcessAt = '';
  let offWorldFrames = 0;
  let distance = 0;
  let ghostRecord = null;
  const car = session.car;
  const probe = { depth: 0, normalX: 0, normalY: 0 };
  const pt = { x: 0, y: 0 };
  const outline = [[-9, 19], [9, 19], [-9, -19], [9, -19], [-9, 0], [9, 0]];
  const maxTime = 60 * (timedLaps + 2);
  let t = 0;
  let maxSpeed = 0;
  let squealFrames = 0;
  let skidFrames = 0;
  let frames = 0;
  while (t < maxTime && laps.length < timedLaps) {
    ai.update(car, c);
    const evs = session.step(c, dt);
    t += dt;
    frames++;
    distance += Math.hypot(car.x - car.prevX, car.y - car.prevY);
    maxSpeed = Math.max(maxSpeed, car.speed);
    if (car.squealVolume > 0) squealFrames++;
    if (car.skidRear) skidFrames++;
    if (car.wallImpact > 0) events.wallHits++;
    if (car.spinStarted) events.spins++;
    for (const k of outline) {
      car.localToWorld(k[0], k[1], pt);
      track.wallContact(pt.x, pt.y, probe);
      maxDepth = Math.max(maxDepth, probe.depth);
    }
    if (track.surfaceCodeAt(car.x, car.y) === m.SurfaceCode.wall) offWorldFrames++;
    const pr = session.lap.projection;
    const excess = Math.abs(pr.lateral) - track.widthAt(pr.s) / 2;
    if (excess > maxExcess) { maxExcess = excess; maxExcessAt = `s=${pr.s.toFixed(0)}`; }
    for (const e of evs) {
      if (e.type === 'lapCompleted') { laps.push(e); sectors.push(e.sectors); }
      if (e.type === 'checkpointMissed') events.missed++;
      if (e.type === 'lapInvalidated') events.invalid++;
      if (e.type === 'wrongWayStarted') events.wrongWay++;
      if (e.type === 'recordUpdated') ghostRecord = e.record;
    }
  }
  console.log(`\n== ${label} ==`);
  laps.forEach((e, i) => console.log(`  周 ${e.lap}: ${fmt(e.time)}  (S1 ${e.sectors[0].toFixed(2)} / S2 ${e.sectors[1].toFixed(2)} / S3 ${e.sectors[2].toFixed(2)})${e.valid ? '' : ' 無効'}${i === 0 ? '' : ''}`));
  console.log(`  最高速 ${maxSpeed.toFixed(0)} px/秒 / スキール音 ${(squealFrames / frames * 100).toFixed(1)}% / タイヤ痕 ${(skidFrames / frames * 100).toFixed(1)}% / 壁 ${events.wallHits} 回 / スピン ${events.spins} 回`);
  check(laps.length === timedLaps, `${timedLaps} 周を計測`, `走行距離 ${(distance / 1000).toFixed(1)} k px (中心線 1 周 ${track.length.toFixed(0)} px、アウトラップ約 ${m.raceRules.soloStartDistance} px)`);
  console.log(`  コース端からのはみ出し最大 ${maxExcess.toFixed(0)} px (${maxExcessAt})`);
  check(events.missed === 0 && events.invalid === 0, 'チェックポイント未通過・無効周なし', `未通過 ${events.missed}、無効 ${events.invalid}`);
  check(events.wrongWay === 0, '逆走警告なし');
  check(maxDepth < 2 && offWorldFrames === 0, '壁を突き抜けない', `最大めり込み ${maxDepth.toFixed(2)} px、壁の中にいたフレーム ${offWorldFrames}`);
  return { laps, ghostRecord };
}

const soft = runAttack('AI (アナログ操作、ソフト 1.08、DRS 使用)', lineSoft, {});
const baseParams = { ...m.carParams, compoundGrip: { soft: 1.0, hard: 1.0 } };
runAttack('AI (アナログ操作、基準グリップ 1.00、DRS 使用)', lineBase, {}, baseParams);
runAttack('AI (キーボード相当の 0/1 入力、ソフト 1.08)', lineSoft, { digital: true });

// ---------------------------------------------------------------- ゴースト
console.log('\n== ゴースト ==');
if (soft.ghostRecord && soft.ghostRecord.ghost) {
  const g = soft.ghostRecord.ghost;
  const json = JSON.stringify(g);
  const player = new m.GhostPlayer(JSON.parse(json));
  const pose = { x: 0, y: 0, heading: 0 };
  const okStart = player.sample(0, pose);
  const okEnd = player.sample(g.lapTime - 0.02, pose);
  console.log(`  自己ベスト ${fmt(g.lapTime)} / フレーム ${g.frameCount} / JSON ${(json.length / 1024).toFixed(1)} KB / 物理バージョン ${g.physicsVersion}`);
  check(okStart && okEnd && Math.abs(g.frameCount - g.lapTime * 30) < 2, '30 回/秒 で 1 周分を記録・再生できる', `始点 ${okStart} / 終点 ${okEnd}`);
  // 再生位置が走行できる場所 (壁の外ではない) にあるか
  let inWall = 0;
  for (let t = 0; t < g.lapTime; t += 0.05) {
    player.sample(t, pose);
    if (track.surfaceCodeAt(pose.x, pose.y) === m.SurfaceCode.wall) inWall++;
  }
  check(inWall === 0, '再生位置が壁の中に入らない');
} else {
  check(false, 'ゴーストが記録された');
}

// ---------------------------------------------------------------- 逆走とコース復帰
console.log('\n== 逆走とコース復帰 ==');
{
  const session = new m.TimeAttackSession(track);
  const c = m.createControls();
  // カウントダウン
  for (let i = 0; i < 3.1 / dt; i++) session.step(c, dt);
  // 逆向きに置いて走らせる
  const start = track.poseAt(track.length - 875 + 300, 0);
  session.car.placeAt({ x: start.x, y: start.y, heading: start.heading + Math.PI });
  session.lap.projection.index = -1;
  c.throttle = 1;
  let wrongAt = -1;
  let t = 0;
  for (let i = 0; i < 180 && wrongAt < 0; i++) {
    const evs = session.step(c, dt);
    t += dt;
    if (evs.some((e) => e.type === 'wrongWayStarted')) wrongAt = t;
  }
  check(wrongAt > 0.9 && wrongAt < 1.4, 'WRONG WAY が約 1 秒後に出る', `${wrongAt.toFixed(2)} 秒`);
  check(session.isResetAvailable, '逆走中はコース復帰が使える');
  c.throttle = 0;
  c.resetPressed = true;
  let placed = false;
  let finished = false;
  let lockTime = 0;
  for (let i = 0; i < 180; i++) {
    const evs = session.step(c, dt);
    c.resetPressed = false;
    if (evs.some((e) => e.type === 'resetPlaced')) placed = true;
    if (placed && !finished) lockTime += dt;
    if (evs.some((e) => e.type === 'resetFinished')) finished = true;
  }
  const proj = session.lap.projection;
  const headingDiff = Math.abs(Math.atan2(Math.sin(session.car.heading - proj.heading), Math.cos(session.car.heading - proj.heading)));
  check(placed && finished, 'コース復帰が完了する', `置き直し後の操作不能 ${lockTime.toFixed(2)} 秒`);
  check(Math.abs(proj.lateral) < 1 && headingDiff < 0.01 && session.car.speed === 0, '中心線上・進行方向・速度 0 に置かれる');
  check(!session.lap.isWrongWay, '逆走警告が消える');
  // 条件を満たさないときは拒否
  c.throttle = 1;
  for (let i = 0; i < 60; i++) session.step(c, dt);
  c.resetPressed = true;
  const evs = session.step(c, dt);
  check(evs.some((e) => e.type === 'resetRejected'), '条件を満たさないと resetRejected');
}

// ---------------------------------------------------------------- 壁への衝突
console.log('\n== 壁への衝突 ==');
{
  const probe = { depth: 0, normalX: 0, normalY: 0 };
  const pt = { x: 0, y: 0 };
  let worst = 0;
  let escaped = 0;
  let spins = 0;
  const c = m.createControls();
  c.throttle = 1;
  const angles = [20, 45, 70, 90];
  for (let k = 0; k < 24; k++) {
    const s = (track.length / 24) * k + 100;
    for (const deg of angles) {
      for (const side of [1, -1]) {
        const car = new m.Car(track);
        const pose = track.poseAt(s, 0);
        car.placeAt({ x: pose.x, y: pose.y, heading: pose.heading + side * deg * Math.PI / 180 });
        car.sF = 520;
        for (let i = 0; i < 120; i++) {
          car.update(c, dt);
          if (car.spinStarted) spins++;
          for (const o of [[-9, 19], [9, 19], [-9, -19], [9, -19]]) {
            car.localToWorld(o[0], o[1], pt);
            track.wallContact(pt.x, pt.y, probe);
            worst = Math.max(worst, probe.depth);
          }
          if (track.surfaceCodeAt(car.x, car.y) === m.SurfaceCode.wall) { escaped++; break; }
        }
      }
    }
  }
  console.log(`  24 か所 × ${angles.length} 角度 × 左右 に 520 px/秒 で突っ込む: スピン ${spins} 回`);
  check(escaped === 0 && worst < 3, '壁を突き抜けない', `車の中心が壁の中に出た回数 ${escaped}、角の最大めり込み ${worst.toFixed(2)} px`);
}

// ---------------------------------------------------------------- 芝生・砂利
console.log('\n== コース外 (car-physics.md 7 節) ==');
for (const kind of ['grass', 'gravel']) {
  const parts = [];
  for (const throttle of [1, 0]) {
    const env = { surfaceAt: () => kind, wallContact: flat.wallContact };
    const car = new m.Car(env);
    car.placeAt({ x: 0, y: 0, heading: 0 });
    car.sF = 500;
    const c = m.createControls();
    c.throttle = throttle;
    const cap = m.carParams.surfaces[kind].speedCap;
    let t = 0;
    while (car.sF > cap + 0.5 && t < 5) { car.update(c, dt); t += dt; }
    parts.push(`アクセル${throttle ? 'ON' : 'OFF'} ${t.toFixed(2)} 秒・${(-car.y).toFixed(0)} px`);
  }
  console.log(`  ${kind}: 500 → ${m.carParams.surfaces[kind].speedCap} px/秒 まで ${parts.join(' / ')}`);
}
console.log('  (目安: 芝生 約 0.7 秒・約 250 px、砂利 約 0.5 秒)');


// ---------------------------------------------------------------- レビューの指摘の再発確認
console.log('\n== ピットレーン・DRS・未通過・復帰の禁止・ゴースト (不具合の再発確認) ==');
const readyTimeAttack = () => {
  const session = new m.TimeAttackSession(track);
  const c = m.createControls();
  for (let i = 0; i < 3.1 / dt; i++) session.step(c, dt);
  return { session, c };
};
{
  // 入口の手前でコースの右 (ランオフの芝生・ピットの路面の端) にはみ出して、そのまま戻る
  const g = track.pitEntryGate;
  const gp = track.project((g.ax + g.bx) / 2, (g.ay + g.by) / 2, -1);
  let falseEntries = 0;
  for (const lat of [40, 50, 60, 70]) {
    const { session, c } = readyTimeAttack();
    session.car.placeAt(track.poseAt(gp.s - 150, lat));
    session.lap.projection.index = -1;
    session.car.sF = 250;
    c.throttle = 1;
    for (let i = 0; i < 90; i++) if (session.step(c, dt).some((e) => e.type === 'pitEntry')) falseEntries++;
    if (session.lap.isInPitLane) falseEntries++;
  }
  check(falseEntries === 0, 'ピット入口の手前でランオフにはみ出しても pitEntry にならない');
}
{
  // ピットレーンの経路どおりに 225 px/秒 で通り抜ける
  const { session } = readyTimeAttack();
  const car = session.car;
  const types = [];
  const pose = { x: 0, y: 0, heading: 0 };
  track.pitPoseAt(0, pose);
  car.placeAt(pose);
  session.lap.projection.index = -1;
  for (let d = 0; d <= track.pitLength; d += 225 * dt) {
    track.pitPoseAt(d, pose);
    car.prevX = car.x; car.prevY = car.y;
    car.x = pose.x; car.y = pose.y; car.heading = pose.heading;
    for (const e of session.lap.update(car, dt)) types.push(e.type);
  }
  const entries = types.filter((t) => t === 'pitEntry').length;
  const exits = types.filter((t) => t === 'pitExit').length;
  check(entries === 1 && exits === 1 && !session.lap.isInPitLane, 'ピットレーンを通り抜けると pitEntry・pitExit が 1 回ずつ', `pitEntry ${entries} / pitExit ${exits}`);
}
{
  // DRS を開いたまま区間の終わりまで走ると drsClosed が出る
  const { session, c } = readyTimeAttack();
  session.car.placeAt(track.poseAt(track.drsStartS + 20, 0));
  session.lap.projection.index = -1;
  session.car.sF = 500;
  c.throttle = 1;
  let opened = false;
  let closed = false;
  for (let i = 0; i < 60 * 8; i++) {
    c.drsPressed = !opened;
    const evs = session.step(c, dt);
    if (evs.some((e) => e.type === 'drsOpened')) opened = true;
    if (evs.some((e) => e.type === 'drsClosed')) { closed = true; break; }
  }
  check(opened && closed, 'DRS 区間の終わりで閉じたとき drsClosed が出る');
}
{
  // シケインのゲートはコース上で通り、S2 境界のゲートはランオフ (4 輪コース外) で通ってから止まり、コース復帰する。
  // 置き直し先がシケインのゲートより手前になるので、走り直すと 2 つ前のゲートを通る (指摘 4 の状況)
  const { session, c } = readyTimeAttack();
  const car = session.car;
  const lap = session.lap;
  const chicane = track.checkpoints[track.sectorCheckpoints[1] - 1].s;
  const border = track.checkpoints[track.sectorCheckpoints[1]].s;
  const move = (sFrom, sTo, lateral, offTrack) => {
    const pose = { x: 0, y: 0, heading: 0 };
    for (let d = sFrom; d <= sTo; d += 4) {
      track.poseAt(d, lateral, pose);
      car.prevX = car.x; car.prevY = car.y;
      car.x = pose.x; car.y = pose.y; car.heading = pose.heading;
      for (const e of lap.update(car, dt)) types.push(e.type);
      if (offTrack) car.wheelsOffTrack = 4;
    }
  };
  const types = [];
  car.placeAt(track.poseAt(chicane - 300, 0));
  lap.resetForStart(car);
  move(chicane - 300, chicane + 20, 0, false);
  const offLateral = track.widthAt(border) / 2 + 30;
  move(chicane + 24, border + 40, -offLateral, true);
  const nextAfter = lap.nextCheckpoint;
  // 止まって (低速 1 秒) R を押す
  c.throttle = 0;
  for (let k = 0; k < 70; k++) session.step(c, dt);
  c.resetPressed = true;
  let placed = false;
  for (let k = 0; k < 150; k++) {
    if (session.step(c, dt).some((e) => e.type === 'resetPlaced')) placed = true;
    c.resetPressed = false;
  }
  const s0 = lap.projection.s;
  types.length = 0;
  move(s0, border + 300, 0, false);
  const missed = types.filter((t) => t === 'checkpointMissed').length;
  check(placed && s0 < chicane && nextAfter === track.sectorCheckpoints[1] + 1 && missed === 0,
    'コース復帰で 2 つ前のゲートより手前に置かれても MISSED CHECKPOINT が出ない',
    `置き直し先はシケインのゲートの ${(chicane - s0).toFixed(0)} px 手前、未通過 ${missed}`);
}
{
  // 復帰後 3 秒は復帰できない。低速の条件は禁止期間が終わってから数える
  const { session, c } = readyTimeAttack();
  const start = track.poseAt(track.length - 875 + 300, 0);
  session.car.placeAt({ x: start.x, y: start.y, heading: start.heading + Math.PI });
  session.lap.projection.index = -1;
  c.throttle = 1;
  for (let i = 0; i < 120 && !session.lap.isWrongWay; i++) session.step(c, dt);
  c.throttle = 0;
  c.resetPressed = true;
  let finishedAt = -1;
  let t = 0;
  let rejectedInLock = false;
  let availableAt = -1;
  for (let i = 0; i < 60 * 8; i++) {
    const evs = session.step(c, dt);
    c.resetPressed = false;
    t += dt;
    if (evs.some((e) => e.type === 'resetFinished')) finishedAt = t;
    if (finishedAt >= 0 && t - finishedAt > 1 && t - finishedAt < 1.1) {
      c.resetPressed = true;
      const r = session.step(c, dt);
      c.resetPressed = false;
      t += dt;
      if (r.some((e) => e.type === 'resetRejected')) rejectedInLock = true;
    }
    if (finishedAt >= 0 && availableAt < 0 && session.isResetAvailable) availableAt = t - finishedAt;
  }
  check(rejectedInLock, '復帰後 3 秒の間に R を押すと resetRejected');
  check(availableAt > 3.9 && availableAt < 4.2, '止まったままなら、禁止期間 3 秒 + 低速 1 秒 で復帰できるようになる', `${availableAt.toFixed(2)} 秒`);
}
{
  // フレームが 1 つだけのゴースト
  const rec = new m.GhostRecorder();
  rec.start(0, dt, 100, 100, 0);
  rec.record(0.001, 100, 100, 0);
  const data = rec.finish(track.id, track.version, 0.02, [], []);
  const player = new m.GhostPlayer(data);
  const pose = { x: 0, y: 0, heading: 0 };
  const ok = player.sample(0.01, pose);
  check(data.frameCount === 1 && ok && Number.isFinite(pose.x) && Number.isFinite(pose.heading), 'フレームが 1 つのゴーストでも NaN にならない');
}

// ---------------------------------------------------------------- 仮想ギア
{
  const gb = new m.VirtualGearbox();
  const seq = [];
  for (let v = 0; v <= 620; v += 5) { gb.update(v); if (gb.shiftedUp) seq.push(`${gb.gear}@${v}`); }
  console.log(`\n== 仮想ギア ==\n  シフトアップ: ${seq.join(' ')} / 525 px/秒 = ${Math.round(525 * 0.6)} km/h`);
}

console.log(failures === 0 ? '\nすべての確認が OK' : `\nNG が ${failures} 件`);
process.exitCode = failures === 0 ? 0 : 1;
