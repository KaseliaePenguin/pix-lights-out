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
export { carParams, raceRules, specCarParamValues } from './src/shared/carParams';
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

// ---------------------------------------------------------------- パラメータの組
// user = 初期値 (ユーザーが選んだ値を含む)、spec = car-physics.md 第 4 版の仕様の値
const paramSets = {
  user: structuredClone(m.carParams),
  spec: { ...structuredClone(m.carParams), ...m.specCarParamValues },
};
const withGrip = (params, grip) => ({ ...params, compoundGrip: { soft: grip, hard: grip } });

// ---------------------------------------------------------------- 車の基本性能 (car-physics.md 5.5・10 節)
console.log('\n== 車の基本性能 (グリップ 1.0 の直線) ==');
const flat = { surfaceAt: () => 'asphalt', wallContact: (x, y, out) => { out.depth = -50; out.normalX = 0; out.normalY = 0; return out; } };
for (const [name, params] of Object.entries(paramSets)) {
  const p = withGrip(params, 1.0);
  const car = new m.Car(flat, p);
  car.placeAt({ x: 0, y: 0, heading: 0 });
  const c = m.createControls();
  c.throttle = 1;
  let t = 0;
  while (car.sF < 500 && t < 10) { car.update(c, dt); t += dt; }
  const parts = [`0→500: ${t.toFixed(2)} 秒・${(-car.y).toFixed(0)} px`];
  for (const target of [400, 300, 200]) {
    car.placeAt({ x: 0, y: 0, heading: 0 });
    car.sF = 525;
    c.throttle = 0; c.brake = 1;
    let bt = 0;
    while (car.sF > target) { car.update(c, dt); bt += dt; }
    parts.push(`525→${target}: ${bt.toFixed(2)} 秒・${(-car.y).toFixed(0)} px`);
  }
  console.log(`  ${name}: ${parts.join(' / ')}`);
}
console.log('  (仕様の目安: 0→500 約 1.95 秒・655 px / 525→400 0.17 秒・77 px / →300 0.30 秒・124 px / →200 0.44 秒・160 px)');

// ---------------------------------------------------------------- レーシングライン
console.log('\n== レーシングライン (速度プロファイルからの理想ラップ。基準グリップ 1.00、DRS なし) ==');
t0 = performance.now();
const lines = {};
for (const [name, params] of Object.entries(paramSets)) {
  lines[name] = {
    gripSoft: new m.RacingLine(track, { tyreGrip: 1.08, params }),
    gripBase: new m.RacingLine(track, { tyreGrip: 1.0, useDrs: false, params }),
  };
}
console.log(`  生成 ${((performance.now() - t0) / 4).toFixed(0)} ms/本`);
for (const [name, l] of Object.entries(lines)) {
  const parts = track.corners.map((cn) => {
    let v = Infinity;
    for (let k = 0; k < l.gripBase.count; k++) {
      const s = l.gripBase.trackS[k];
      if (s >= cn.s0 - 20 && s <= cn.s1 + 20) v = Math.min(v, l.gripBase.speeds[k]);
    }
    return `${cn.id} ${v.toFixed(0)}`;
  });
  console.log(`  ${name}: 理想ラップ ${fmt(l.gripBase.estimatedLapTime)} / コーナーの最低速度 (px/秒): ${parts.join(' / ')}`);
}

// ---------------------------------------------------------------- AI でタイムアタック
/**
 * コーナーの調べる範囲: ブレーキを含むよう円弧の 700 px 手前から、円弧の 100 px 先まで。
 * 区間タイムは円弧の前後 250 px
 */
const cornerWindows = track.corners.map((c) => ({ id: c.id, deg: Math.round((Math.abs(c.angle) * 180) / Math.PI), radius: c.radius, s0: c.s0, s1: c.s1 }));

function runAttack(label, line, aiOptions, params) {
  const session = new m.TimeAttackSession(track, null, params);
  const ai = new m.LineFollowerAi(line, aiOptions);
  const c = m.createControls();
  const laps = [];
  const events = { missed: 0, invalid: 0, wrongWay: 0, wallHits: 0, spins: 0 };
  let maxDepth = 0;
  let maxExcess = 0;
  let maxExcessAt = '';
  let offWorldFrames = 0;
  let ghostRecord = null;
  const car = session.car;
  const probe = { depth: 0, normalX: 0, normalY: 0 };
  const pt = { x: 0, y: 0 };
  const outline = [[-9, 19], [9, 19], [-9, -19], [9, -19], [-9, 0], [9, 0]];
  const maxTime = 70 * (timedLaps + 2);
  /** 2 周目のコーナーごとの測定 */
  const stats = {};
  for (const w of cornerWindows) stats[w.id] = { entry: NaN, brakeTime: 0, brakeDist: 0, minSpeed: Infinity, maxU: 0, arcFrames: 0, lockedFrames: 0, tA: NaN, tB: NaN };
  let t = 0;
  let prevS = session.lap.projection.s;
  while (t < maxTime && laps.length < timedLaps) {
    ai.update(car, c);
    const evs = session.step(c, dt);
    t += dt;
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
    if (session.lap.lap === 2) {
      const moved = track.deltaS(prevS, pr.s);
      for (const w of cornerWindows) {
        const st = stats[w.id];
        const rel = track.deltaS(w.s0, pr.s);
        const arcLen = w.s1 - w.s0;
        if (rel >= -700 && rel <= arcLen + 100) {
          if (c.brake > 0) {
            if (Number.isNaN(st.entry)) st.entry = car.speed;
            st.brakeTime += dt;
            st.brakeDist += Math.max(0, moved);
          }
        }
        if (rel >= 0 && rel <= arcLen) {
          st.minSpeed = Math.min(st.minSpeed, car.speed);
          st.maxU = Math.max(st.maxU, car.uReq);
          st.arcFrames++;
          // フルステアで、旋回速度の上限 (yawMaxLow) がグリップの限界より先に効いている = 曲がり方が旋回の上限に縛られている
          const v = Math.abs(car.sF);
          const yawCap = car.params.yawMaxLow * Math.min(1, v / car.params.yawRampSpeed);
          const gripCap = v > 0 ? (car.params.latGrip * car.params.steerDemand) / v : Infinity;
          if (Math.abs(car.steer) >= 0.98 && yawCap < gripCap) st.lockedFrames++;
        }
        if (moved > 0 && moved < 60) {
          if (track.deltaS(prevS, w.s0 - 250) > 0 && track.deltaS(w.s0 - 250, pr.s) >= 0) st.tA = t;
          if (track.deltaS(prevS, w.s1 + 250) > 0 && track.deltaS(w.s1 + 250, pr.s) >= 0) st.tB = t;
        }
      }
    }
    prevS = pr.s;
    for (const e of evs) {
      if (e.type === 'lapCompleted') laps.push(e);
      if (e.type === 'checkpointMissed') events.missed++;
      if (e.type === 'lapInvalidated') events.invalid++;
      if (e.type === 'wrongWayStarted') events.wrongWay++;
      if (e.type === 'recordUpdated') ghostRecord = e.record;
    }
  }
  const best = laps.length ? Math.min(...laps.map((e) => e.time)) : NaN;
  console.log(`\n== ${label} ==`);
  laps.forEach((e) => console.log(`  周 ${e.lap}: ${fmt(e.time)}  (S1 ${e.sectors[0].toFixed(2)} / S2 ${e.sectors[1].toFixed(2)} / S3 ${e.sectors[2].toFixed(2)})${e.valid ? '' : ' 無効'}`));
  console.log(`  壁 ${events.wallHits} 回 / スピン ${events.spins} 回 / はみ出し最大 ${maxExcess.toFixed(0)} px (${maxExcessAt})`);
  check(laps.length === timedLaps, `${label}: ${timedLaps} 周を計測`);
  check(events.missed === 0 && events.invalid === 0 && events.wrongWay === 0, `${label}: 未通過・無効周・逆走なし`, `未通過 ${events.missed}、無効 ${events.invalid}、逆走 ${events.wrongWay}`);
  check(maxDepth < 2 && offWorldFrames === 0, `${label}: 壁を突き抜けない`, `最大めり込み ${maxDepth.toFixed(2)} px、壁の中 ${offWorldFrames} フレーム`);
  return { laps, best, ghostRecord, stats };
}

/** コーナーごとの一覧 (「ブレーキで減速して曲がる」が自然か、「我慢」になっていないかを見る材料) */
function printCornerTable(title, stats) {
  console.log(`\n  -- ${title}: コーナーごと (2 周目) --`);
  console.log('  コーナー      角度/半径  進入速度→最低速度  ブレーキ 時間/距離  限界の使用 uReq 最大 (余裕)  フルステアで旋回の上限に縛られた割合  区間タイム');
  for (const w of cornerWindows) {
    const st = stats[w.id];
    const entry = Number.isNaN(st.entry) ? '(ブレーキなし)' : `${st.entry.toFixed(0)}`;
    const brake = st.brakeTime > 0 ? `${st.brakeTime.toFixed(2)} 秒/${st.brakeDist.toFixed(0)} px` : '-';
    const locked = st.arcFrames ? `${Math.round((st.lockedFrames / st.arcFrames) * 100)}%` : '-';
    const section = Number.isFinite(st.tB - st.tA) ? `${(st.tB - st.tA).toFixed(2)} 秒` : '-';
    console.log(`  ${w.id.padEnd(4)} ${String(w.deg).padStart(4)}°/${String(Math.round(w.radius)).padStart(3)}  ${entry.padStart(6)} → ${st.minSpeed.toFixed(0).padStart(3)}  ${brake.padStart(15)}  ${st.maxU.toFixed(2)} (${(1 - st.maxU).toFixed(2)})  ${locked.padStart(5)}  ${section}`);
  }
}

const results = {};
for (const [name, params] of Object.entries(paramSets)) {
  const l = lines[name];
  results[name] = {
    analog: runAttack(`${name}: grip (アナログ、ソフト)`, l.gripSoft, {}, params),
    key: runAttack(`${name}: grip (キーボード相当)`, l.gripSoft, { digital: true }, params),
  };
}
const soft = results.user.analog;

console.log('\n== コーナーの走り方 (ブレーキで減速して曲がるのが自然か) ==');
for (const [name, r] of Object.entries(results)) {
  console.log(`  ${name}: ラップ アナログ ${fmt(r.analog.best)} / キーボード相当 ${fmt(r.key.best)}`);
}
printCornerTable('user (ユーザーの値)・アナログ', results.user.analog.stats);
printCornerTable('user (ユーザーの値)・キーボード相当', results.user.key.stats);
printCornerTable('spec (仕様の値)・アナログ', results.spec.analog.stats);

// ---------------------------------------------------------------- コースの重なり・近道 (game-design.md 11.2 節)
console.log('\n== コースの重なり・近道 ==');
{
  // 中心線上で 700 px 以上離れた 2 点の距離が 224 px (コース幅の半分 + 芝生 60 + 壁 24 + 芝生 60 + コース幅の半分) 以上か
  let minD = Infinity;
  let minAt = '';
  const step = 4;
  for (let i = 0; i < track.sampleCount; i += step) {
    for (let j = i + step; j < track.sampleCount; j += step) {
      let ds = (j - i) * track.sampleSpacing;
      ds = Math.min(ds, track.length - ds);
      if (ds < 700) continue;
      const d = Math.hypot(track.xs[i] - track.xs[j], track.ys[i] - track.ys[j]);
      if (d < minD) { minD = d; minAt = `s=${(i * track.sampleSpacing).toFixed(0)} と s=${(j * track.sampleSpacing).toFixed(0)}`; }
    }
  }
  check(minD >= 224, '中心線上で 700 px 以上離れた部分どうしが 224 px 以上離れている', `最小 ${minD.toFixed(0)} px (${minAt})`);

  // チェックポイントを 1 つも飛ばさずに近道できる直線の経路 (車幅の 3 本の線が壁に当たらない) を探す。
  // 得かどうかは時間で比べる: 経路は路面ごとの速さの上限 (アスファルト 525、芝生・砂利は car-physics.md 10 節の上限) で走ったとき、
  // コースは grip のレーシングラインの目標速度で走ったとき
  const L = track.length;
  const refLine = lines.user.gripSoft;
  const lineTimeAt = new Float64Array(refLine.count + 1);
  for (let k = 0; k < refLine.count; k++) {
    const j = (k + 1) % refLine.count;
    const seg = Math.hypot(refLine.xs[j] - refLine.xs[k], refLine.ys[j] - refLine.ys[k]);
    lineTimeAt[k + 1] = lineTimeAt[k] + seg / Math.max(1, (refLine.speeds[k] + refLine.speeds[j]) / 2);
  }
  const lineIndexAt = (s) => Math.min(refLine.count - 1, Math.round((((s % L) + L) % L) / refLine.spacing));
  const trackTime = (sa, sb) => {
    const a = lineIndexAt(sa), b = lineIndexAt(sb);
    return b >= a ? lineTimeAt[b] - lineTimeAt[a] : lineTimeAt[refLine.count] - lineTimeAt[a] + lineTimeAt[b];
  };
  const capOf = (code) => (code === m.SurfaceCode.grass ? m.carParams.surfaces.grass.speedCap : code === m.SurfaceCode.gravel ? m.carParams.surfaces.gravel.speedCap : m.carParams.vBase);
  const pathTime = (ax, ay, bx, by) => {
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.ceil(d / 4);
    let time = 0;
    for (let k = 0; k < n; k++) time += d / n / capOf(track.surfaceCodeAt(ax + ((bx - ax) * (k + 0.5)) / n, ay + ((by - ay) * (k + 0.5)) / n));
    return time;
  };
  const gates = track.checkpoints;
  const lineFree = (ax, ay, bx, by) => {
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.ceil(d / 2);
    for (let k = 0; k <= n; k++) if (track.surfaceCodeAt(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n) === m.SurfaceCode.wall) return false;
    return true;
  };
  const cross = (ax, ay, bx, by, g) => {
    const rx = bx - ax, ry = by - ay, sx = g.bx - g.ax, sy = g.by - g.ay;
    const den = rx * sy - ry * sx;
    if (den === 0) return false;
    const qx = g.ax - ax, qy = g.ay - ay;
    const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  let found = 0;
  let small = 0;
  let worst = '';
  let worstSaving = 0;
  /** これ以上速くなる近道は不合格 (「大きく近道できる」場所)。それ未満は警告として表示する */
  const largeGain = 0.2;
  for (let si = 0; si < L; si += 16) {
    for (const la of [-30, 0, 30]) {
      const a = track.poseAt(si, la);
      for (const lb of [-30, 0, 30]) {
        for (let d = 200; d <= 3000; d += 24) {
          const b = track.poseAt(si + d, lb);
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          const saving = d - dist;
          if (saving < 150) continue;
          const nx = (-(b.y - a.y) / dist) * 9, ny = ((b.x - a.x) / dist) * 9;
          if (!lineFree(a.x, a.y, b.x, b.y) || !lineFree(a.x + nx, a.y + ny, b.x + nx, b.y + ny) || !lineFree(a.x - nx, a.y - ny, b.x - nx, b.y - ny)) continue;
          let skipped = 0;
          for (const g of gates) {
            const rel = (((g.s - si) % L) + L) % L;
            if (rel <= 0 || rel >= d) continue;
            if (!cross(a.x, a.y, b.x, b.y, g)) skipped++;
          }
          if (skipped > 0) continue;
          const gain = trackTime(si, si + d) - pathTime(a.x, a.y, b.x, b.y);
          if (gain > 0.05) {
            if (gain >= largeGain) found++;
            else small++;
            if (gain > worstSaving) { worstSaving = gain; worst = `s=${si.toFixed(0)} → ${(si + d).toFixed(0)}、${saving.toFixed(0)} px 短い`; }
          }
        }
      }
    }
  }
  check(found === 0, `チェックポイントを飛ばさずに 150 px 以上短く、${largeGain} 秒以上速くなる経路がない`, `見積もりで最大 ${worstSaving.toFixed(2)} 秒 (${worst || 'なし'})`);
  if (small > 0) console.log(`  [注意] 0.05〜${largeGain} 秒速くなる可能性のある経路 ${small} 件 (路面の速さの上限ですぐ走れるとした見積もりの上限値)`);
}

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
console.log('\n== コース外 (car-physics.md 10 節) ==');
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
console.log('  (第 4 版の目安: 芝生 → 260 はアクセルを離して約 0.5 秒・踏んだまま約 1.2 秒、砂利 → 180 は約 0.6 秒・約 0.9 秒)');


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
