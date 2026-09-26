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
export { RaceSession } from './src/shared/RaceSession';
export { CpuDriver, createCpuSurroundings } from './src/shared/CpuDriver';
export { ContactSystem } from './src/shared/ContactSystem';
export { detectContact } from './src/shared/carContact';
export { Random } from './src/shared/Random';
export { cpuParams } from './src/shared/carParams';
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
// user = 初期値 (ユーザーが選んだ値を含む)、spec = 最初の案の値 (car-physics.md 第 5 版の表の括弧内、specCarParamValues)
const paramSets = {
  user: structuredClone(m.carParams),
  spec: { ...structuredClone(m.carParams), ...m.specCarParamValues },
};
const withGrip = (params, grip) => ({ ...params, compoundGrip: { soft: grip, hard: grip } });

// ---------------------------------------------------------------- 車の基本性能 (car-physics.md 5.5 節)
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
console.log('  (仕様 5.5 節の目安 user = 初期値 312.5: 0→500 約 1.95 秒・655 px / 525→400 約 0.30 秒・138 px / →300 約 0.56 秒・228 px / →200 約 0.83 秒・295 px)');
console.log('  (仕様 5.5 節の目安 spec = 最初の案 650: 0→500 同じ / 525→400 0.17 秒・77 px / →300 0.30 秒・124 px / →200 0.44 秒・160 px)');

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
  // 得かどうかは時間で比べる: 経路は路面ごとの速さの上限 (アスファルト 525、芝生・砂利は car-physics.md 8 節の上限) で走ったとき、
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

{
  // 薄い壁 (コースデータの minWallThickness) を DRS 込みの最高速・スピン中に直角でも突き抜けないか。
  // 厚さ T の壁を x = 0 を中心に置いた環境で、壁の向こう側 (x > 0) に車の中心が出たら突き抜け
  const T = track.data.minWallThickness;
  const slab = {
    surfaceAt: () => 'asphalt',
    wallContact: (x, y, out) => {
      out.depth = T / 2 - Math.abs(x);
      if (out.depth <= -2) { out.normalX = 0; out.normalY = 0; } else { out.normalX = x >= 0 ? 1 : -1; out.normalY = 0; }
      return out;
    },
  };
  const vTop = m.carParams.vBase * (1 + m.carParams.drsBonus);
  let through = 0;
  let cases = 0;
  const idle = m.createControls();
  const full = m.createControls();
  full.throttle = 1;
  const run = (speed, headingDeg, spinDir, offsetY) => {
    const car = new m.Car(slab);
    // 壁の手前 (x < 0) から +x 方向へ。heading 90° = 東向き
    car.placeAt({ x: -T / 2 - 30 + offsetY * 0.37, y: offsetY, heading: (headingDeg * Math.PI) / 180 });
    car.sF = speed;
    if (spinDir !== 0) car.startContactSpin(spinDir);
    cases++;
    for (let i = 0; i < 60; i++) {
      car.update(spinDir !== 0 ? idle : full, dt);
      if (car.x > 0 || !Number.isFinite(car.x)) { through++; return; }
    }
  };
  for (const speed of [525, vTop]) {
    for (const deg of [90, 70, 45]) {
      for (const off of [0, 3, 7]) {
        run(speed, deg, 0, off);
        for (const dir of [1, -1]) for (const h of [0, 30, 60, 90, 120, 150]) run(speed, deg + h, dir, off);
      }
    }
  }
  console.log(`\n== 薄い壁 (厚さ ${T} px) への衝突: ${vTop.toFixed(1)} px/秒 (1 フレーム ${(vTop * dt).toFixed(1)} px) まで、スピン中 (8 rad/秒) を含む ${cases} 通り ==`);
  check(through === 0, '最小の厚さの壁を直角・最高速・スピン中でも突き抜けない', `突き抜け ${through} 回`);
}
{
  // 実際のコースで、両側が走れる場所になっている壁 (コースどうしの間の壁) のうち薄いものに、
  // DRS 込みの最高速で直角に突っ込む (直進とスピン中)。壁の厚さの半分 = 壁の中の距離 (SDF) の最大値
  const vTop = m.carParams.vBase * (1 + m.carParams.drsBonus);
  const walls = [];
  for (let s = 0; s < track.length; s += 20) {
    for (const side of [1, -1]) {
      let inWall = false;
      let start = 0;
      let peak = 0;
      for (let d = track.widthAt(s) / 2; d < 700; d += 1) {
        const q = track.poseAt(s, side * d);
        const w = track.wallDistance(q.x, q.y);
        if (!inWall) {
          if (w > 0) { inWall = true; start = d; peak = w; }
          continue;
        }
        peak = Math.max(peak, w);
        if (w > 0) continue;
        // 壁を抜けた先が走れる場所 (壁でない路面) なら、コースどうしの間の壁
        const r = track.poseAt(s, side * (d + 10));
        if (track.wallDistance(r.x, r.y) < 0 && track.surfaceCodeAt(r.x, r.y) !== m.SurfaceCode.wall) walls.push({ s, side, lat: start, width: d - start, peak });
        break;
      }
    }
  }
  const halfSafe = 4;
  const thin = walls.filter((w) => w.peak < 12);
  const slivers = thin.filter((w) => w.peak < halfSafe);
  let through = 0;
  let cases = 0;
  const idle = m.createControls();
  const full = m.createControls();
  full.throttle = 1;
  for (const w of thin) {
    if (w.peak < halfSafe) continue;
    for (const spinDir of [0, 1, -1]) {
      const start = track.poseAt(w.s, w.side * (w.lat - 40));
      const car = new m.Car(track);
      car.placeAt({ x: start.x, y: start.y, heading: start.heading + w.side * Math.PI / 2 });
      car.sF = vTop;
      if (spinDir !== 0) car.startContactSpin(spinDir);
      cases++;
      for (let i = 0; i < 60; i++) {
        car.update(spinDir !== 0 ? idle : full, dt);
        // 車の中心の通り道 (1 px ごと) が壁の中に入ったら突き抜け (中心が入る = 車の半分以上がめり込んでいる)
        const len = Math.hypot(car.x - car.prevX, car.y - car.prevY);
        let entered = !Number.isFinite(car.x);
        for (let k = 0; k <= Math.ceil(len) && !entered; k++) {
          const t = len > 0 ? Math.min(1, k / len) : 1;
          if (track.wallDistance(car.prevX + (car.x - car.prevX) * t, car.prevY + (car.y - car.prevY) * t) > 0) entered = true;
        }
        if (entered) { through++; break; }
      }
    }
  }
  console.log(`  コースどうしの間の壁で厚さ 24 px 未満の場所 ${thin.length} か所 (20 px ごとに左右を調べた数) × 直進・スピン 2 方向 = ${cases} 通り`);
  check(through === 0, 'コースの薄い壁 (厚さ 8 px 以上) を最高速・スピン中でも突き抜けない', `突き抜け ${through} 回`);
  if (slivers.length > 0) {
    const where = [...new Set(slivers.map((w) => `s=${w.s}${w.side > 0 ? '右' : '左'}`))].join(', ');
    console.log(`  [注意] 厚さ 8 px 未満の壁のかけら ${slivers.length} か所 (壁の端のとがった部分など。突き抜けられる): ${where}`);
  }
}

// ---------------------------------------------------------------- 芝生・砂利
console.log('\n== コース外 (car-physics.md 8 節) ==');
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
console.log('  (仕様 8 節の目安: 芝生 → 260 はアクセルを離して約 0.5 秒・踏んだまま約 1.2 秒、砂利 → 180 は約 0.6 秒・約 0.9 秒)');


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

// ---------------------------------------------------------------- M2: CPU・決勝
console.log('\n== CPU の基準ラップ (腕前 1.0、個体差・ミスなし、DRS は区間内で自由) ==');
const raceLine = new m.RacingLine(track, { tyreGrip: 1.08 });
{
  const refParams = { ...m.cpuParams, skillSpread: 0, difficulties: { ...m.cpuParams.difficulties, hard: { ...m.cpuParams.difficulties.hard, skill: 1.0, mistakeRate: 0 } } };
  const session = new m.TimeAttackSession(track, null);
  const driver = new m.CpuDriver(raceLine, track, 'hard', new m.Random(1), 1.08, refParams);
  const env = m.createCpuSurroundings(1);
  env.canDrive = true;
  env.timeSinceStart = 99;
  const c = m.createControls();
  const laps = [];
  for (let i = 0; i < 60 * 200 && laps.length < 3; i++) {
    driver.update(session.car, env, dt, c);
    for (const e of session.step(c, dt)) if (e.type === 'lapCompleted') laps.push(e.time);
  }
  const ref = Math.min(...laps);
  console.log(`  ラップ ${laps.map(fmt).join(' / ')} (速度プロファイルの目安 ${fmt(driver.estimatedLapTime)}) / コースデータの referenceLapTime: ${track.referenceLapTime ?? 'null'}`);
  check(laps.length === 3, 'CPU (腕前 1.0) が 3 周を走りきる');
  if (track.referenceLapTime !== null) {
    check(Math.abs(track.referenceLapTime - ref) < 0.3, 'referenceLapTime が実測と 0.3 秒以内', `実測 ${ref.toFixed(3)}`);
  }
}

/** 決勝を最後まで走らせて、統計と結果を返す */
function runRace({ seed, difficulty, cpuCount = 8, laps = 3, maxTime = 400, trackOverlap = true }) {
  const session = new m.RaceSession({ track, totalLaps: laps, playerCarNumber: null, cpuCount, difficulty, seed, racingLine: raceLine });
  const st = {
    contacts: 0, hardContacts: 0, spins: 0, resets: 0, blueFlags: 0, drsAvailable: 0, drsOpened: 0,
    slipFrames: 0, overtakes: 0, nanFrames: 0, maxWallDepth: 0, inWallFrames: 0, maxCarOverlap: 0, mistakes: 0,
    jumpStarts: 0, missed: 0, finalLap: 0, checkered: 0, lampOn: 0, lightsOutAt: NaN,
  };
  const lapTimes = new Map(session.cars.map((rc) => [rc.carNumber, []]));
  const probe = { depth: 0, normalX: 0, normalY: 0 };
  const pt = { x: 0, y: 0 };
  const outline = [[-9, 19], [9, 19], [-9, -19], [9, -19], [-9, 0], [9, 0]];
  const cr = { depth: 0, nx: 0, ny: 0, x: 0, y: 0 };
  let prevOrder = session.orderNumbers.join(',');
  const wasMistaking = new Map();
  let finishedAt = NaN;
  let t = 0;
  while (t < maxTime) {
    const evs = session.step(null, dt);
    t += dt;
    for (const e of evs) {
      switch (e.type) {
        case 'contact': st.contacts++; if (e.impact >= 187.5) st.hardContacts++; break;
        case 'resetStarted': st.resets++; break;
        case 'blueFlag': st.blueFlags++; break;
        case 'drsAvailable': st.drsAvailable++; break;
        case 'drsOpened': st.drsOpened++; break;
        case 'jumpStart': st.jumpStarts++; break;
        case 'finalLap': st.finalLap++; break;
        case 'checkeredFlag': st.checkered++; break;
        case 'lampOn': st.lampOn++; break;
        case 'lightsOut': st.lightsOutAt = session.time; break;
        case 'lapResult': lapTimes.get(e.carNumber).push(e.time); break;
        case 'lap': if (e.event.type === 'checkpointMissed') st.missed++; break;
        default: break;
      }
    }
    for (const rc of session.cars) {
      const car = rc.car;
      if (car.spinStarted) st.spins++;
      if (car.fSlip > 0.5) st.slipFrames++;
      if (rc.driver) {
        if (rc.driver.isMistaking && !wasMistaking.get(rc.carNumber)) st.mistakes++;
        wasMistaking.set(rc.carNumber, rc.driver.isMistaking);
      }
      if (![car.x, car.y, car.heading, car.sF, car.sR, car.vx, car.vy, rc.distance].every(Number.isFinite)) st.nanFrames++;
      for (const k of outline) {
        car.localToWorld(k[0], k[1], pt);
        track.wallContact(pt.x, pt.y, probe);
        st.maxWallDepth = Math.max(st.maxWallDepth, probe.depth);
      }
      if (track.surfaceCodeAt(car.x, car.y) === m.SurfaceCode.wall) st.inWallFrames++;
    }
    if (trackOverlap) {
      for (let i = 0; i < session.cars.length; i++) {
        for (let j = i + 1; j < session.cars.length; j++) {
          if (session.isGhostPair(i, j)) continue;
          if (m.detectContact(session.cars[i].car, session.cars[j].car, cr)) st.maxCarOverlap = Math.max(st.maxCarOverlap, cr.depth);
        }
      }
    }
    const order = session.orderNumbers.join(',');
    if (order !== prevOrder && session.phase === 'racing' && session.raceTime > 0) {
      const a = prevOrder.split(',');
      const b = order.split(',');
      for (let i = 0; i < b.length; i++) if (a.indexOf(b[i]) > i) st.overtakes++;
    }
    prevOrder = order;
    if (session.phase === 'finished') { finishedAt = t; break; }
  }
  return { session, st, lapTimes, finishedAt };
}

function printRace(label, r) {
  const { session, st, lapTimes } = r;
  console.log(`\n== ${label} ==`);
  console.log(`  消灯 ${st.lightsOutAt.toFixed(2)} 秒 (ランプ ${st.lampOn} 回) / 結果確定 ${Number.isFinite(r.finishedAt) ? r.finishedAt.toFixed(1) + ' 秒' : '未確定'}`);
  console.log('  順位 車番 腕前   反応   状態            総タイム    差          ベスト     各周');
  for (const res of session.results) {
    const rc = session.carByNumber(res.carNumber);
    const gap = res.gapToWinner.kind === 'time' ? `+${res.gapToWinner.seconds.toFixed(3)}` : res.gapToWinner.kind === 'laps' ? `+${res.gapToWinner.laps} LAP` : res.gapToWinner.kind.toUpperCase();
    console.log(`  P${res.position}   #${res.carNumber}   ${rc.driver ? rc.driver.skill.toFixed(3) : '-'}  ${rc.reactionTime?.toFixed(2) ?? '-'}   ${res.status.padEnd(13)} ${fmt(res.totalTime).padStart(9)}  ${gap.padEnd(10)}  ${fmt(res.bestLap)}  ${lapTimes.get(res.carNumber).map(fmt).join(' ')}  (グリッド ${rc.gridSlot + 1})`);
  }
  console.log(`  接触 ${st.contacts} 回 (強い 187.5 以上 ${st.hardContacts}) / スピン ${st.spins} / コース復帰 ${st.resets} / コーナーのミス ${st.mistakes} / 順位の入れ替わり ${st.overtakes}`);
  console.log(`  DRS 使用権 ${st.drsAvailable} 回・開いた ${st.drsOpened} 回 / スリップストリーム (fSlip>0.5) ${(st.slipFrames * dt).toFixed(1)} 台秒 / BLUE FLAG ${st.blueFlags} / FINAL LAP ${st.finalLap} / チェッカー ${st.checkered}`);
  console.log(`  壁の最大めり込み ${st.maxWallDepth.toFixed(2)} px / 壁の中 ${st.inWallFrames} フレーム / 車同士の重なり (解決後) 最大 ${st.maxCarOverlap.toFixed(2)} px / NaN ${st.nanFrames} / 未通過 ${st.missed}`);
}

// 難易度ごと: 1 台だけで走らせたラップ (他車の影響なし)
console.log('\n== CPU の難易度ごとのラップ (1 台で 4 周、2〜4 周目。seed 1〜3) ==');
for (const difficulty of ['easy', 'normal', 'hard']) {
  const all = [];
  let mistakes = 0;
  for (const seed of [1, 2, 3]) {
    const r = runRace({ seed, difficulty, cpuCount: 1, laps: 4, trackOverlap: false });
    all.push(...r.lapTimes.get(r.session.cars[0].carNumber).slice(1));
    mistakes += r.st.mistakes;
  }
  const avg = all.reduce((a, b) => a + b, 0) / all.length;
  console.log(`  ${difficulty.padEnd(6)}: 平均 ${fmt(avg)} / 最速 ${fmt(Math.min(...all))} / 最遅 ${fmt(Math.max(...all))} / ミス ${mistakes} 回 (12 周)`);
}

t0 = performance.now();
const raceA = runRace({ seed: 12345, difficulty: 'normal' });
const raceMs = performance.now() - t0;
printRace(`8 台・3 周・NORMAL (seed 12345、計算 ${raceMs.toFixed(0)} ms)`, raceA);
const allClassified = raceA.session.results.length === 8 && raceA.session.results.every((r) => r.status === 'finished');
check(raceA.session.phase === 'finished' && allClassified, '8 台で 3 周のレースが最後まで終わり、全車完走');
check(raceA.st.nanFrames === 0, '接触があっても NaN にならない');
check(raceA.st.maxWallDepth < 2 && raceA.st.inWallFrames === 0, '決勝で壁を突き抜けない', `最大めり込み ${raceA.st.maxWallDepth.toFixed(2)} px`);
check(raceA.st.maxCarOverlap < 3, '車同士の重なりが残らない (接触処理のあと 3 px 未満)', `${raceA.st.maxCarOverlap.toFixed(2)} px`);
check(raceA.st.lampOn === 5 && raceA.st.lightsOutAt >= 5.5 && raceA.st.lightsOutAt <= 7.5 + dt, 'ランプ 5 回点灯、消灯は 5.5〜7.5 秒', `${raceA.st.lightsOutAt.toFixed(2)} 秒`);
check(raceA.st.jumpStarts === 0, 'CPU はフライングしない');
check(raceA.st.finalLap === 1 && raceA.st.checkered === 1, 'FINAL LAP・チェッカーが 1 回ずつ');

const raceB = runRace({ seed: 12345, difficulty: 'normal' });
const sig = (r) => JSON.stringify(r.session.results) + r.session.cars.map((rc) => `${rc.car.x},${rc.car.y},${rc.car.heading}`).join(';');
check(sig(raceA) === sig(raceB), '同じ seed なら結果と最後の位置が完全に一致する');
const raceC = runRace({ seed: 999, difficulty: 'normal' });
check(sig(raceA) !== sig(raceC), '別の seed なら結果が変わる');

for (const [difficulty, seed] of [['easy', 7], ['hard', 8], ['hard', 9]]) {
  const r = runRace({ seed, difficulty });
  printRace(`8 台・3 周・${difficulty.toUpperCase()} (seed ${seed})`, r);
  check(r.session.phase === 'finished' && r.st.nanFrames === 0 && r.st.inWallFrames === 0 && r.st.maxCarOverlap < 3,
    `${difficulty} seed ${seed}: 最後まで終わり、NaN・壁の突き抜け・重なりなし`);
}

// ---------------------------------------------------------------- 接触の単体の確認
console.log('\n== 車同士の接触 (単体) ==');
{
  // 追突: 止まっている車に 500 px/秒 で突っ込んでも、前後が入れ替わらない (すり抜けない)
  const cs = new m.ContactSystem(2);
  const s0 = track.drsStartS + 300;
  const a = new m.Car(track);
  const b = new m.Car(track);
  a.placeAt(track.poseAt(s0 - 120, 0));
  b.placeAt(track.poseAt(s0, 0));
  a.sF = 500;
  const idle = m.createControls();
  let impact = 0;
  let spin = false;
  for (let i = 0; i < 90; i++) {
    a.update(idle, dt);
    b.update(idle, dt);
    for (const e of cs.step([a, b], () => false, i * dt)) { impact = Math.max(impact, e.impact); spin ||= e.spinA; }
  }
  const pa = track.project(a.x, a.y, -1).s;
  const pb = track.project(b.x, b.y, -1).s;
  check(pa < pb && impact > 0, '追突しても前後が入れ替わらない', `衝撃 ${impact.toFixed(0)} px/秒、当てた側のスピン ${spin}、差 ${(pb - pa).toFixed(1)} px`);
  check(b.sF <= 500 + 1e-6, '当てられた側が当てた側より速くならない', `当てられた側 ${b.sF.toFixed(0)} px/秒・当てた側 ${a.sF.toFixed(0)} px/秒`);
}
{
  // 横から壁に押し付ける: 壁際の車に斜めから当てても、どちらも壁を突き抜けない
  let worst = 0;
  let inWall = 0;
  let nan = 0;
  for (const s0 of [1000, 4000, 8000, 12000, 15000]) {
    for (const side of [-1, 1]) {
      const cs = new m.ContactSystem(2);
      const a = new m.Car(track);
      const b = new m.Car(track);
      // 壁の手前 14 px (車の半幅 9 + 5) に B を置く
      let wallLat = track.widthAt(s0) / 2;
      for (; wallLat < 400; wallLat += 2) {
        const q = track.poseAt(s0, side * wallLat);
        if (track.wallDistance(q.x, q.y) > -14) break;
      }
      const pb = track.poseAt(s0, side * wallLat);
      b.placeAt(pb);
      const pa = track.poseAt(s0 - 60, side * (wallLat - 45));
      a.placeAt({ x: pa.x, y: pa.y, heading: pa.heading + side * 0.6 });
      a.sF = 450;
      const idle = m.createControls();
      for (let i = 0; i < 120; i++) {
        a.update(idle, dt);
        b.update(idle, dt);
        cs.step([a, b], () => false, i * dt);
        for (const car of [a, b]) {
          if (![car.x, car.y, car.sF, car.sR].every(Number.isFinite)) nan++;
          if (track.surfaceCodeAt(car.x, car.y) === m.SurfaceCode.wall) inWall++;
          for (const k of [[-9, 19], [9, 19], [-9, -19], [9, -19]]) {
            const p2 = car.localToWorld(k[0], k[1], { x: 0, y: 0 });
            worst = Math.max(worst, track.wallDistance(p2.x, p2.y));
          }
        }
      }
    }
  }
  check(inWall === 0 && worst < 3 && nan === 0, '壁際で横から押し付けても壁を突き抜けない', `角の最大めり込み ${worst.toFixed(2)} px、壁の中 ${inWall}、NaN ${nan}`);
}
{
  // 0.2 秒以内の再衝撃は押し戻しだけ / ゴーストの組は判定しない
  const cs = new m.ContactSystem(2);
  const a = new m.Car(track);
  const b = new m.Car(track);
  const s0 = track.drsStartS + 300;
  a.placeAt(track.poseAt(s0 - 30, 0));
  b.placeAt(track.poseAt(s0, 0));
  a.sF = 300;
  const n1 = cs.step([a, b], () => false, 0).length;
  a.placeAt(track.poseAt(s0 - 30, 0));
  a.sF = 300;
  const n2 = cs.step([a, b], () => false, 0.1).length;
  a.placeAt(track.poseAt(s0 - 30, 0));
  a.sF = 300;
  const n3 = cs.step([a, b], () => false, 0.35).length;
  a.placeAt(track.poseAt(s0 - 30, 0));
  const beforeX = a.x;
  const n4 = cs.step([a, b], () => true, 1).length;
  check(n1 === 1 && n2 === 0 && n3 === 1, '同じ 2 台の 0.2 秒以内の再衝撃は出ない (押し戻しだけ)', `${n1} / ${n2} / ${n3}`);
  check(n4 === 0 && a.x === beforeX, 'ゴーストの組み合わせは判定しない');
}
{
  // スリップストリーム: 前の車の真後ろ 100 px を 400 px/秒 で走ると fSlip が上がり、横にずれると上がらない
  const s0 = track.drsStartS + 200;
  const run = (lateral) => {
    const session = new m.RaceSession({ track, totalLaps: 3, playerCarNumber: 1, cpuCount: 1, difficulty: 'normal', seed: 5, racingLine: raceLine });
    const [lead, follow] = [session.cars[0], session.cars[1]];
    while (session.phase === 'grid') session.step(null, dt);
    let maxSlip = 0;
    for (let i = 0; i < 40; i++) {
      lead.car.placeAt(track.poseAt(s0 + i * 6, 0));
      lead.car.sF = 360;
      follow.car.placeAt(track.poseAt(s0 - 100 + i * 6, lateral));
      follow.car.sF = 360;
      session.step(null, dt);
      maxSlip = Math.max(maxSlip, follow.car.fSlip);
    }
    return maxSlip;
  };
  const behind = run(0);
  const offset = run(60);
  check(behind > 0.9 && offset === 0, 'スリップストリームは真後ろで効き、横にずれると効かない', `真後ろ ${behind.toFixed(2)} / 横 60 px ${offset.toFixed(2)}`);
}
{
  // 消灯までは動けない: ランプ点灯中にアクセルやハンドルを入れても車は止まったままで、フライングにならない
  const session = new m.RaceSession({ track, totalLaps: 3, playerCarNumber: 1, cpuCount: 3, difficulty: 'normal', seed: 3, racingLine: raceLine });
  const c = m.createControls();
  const evs = [];
  const x0 = session.player.car.x;
  const y0 = session.player.car.y;
  let maxMove = 0;
  while (session.phase === 'grid') {
    c.throttle = session.time > 2 ? 1 : 0;
    c.steerInput = session.time > 2 ? 1 : 0;
    for (const e of session.step(c, dt)) evs.push(e);
    if (session.phase === 'grid') maxMove = Math.max(maxMove, Math.hypot(session.player.car.x - x0, session.player.car.y - y0));
  }
  const jump = evs.filter((e) => e.type === 'jumpStart');
  check(maxMove === 0 && jump.length === 0 && session.player.penalty === 0, '消灯までアクセルを踏んでも動かず、フライングにならない', `消灯前の移動 ${maxMove.toFixed(2)} px`);
  c.steerInput = 0;
  // 踏みっぱなしで消灯 → 離すまで動かない (反応時間 0 で出られないように)
  const heldEvents = [];
  for (let i = 0; i < 30; i++) for (const e of session.step(c, dt)) heldEvents.push(e);
  const heldSpeed = session.player.car.sF;
  check(session.player.isLaunchBlocked && heldSpeed === 0 && session.player.reactionTime === null && !heldEvents.some((e) => e.type === 'reaction' && e.carNumber === 1),
    '踏んだまま消灯すると、離すまで発進できず反応時間も付かない', `0.5 秒後 ${heldSpeed.toFixed(0)} px/秒`);
  // 離して踏み直すと発進し、反応時間は踏み直した瞬間から数える
  c.throttle = 0;
  session.step(c, dt);
  const released = !session.player.isLaunchBlocked;
  c.throttle = 1;
  const pressedAt = session.time - session.lightsOutAt;
  for (let i = 0; i < 30; i++) session.step(c, dt);
  const reaction = session.player.reactionTime;
  check(released && session.player.car.sF > 0, '離して踏み直すと発進できる', `0.5 秒後 ${session.player.car.sF.toFixed(0)} px/秒`);
  check(reaction !== null && Math.abs(reaction - pressedAt) < dt * 1.5 && reaction > 0.4, '反応時間は踏み直した瞬間から (消灯からの時間)',
    `${reaction?.toFixed(3)} 秒 (踏み直し ${pressedAt.toFixed(3)} 秒)`);
  check(session.player.gridSlot === session.cars.length - 1, '予選スキップではプレイヤーが最後尾');
  // プレイヤーがリタイアすると、その場で結果が確定する (CPU は推定)
  session.retire(1);
  const r = session.step(c, dt);
  const player = session.results.find((x) => x.isPlayer);
  check(session.phase === 'finished' && r.some((e) => e.type === 'raceFinished') && player.status === 'retired' && player.position === session.results.length,
    'プレイヤーのリタイアで結果が確定し、リタイアは最後');
}
{
  // 1 人用: プレイヤー (CPU の運転を借りる) がゴールした時点で残りの CPU を推定して確定する
  const session = new m.RaceSession({ track, totalLaps: 2, playerCarNumber: 4, cpuCount: 7, difficulty: 'easy', seed: 11, racingLine: raceLine });
  const pilot = new m.CpuDriver(raceLine, track, 'hard', new m.Random(77), 1.08);
  const env = m.createCpuSurroundings(8);
  const c = m.createControls();
  let finishedEvent = null;
  let t = 0;
  while (session.phase !== 'finished' && t < 200) {
    env.othersCount = 0;
    for (const rc of session.cars) if (!rc.isPlayer && !session.isGhostPair(rc.index, session.player.index)) env.others[env.othersCount++] = rc.car;
    env.canDrive = session.phase !== 'grid';
    env.timeSinceStart = session.raceTime;
    pilot.update(session.player.car, env, dt, c);
    for (const e of session.step(c, dt)) if (e.type === 'carFinished' && e.carNumber === 4) finishedEvent = e;
    t += dt;
  }
  const res = session.results;
  const player = res.find((x) => x.isPlayer);
  console.log(`  1 人用 (プレイヤー役は HARD の CPU、相手は EASY 7 台、2 周): プレイヤー P${player.position} ${fmt(player.totalTime)} / 推定 ${res.filter((x) => x.isEstimated).length} 台 / 確定 ${t.toFixed(1)} 秒`);
  check(session.phase === 'finished' && finishedEvent !== null && finishedEvent.position === player.position && res.length === 8,
    '1 人用: プレイヤーのゴールで全車の結果が確定する (carFinished の順位 = 確定順位)');
  check(res.every((x, i) => i === 0 || x.status !== 'finished' || res[i - 1].status !== 'finished' || res[i - 1].lapsCompleted > x.lapsCompleted || res[i - 1].totalTime <= x.totalTime),
    '結果が周回数とタイム + ペナルティの順に並ぶ');
}

{
  // 周回遅れ: 止まったままのプレイヤーを CPU が周回遅れにする。後ろ 190 px で BLUE FLAG、すり抜けて接触しない
  const session = new m.RaceSession({ track, totalLaps: 3, playerCarNumber: 2, cpuCount: 1, difficulty: 'hard', seed: 21, racingLine: raceLine });
  const idle = m.createControls();
  let blueAt = -1;
  let contacts = 0;
  let gapBefore = null;
  let lappedGap = null;
  const cpu = session.cars[0];
  for (let i = 0; i < 60 * 60 && lappedGap === null; i++) {
    for (const e of session.step(idle, dt)) {
      if (e.type === 'blueFlag' && e.carNumber === 2 && blueAt < 0) {
        blueAt = session.player.distance - cpu.distance + track.length;
        gapBefore = session.player.gapToLeader;
      }
      if (e.type === 'contact') contacts++;
    }
    if (cpu.distance - session.player.distance >= track.length) lappedGap = session.player.gapToLeader;
  }
  check(blueAt > 0 && blueAt <= 190 + 12, '周回遅れにされる車に、後ろ 190 px 以内で BLUE FLAG', `${blueAt.toFixed(0)} px`);
  check(contacts === 0 && lappedGap?.kind === 'laps' && lappedGap.laps === 1, '周回遅れの組み合わせはすり抜け、差は +1 LAP', `接触 ${contacts}、差 ${JSON.stringify(lappedGap)}`);
}
{
  // コース復帰: 止まって R → 置き直し → 1.5 秒後に操作再開、その後 3 秒はゴースト (全車とすり抜け)
  const session = new m.RaceSession({ track, totalLaps: 3, playerCarNumber: 1, cpuCount: 2, difficulty: 'normal', seed: 4, racingLine: raceLine });
  const c = m.createControls();
  while (session.phase === 'grid') session.step(c, dt);
  for (let i = 0; i < 90; i++) session.step(c, dt);
  const types = [];
  c.resetPressed = true;
  let ghostDuring = true;
  let finishedAt = -1;
  let ghostEnd = -1;
  for (let i = 0; i < 60 * 7; i++) {
    for (const e of session.step(c, dt)) if (e.carNumber === 1 && e.type.startsWith('reset')) { types.push(e.type); if (e.type === 'resetFinished') finishedAt = session.time; }
    c.resetPressed = false;
    const p = session.player;
    if (types.includes('resetPlaced') && finishedAt < 0 && !session.isGhostPair(p.index, 0)) ghostDuring = false;
    if (finishedAt > 0 && ghostEnd < 0 && !p.isGhost) ghostEnd = session.time - finishedAt;
  }
  check(types.join(',') === 'resetStarted,resetPlaced,resetFinished' && ghostDuring, 'コース復帰の手順が進み、置き直しから操作再開まではゴースト', types.join(','));
  check(ghostEnd >= 3 - dt && ghostEnd < 3.2, '操作再開から 3 秒でゴーストが終わる', `${ghostEnd.toFixed(2)} 秒`);
}

{
  // 追い抜き: 最後尾の HARD (プレイヤー役を CPU の運転で走らせる) が、遅い CPU の後ろに詰まり続けないか (3 周)
  console.log('\n== 追い抜き (最後尾の HARD 1 台 vs 相手 7 台、3 周) ==');
  let easyGain = Infinity;
  let hardContacts = 0;
  let spins = 0;
  for (const [opp, seed] of [['easy', 11], ['easy', 12], ['normal', 13], ['normal', 14]]) {
    const session = new m.RaceSession({ track, totalLaps: 3, playerCarNumber: 4, cpuCount: 7, difficulty: opp, seed, racingLine: raceLine });
    const pilot = new m.CpuDriver(raceLine, track, 'hard', new m.Random(seed * 7), 1.08);
    const env = m.createCpuSurroundings(8);
    const c = m.createControls();
    const p = session.player;
    let contacts = 0;
    let own = 0;
    for (let i = 0; i < 60 * 200 && session.phase !== 'finished'; i++) {
      env.othersCount = 0;
      for (const rc of session.cars) if (!rc.isPlayer && !session.isGhostPair(rc.index, p.index)) env.others[env.othersCount++] = rc.car;
      env.canDrive = session.phase !== 'grid';
      env.timeSinceStart = session.raceTime;
      pilot.update(p.car, env, dt, c);
      for (const e of session.step(c, dt)) {
        if (e.type !== 'contact') continue;
        contacts++;
        if (e.carA === 4 || e.carB === 4) own++;
        if (e.impact >= 187.5) hardContacts++;
      }
      for (const rc of session.cars) if (rc.car.spinStarted) spins++;
    }
    const r = session.results.find((x) => x.isPlayer);
    const gain = session.cars.length - (r?.position ?? 99);
    if (opp === 'easy') easyGain = Math.min(easyGain, gain);
    console.log(`  vs ${opp.padEnd(6)} (seed ${seed}): グリッド 8 番手 → P${r?.position} / 接触 ${contacts} (自車 ${own})`);
  }
  check(easyGain >= 4, 'HARD は EASY の後ろに詰まり続けず、最後尾から 4 つ以上順位を上げる', `最小 ${easyGain}`);
  check(hardContacts === 0 && spins === 0, '追い抜きで強い接触 (187.5 以上)・スピンが出ない', `強い接触 ${hardContacts}、スピン ${spins}`);
}

console.log(failures === 0 ? '\nすべての確認が OK' : `\nNG が ${failures} 件`);
process.exitCode = failures === 0 ? 0 : 1;
