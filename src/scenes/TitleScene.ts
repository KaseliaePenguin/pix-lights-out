import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { WorldLayer } from '../core/WorldLayer';
import { colors } from '../ui/colors';
import { drawStartLamps, startLampsWidth } from '../ui/startLamps';
import type { LampImages } from '../ui/startLamps';
import { drawText, measureText } from '../ui/text';
import { drawFullscreenButton } from '../ui/touchUi';
import { GuestLobbyScene } from './GuestLobbyScene';
import { clearInviteHandler, setInviteHandler } from './inviteRouter';
import type { Invite } from './inviteRouter';
import { MenuScene } from './MenuScene';
import { handleFullscreenTap, isFullscreenButtonShown, wasMenuConfirmPressed } from './menuKeys';

// スタートランプの演出: 1 秒ごとに 1 灯 → 5 灯で少し保持 → 全消灯 (1 回目の消灯で車が発進) → 暗いまま待って繰り返す
const firstLampDelay = 1;
const lampStep = 1;
const lampHoldMin = 0.6;
const lampHoldMax = 1.6;
const lampDarkTime = 3;

// 画面上の配置 (px)
const lampsY = 148;
const logoY = 236;
const pressEnterY = 418;

/**
 * タイトル画面 (6.1 節)。背景のコースを 8 台が走り、スタートランプの消灯で一斉に発進する。
 * 背景・ロゴ・ランプの画像がなければ、文字のロゴとコードで描くランプで代用する。
 */
export class TitleScene implements Scene {
  private time = 0;
  private readonly world = new WorldLayer();
  private readonly background: HTMLImageElement | null;
  private readonly logo: HTMLImageElement | null;
  private readonly lampImages: LampImages | null;
  private readonly traffic: TitleTraffic | null;

  private litCount = 0;
  /** 次のランプの点灯 (litCount < 5) または消灯 (litCount = 5) まで、または暗い間の残り時間 (秒) */
  private lampTimer = firstLampDelay;
  private isLampDark = true;

  constructor(private readonly game: Game) {
    const { assets } = game;
    this.background = assets.getImage('title-bg');
    this.logo = assets.getImage('title-logo');
    const lampOn = assets.getImage('ui-lamp-on');
    const lampOff = assets.getImage('ui-lamp-off');
    this.lampImages = lampOn && lampOff ? { on: lampOn, off: lampOff } : null;
    const paths = parseTitlePaths(assets.getData('title-paths'));
    this.traffic = paths && this.background ? new TitleTraffic(paths, (team) => assets.getImage(carSpriteName(team))) : null;
  }

  /** 開いたまま招待リンクを開いたら、参加画面へ */
  private readonly onInvite = (invite: Invite) => this.game.changeScene(new GuestLobbyScene(this.game, null, invite));

  enter(): void {
    this.game.audio.playBgm('menu-theme');
    setInviteHandler(this.onInvite);
  }

  exit(): void {
    clearInviteHandler(this.onInvite);
  }

  update(dt: number): void {
    this.time += dt;
    this.updateLamps(dt);
    this.traffic?.update(dt);
    if (handleFullscreenTap(this.game)) return;
    // タッチの端末 (とマウス) は画面のどこをタップしても始める
    if (wasMenuConfirmPressed(this.game.input) || this.game.pointer.tap) {
      this.game.audio.playSe('ui-confirm');
      this.game.changeScene(new MenuScene(this.game));
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    if (this.background) {
      const world = this.world;
      world.ctx.setTransform(1, 0, 0, 1, 0, 0);
      world.ctx.drawImage(this.background, 0, 0);
      this.traffic?.render(world);
      world.present(ctx);
    } else {
      ctx.fillStyle = colors.base;
      ctx.fillRect(0, 0, width, height);
    }

    drawStartLamps(ctx, this.litCount, (width - startLampsWidth) / 2, lampsY, this.lampImages);

    if (this.logo) {
      const w = this.logo.width * 2;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.logo, Math.round((width - w) / 4) * 2, logoY, w, this.logo.height * 2);
      ctx.restore();
    } else {
      drawText(ctx, 'PIX LIGHTS OUT', width / 2, logoY + 20, { scale: 6, color: colors.white, align: 'center' });
    }

    if (isFullscreenButtonShown(this.game)) drawFullscreenButton(ctx, this.game.screen.isFullscreen);

    if (Math.floor(this.time * 2) % 2 === 0) {
      const label = this.game.pointer.isTouchMode ? 'TAP TO START' : 'PRESS ENTER';
      const textW = measureText(label);
      const textLeft = Math.round((width - textW) / 4) * 2;
      ctx.fillStyle = colors.ink;
      ctx.fillRect(textLeft - 10, pressEnterY - 6, textW + 20, 26);
      drawText(ctx, label, width / 2, pressEnterY, { color: colors.text, align: 'center' });
    }
  }

  private updateLamps(dt: number): void {
    this.lampTimer -= dt;
    if (this.lampTimer > 0) return;
    if (this.isLampDark) {
      this.isLampDark = false;
      this.litCount = 1;
      this.lampTimer += lampStep;
    } else if (this.litCount < 5) {
      this.litCount++;
      this.lampTimer += this.litCount < 5 ? lampStep : lampHoldMin + Math.random() * (lampHoldMax - lampHoldMin);
    } else {
      // 全消灯 (lights out)
      this.litCount = 0;
      this.isLampDark = true;
      this.lampTimer += lampDarkTime;
      this.traffic?.start();
    }
  }
}

function carSpriteName(team: number): string {
  return `car-team-${String(team).padStart(2, '0')}`;
}

// ---- 背景の車の経路 (public/assets/data/title-paths.json) ----

type Point = readonly [number, number];

interface TitlePaths {
  count: number;
  /** レーン 0 = inner、1 = center、2 = outer。同じ番号 i の点が真横に並ぶ (2 ドット間隔) */
  lanes: readonly (readonly Point[])[];
  /** 0 = 北、時計回りが正 */
  heading: readonly number[];
  speedFactor: readonly number[];
  pit: { fromIndex: number; toIndex: number; speed: number; points: readonly Point[] } | null;
  cars: readonly { team: number; lane: number; speed: number }[];
}

const laneNames = ['inner', 'center', 'outer'] as const;
const laneWidthDots = 7;

/** JSON を検証して使いやすい形にする。形が違えば null (車を走らせない) */
function parseTitlePaths(data: unknown): TitlePaths | null {
  if (!isObject(data) || !isObject(data.lanes) || !Array.isArray(data.cars)) return null;
  const count = data.count;
  if (typeof count !== 'number' || count < 10) return null;
  const lanesData = data.lanes;
  const lanes = laneNames.map((name) => lanesData[name]);
  if (!lanes.every((lane) => isPointList(lane) && lane.length === count)) return null;
  if (!isNumberList(data.heading, count) || !isNumberList(data.speedFactor, count)) return null;

  let pit: TitlePaths['pit'] = null;
  const p = data.pit;
  if (isObject(p) && isObject(p.from) && isObject(p.to) && isPointList(p.points) && p.points.length > 1) {
    const fromIndex = p.from.index;
    const toIndex = p.to.index;
    if (typeof fromIndex === 'number' && typeof toIndex === 'number' && typeof p.speed === 'number') {
      pit = { fromIndex, toIndex, speed: p.speed, points: p.points };
    }
  }

  const cars: { team: number; lane: number; speed: number }[] = [];
  for (const c of data.cars) {
    if (!isObject(c) || typeof c.team !== 'number' || typeof c.speed !== 'number') continue;
    const lane = laneNames.indexOf(c.lane as (typeof laneNames)[number]);
    cars.push({ team: c.team, lane: lane < 0 ? 1 : lane, speed: c.speed });
  }
  return { count, lanes: lanes as Point[][], heading: data.heading, speedFactor: data.speedFactor, pit, cars };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPointList(value: unknown): value is Point[] {
  return Array.isArray(value) && value.every((v) => Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number');
}

function isNumberList(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((v) => typeof v === 'number');
}

// ---- 背景の車の動き ----

/** 車線変更にかける点の数 (1 点 = 2 ドット)。1 レーン 20 点、2 レーン (inner ↔ outer) は 30 点 */
const laneChangePoints = 20;
const laneChangePointsPerExtraLane = 10;
const maxLaneChangePoints = laneChangePoints + laneChangePointsPerExtraLane;
/** 前の車との中心の距離 (ドット) がこれ以下で、追い抜きを考える (車の長さ 20 ドット + 車間 14) */
const passDistance = 34;
/** これより近づかない (中心の距離、ドット) */
const followDistance = 26;
/**
 * 横の差 (レーン数) がこれ未満なら、前後に並ぶ必要がある (同じ列とみなす)。
 * レーンの間隔 7 ドットは車幅 10 ドットより狭く、隣のレーンで並ぶとタイヤが重なるため、
 * 横に並べるのは inner と outer (14 ドット) だけにする
 */
const sameLaneWidth = 1.5;
const acceleration = 90;
const braking = 220;
const wobbleAmount = 0.05;
const wobbleIntervalMin = 3;
const wobbleIntervalMax = 6;
/** 抜いてから元のレーンに戻るまで (秒) */
const returnDelayMin = 2;
const returnDelayMax = 4;
/** ピットに入る間隔 (秒、最初の発進から) */
const pitInterval = 40;
/** グリッドの車の前端の x (ドット)。背景に描かれた 4 枠 (inner 220 / 170、outer 195 / 145)。5 台目以降はその後ろに並べる */
const gridFronts = [220, 195, 170, 145, 144, 119, 118, 93];
/** 車の中心から前端までのドット */
const carHalfLength = 10;
/** 後輪の位置 (車の中心から。北向きで x は右、y は後ろ向きが正) */
const rearWheelX = 4;
const rearWheelY = 6;
const maxSkidMarks = 400;
const skidColor = '#2a2a33';

interface TitleCar {
  sprite: HTMLImageElement | null;
  team: number;
  /** 経路上の位置 (点の番号、小数あり) */
  index: number;
  laneFrom: number;
  laneTo: number;
  /** 車線変更の進み (0〜1、1 で完了) */
  laneT: number;
  /** 今の車線変更にかける点の数 */
  lanePoints: number;
  homeLane: number;
  baseSpeed: number;
  wobble: number;
  wobbleTimer: number;
  /** 現在の速度 (ドット/秒) */
  speed: number;
  /** 元のレーンへ戻るまでの残り (秒)。負なら予定なし */
  returnTimer: number;
  /** ピットの経路上の位置。null ならコース上 */
  pit: number | null;
  isMarking: boolean;
  markDistance: number;
  x: number;
  y: number;
  heading: number;
}

/** タイトル画面の背景を走る 8 台 (見た目だけの動き。物理は使わない) */
class TitleTraffic {
  private readonly cars: TitleCar[] = [];
  /** コーナーの手前 22 点がすべて直線 (speedFactor 1) なら true。車線変更はここでだけ始める */
  private readonly isStraightAhead: boolean[];
  private isRunning = false;
  private runTime = 0;
  private nextPitTime = pitInterval;
  /** タイヤ痕 (リングバッファ、ドット座標 x, y の組) */
  private readonly marks = new Float32Array(maxSkidMarks * 2);
  private markCount = 0;
  private markHead = 0;

  constructor(
    private readonly paths: TitlePaths,
    getSprite: (team: number) => HTMLImageElement | null,
  ) {
    const n = paths.count;
    this.isStraightAhead = paths.speedFactor.map((_, i) => {
      for (let k = 0; k <= maxLaneChangePoints + 2; k++) if (paths.speedFactor[(i + k) % n] < 1) return false;
      return true;
    });
    paths.cars.forEach((c, slot) => {
      // グリッド: 奇数番目 (0 始まりの偶数) が inner、偶数番目が outer
      const lane = slot % 2 === 0 ? 0 : 2;
      const front = gridFronts[slot] ?? gridFronts[gridFronts.length - 1] - (slot - gridFronts.length + 1) * 25;
      const car: TitleCar = {
        sprite: getSprite(c.team),
        team: c.team,
        index: this.indexForX(lane, front - carHalfLength),
        laneFrom: lane,
        laneTo: lane,
        laneT: 1,
        lanePoints: laneChangePoints,
        homeLane: c.lane,
        baseSpeed: c.speed,
        wobble: 1,
        wobbleTimer: randomRange(wobbleIntervalMin, wobbleIntervalMax),
        speed: 0,
        // 発進直後の密集で車線を変えないよう、元のレーンへ戻るのは少し走ってから
        returnTimer: randomRange(4, 7),
        pit: null,
        isMarking: false,
        markDistance: 0,
        x: 0,
        y: 0,
        heading: 0,
      };
      this.updatePose(car);
      this.cars.push(car);
    });
  }

  /** 最初の消灯で発進する (2 回目以降は何もしない) */
  start(): void {
    this.isRunning = true;
  }

  update(dt: number): void {
    if (!this.isRunning) return;
    this.runTime += dt;
    for (const car of this.cars) this.updateCar(car, dt);
  }

  render(world: WorldLayer): void {
    const ctx = world.ctx;
    ctx.fillStyle = skidColor;
    for (let k = 0; k < this.markCount; k++) {
      const i = ((this.markHead - this.markCount + k + maxSkidMarks) % maxSkidMarks) * 2;
      ctx.fillRect(this.marks[i], this.marks[i + 1], 1, 1);
    }
    for (const car of this.cars) {
      // 背景は画面にそのまま並ぶので、ワールド座標 (px) = ドット × 2
      if (car.sprite) {
        world.drawRotated(car.sprite, car.x * 2, car.y * 2, car.heading, car.sprite.width, car.sprite.height);
      } else {
        ctx.fillStyle = colors.white;
        ctx.fillRect(Math.round(car.x) - 2, Math.round(car.y) - 2, 4, 4);
      }
    }
  }

  private updateCar(car: TitleCar, dt: number): void {
    const { paths } = this;
    const n = paths.count;

    car.wobbleTimer -= dt;
    if (car.wobbleTimer <= 0) {
      car.wobble = 1 + randomRange(-wobbleAmount, wobbleAmount);
      car.wobbleTimer = randomRange(wobbleIntervalMin, wobbleIntervalMax);
    }

    if (car.pit !== null) {
      this.updatePitCar(car, dt);
      return;
    }

    const i = Math.floor(car.index) % n;
    let target = car.baseSpeed * car.wobble * paths.speedFactor[i];

    const ahead = this.findCarAhead(car, this.laneOf(car));
    if (ahead) {
      const { other, distance } = ahead;
      const isChanging = car.laneT < 1;
      if (distance <= passDistance && !isChanging && this.isStraightAhead[i] && target > other.speed + 1) {
        this.tryPass(car, other);
      }
      // 抜けないとき (または抜き始めたばかり) は前の車に合わせる
      const stillAhead = this.findCarAhead(car, this.laneOf(car));
      if (stillAhead && stillAhead.distance < passDistance) {
        const limit = stillAhead.distance < followDistance ? stillAhead.other.speed * 0.9 : stillAhead.other.speed;
        target = Math.min(target, limit);
        if (stillAhead.distance < followDistance - 4) car.speed = Math.min(car.speed, limit);
      }
    }

    // 追い抜きのあと、数秒たったら元のレーンに戻る
    if (car.laneT >= 1 && car.laneTo !== car.homeLane) {
      if (car.returnTimer < 0) car.returnTimer = randomRange(returnDelayMin, returnDelayMax);
      car.returnTimer -= dt;
      if (car.returnTimer <= 0 && this.isStraightAhead[i]) {
        const next = car.laneTo + Math.sign(car.homeLane - car.laneTo);
        if (this.isLaneFree(car, next)) this.beginLaneChange(car, next);
      }
    }

    car.speed = approach(car.speed, target, acceleration * dt, braking * dt);
    const advance = (car.speed / 2) * dt;
    const before = car.index;
    car.index = (car.index + advance) % n;
    if (car.laneT < 1) car.laneT = Math.min(1, car.laneT + advance / car.lanePoints);

    // ピットイン: 一定時間ごとに、外側のレーンを走っている 1 台が入口を通ったら
    const pit = paths.pit;
    if (pit && this.runTime >= this.nextPitTime && car.laneT >= 1 && car.laneTo === 2 && !this.cars.some((c) => c.pit !== null)) {
      if (hasPassed(before, car.index, pit.fromIndex, n)) {
        car.pit = 0;
        this.nextPitTime = this.runTime + pitInterval;
      }
    }

    this.updatePose(car);
    this.addSkidMarks(car, i, advance * 2);
  }

  private updatePitCar(car: TitleCar, dt: number): void {
    const pit = this.paths.pit;
    if (!pit || car.pit === null) return;
    const last = pit.points.length - 1;
    let target = pit.speed;
    // 出口では外側のレーンが空くまで待つ
    if (car.pit > last - 6 && !this.isRejoinClear(car, pit.toIndex)) target = 0;
    car.speed = approach(car.speed, target, acceleration * dt, braking * dt);
    car.pit = Math.min(last, car.pit + (car.speed / 2) * dt);
    if (car.pit >= last && this.isRejoinClear(car, pit.toIndex)) {
      car.pit = null;
      car.index = pit.toIndex;
      car.laneFrom = 2;
      car.laneTo = 2;
      car.laneT = 1;
      this.updatePose(car);
      return;
    }
    const k = Math.floor(car.pit);
    const f = car.pit - k;
    const a = pit.points[k];
    const b = pit.points[Math.min(last, k + 1)];
    car.x = a[0] + (b[0] - a[0]) * f;
    car.y = a[1] + (b[1] - a[1]) * f;
    const c = pit.points[Math.max(0, Math.min(last, k + 2))];
    const d = pit.points[Math.max(0, k - 1)];
    if (c[0] !== d[0] || c[1] !== d[1]) car.heading = Math.atan2(c[0] - d[0], -(c[1] - d[1]));
  }

  private isRejoinClear(self: TitleCar, index: number): boolean {
    const n = this.paths.count;
    return this.cars.every((c) => {
      if (c === self || c.pit !== null || Math.abs(this.laneOf(c) - 2) >= sameLaneWidth) return true;
      const d = signedGap(index, c.index, n) * 2;
      return d > followDistance || d < -passDistance;
    });
  }

  /** 前の車と横に並べる (レーンの差が 2 = inner と outer) 側へ移る。前の車が center なら抜けない */
  private tryPass(car: TitleCar, blocker: TitleCar): void {
    if (blocker.laneT < 1 || blocker.laneTo === 1) return;
    const lane = 2 - blocker.laneTo;
    if (lane !== car.laneTo && this.isLaneFree(car, lane, blocker)) this.beginLaneChange(car, lane);
  }

  private beginLaneChange(car: TitleCar, lane: number): void {
    car.laneFrom = car.laneTo;
    car.laneTo = lane;
    car.laneT = 0;
    car.lanePoints = laneChangePoints + laneChangePointsPerExtraLane * (Math.abs(lane - car.laneFrom) - 1);
    car.returnTimer = -1;
  }

  /**
   * lane へ移る途中と移った先で、前後の車と重ならないか。
   * ignore (抜こうとしている前の車) は、今より近づかなければよい (移り終わるまで後ろについていく)
   */
  private isLaneFree(car: TitleCar, lane: number, ignore: TitleCar | null = null): boolean {
    const n = this.paths.count;
    const lo = Math.min(car.laneTo, lane);
    const hi = Math.max(car.laneTo, lane);
    return this.cars.every((c) => {
      if (c === car || c === ignore || c.pit !== null) return true;
      const lat = this.laneOf(c);
      const target = c.laneT < 1 ? c.laneTo : lat;
      const touchesTarget = Math.abs(lat - lane) < sameLaneWidth || Math.abs(target - lane) < sameLaneWidth;
      const touchesPath = (lat > lo - sameLaneWidth && lat < hi + sameLaneWidth) || touchesTarget;
      if (!touchesPath) return true;
      const d = signedGap(car.index, c.index, n) * 2;
      const aheadNeeded = touchesTarget ? passDistance + 6 : followDistance;
      return d > aheadNeeded || d < -passDistance;
    });
  }

  /** 同じ列 (横の差が sameLaneWidth 未満) で最も近い前の車と、中心の距離 (ドット) */
  private findCarAhead(car: TitleCar, lane: number): { other: TitleCar; distance: number } | null {
    const n = this.paths.count;
    let best: TitleCar | null = null;
    let bestDistance = Infinity;
    for (const c of this.cars) {
      if (c === car || c.pit !== null) continue;
      if (Math.abs(this.laneOf(c) - lane) >= sameLaneWidth) continue;
      const d = signedGap(car.index, c.index, n) * 2;
      if (d > 0 && d < bestDistance) {
        best = c;
        bestDistance = d;
      }
    }
    return best ? { other: best, distance: bestDistance } : null;
  }

  /** 車線変更中を含めた、今の横の位置 (0 = inner 〜 2 = outer) */
  private laneOf(car: TitleCar): number {
    return car.laneFrom + (car.laneTo - car.laneFrom) * smoothStep(car.laneT);
  }

  private updatePose(car: TitleCar): void {
    const { paths } = this;
    const n = paths.count;
    const i0 = Math.floor(car.index) % n;
    const i1 = (i0 + 1) % n;
    const f = car.index - Math.floor(car.index);
    const lane = this.laneOf(car);
    const l0 = Math.min(1, Math.floor(lane));
    const lf = lane - l0;
    const inner = paths.lanes[l0];
    const outer = paths.lanes[l0 + 1];
    const ax = inner[i0][0] + (inner[i1][0] - inner[i0][0]) * f;
    const ay = inner[i0][1] + (inner[i1][1] - inner[i0][1]) * f;
    const bx = outer[i0][0] + (outer[i1][0] - outer[i0][0]) * f;
    const by = outer[i0][1] + (outer[i1][1] - outer[i0][1]) * f;
    car.x = ax + (bx - ax) * lf;
    car.y = ay + (by - ay) * lf;
    let heading = lerpAngle(paths.heading[i0], paths.heading[i1], f);
    if (car.laneT < 1) {
      // 車線変更の向き: outer は進行方向の右 (時計回り) なので、outer へ移るときは正
      const lateralPerPoint = ((car.laneTo - car.laneFrom) * smoothStepSlope(car.laneT) * laneWidthDots) / car.lanePoints;
      heading += Math.atan2(lateralPerPoint, 2);
    }
    car.heading = heading;
  }

  /** コーナー進入 (speedFactor が下がっていく区間) と車線変更中に、後輪 2 点の跡を残す */
  private addSkidMarks(car: TitleCar, i: number, movedDots: number): void {
    const sf = this.paths.speedFactor;
    const n = this.paths.count;
    const isBrakingZone = sf[i] < sf[(i - 1 + n) % n];
    if (!isBrakingZone && car.laneT >= 1) {
      car.isMarking = false;
      return;
    }
    if (!car.isMarking) {
      // 毎回は残さない (どの車も同じ場所に跡を付けると単調になる)
      car.isMarking = Math.random() < 0.5;
      car.markDistance = 0;
      if (!car.isMarking) return;
    }
    car.markDistance += movedDots;
    if (car.markDistance < 1) return;
    car.markDistance = 0;
    const cos = Math.cos(car.heading);
    const sin = Math.sin(car.heading);
    for (const side of [-1, 1]) {
      const lx = side * rearWheelX;
      this.pushMark(car.x + lx * cos - rearWheelY * sin, car.y + lx * sin + rearWheelY * cos);
    }
  }

  private pushMark(x: number, y: number): void {
    this.marks[this.markHead * 2] = Math.round(x - 0.5);
    this.marks[this.markHead * 2 + 1] = Math.round(y - 0.5);
    this.markHead = (this.markHead + 1) % maxSkidMarks;
    this.markCount = Math.min(maxSkidMarks, this.markCount + 1);
  }

  /** 下のストレートで、x (ドット) の位置にあたる点の番号 */
  private indexForX(lane: number, x: number): number {
    const points = this.paths.lanes[lane];
    const n = this.paths.count;
    // 下のストレート (スタートラインの手前) は番号の終わり側にあり、x が番号とともに増える
    for (let k = n - 1; k > n / 2; k--) {
      const a = points[k - 1];
      const b = points[k];
      if (a[0] <= x && x <= b[0] && b[0] > a[0]) return k - 1 + (x - a[0]) / (b[0] - a[0]);
    }
    return 0;
  }
}

/** from から to までの前向きの差 (点の数)。半周より先は負 (後ろ) にする */
function signedGap(from: number, to: number, n: number): number {
  let d = (to - from) % n;
  if (d < 0) d += n;
  return d > n / 2 ? d - n : d;
}

/** before → after の移動で mark を通過したか (周回をまたぐ場合を含む) */
function hasPassed(before: number, after: number, mark: number, n: number): boolean {
  const d = signedGap(before, after, n);
  const m = signedGap(before, mark, n);
  return m > 0 && m <= d;
}

function approach(value: number, target: number, up: number, down: number): number {
  if (value < target) return Math.min(target, value + up);
  return Math.max(target, value - down);
}

function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

function smoothStepSlope(t: number): number {
  return 6 * t * (1 - t);
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
