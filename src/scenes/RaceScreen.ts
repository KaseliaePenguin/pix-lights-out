import { Camera } from '../core/Camera';
import type { Game } from '../core/Game';
import type { LoopSound } from '../core/LoopSound';
import { WorldLayer } from '../core/WorldLayer';
import { DriveSounds } from '../entities/DriveSounds';
import { OtherCarEngines } from '../entities/OtherCarEngines';
import type { OtherCarSource } from '../entities/OtherCarEngines';
import { Particles } from '../entities/Particles';
import { emitWheelEffects } from '../entities/wheelEffects';
import { drawCar, drawCarOnScreen, drawDrsWind } from '../render/drawCar';
import { TireMarks } from '../render/TireMarks';
import { TrackRenderer } from '../render/TrackRenderer';
import { wallImpactEffect } from '../shared/carEffects';
import type { ImpactEffect } from '../shared/carEffects';
import type { Controls } from '../shared/controls';
import type { RaceCar } from '../shared/RaceCar';
import type { RaceEvent, StandingsEntry } from '../shared/RaceSession';
import type { Track } from '../shared/Track';
import { toKmh } from '../shared/VirtualGearbox';
import { drawCarGapPanel } from '../ui/carGapPanel';
import { drawCarStatusPanel } from '../ui/carStatusPanel';
import { drawCheckpointArrow } from '../ui/checkpointArrow';
import { colors, teamColors } from '../ui/colors';
import { drawDebugPanel } from '../ui/debugPanel';
import type { DebugRow } from '../ui/debugPanel';
import { hudMessages } from '../ui/hudMessages';
import { MessageQueue } from '../ui/MessageQueue';
import type { MinimapCar } from '../ui/Minimap';
import { drawMessageBand } from '../ui/messageBand';
import { drawNameTag, isNameTagVisible } from '../ui/nameTag';
import type { NameTagVisibility } from '../ui/nameTag';
import { PositionChangeTracker } from '../ui/PositionChangeTracker';
import type { RaceGap } from '../ui/raceGap';
import { drawStandingsPanel } from '../ui/standingsPanel';
import type { StandingsRow } from '../ui/standingsPanel';
import { drawStartLamps } from '../ui/startLamps';
import type { LampImages } from '../ui/startLamps';
import { displayAbbr } from '../ui/teams';
import { drawText } from '../ui/text';
import { drawTimingPanel } from '../ui/timingPanel';
import { getCourseMinimap } from './courseCache';
import { applyCameraMode, followCar } from './driveCamera';
import { loadSettings } from './settingsStorage';

/**
 * 決勝の走行画面が読む状態。1 人用の RaceSession とオンラインの NetRaceClient の共通部分
 * (どちらも同じ名前で公開しているので、そのまま渡せる)
 */
export interface RaceScreenSource {
  readonly track: Track;
  readonly totalLaps: number;
  readonly cars: readonly RaceCar[];
  readonly player: RaceCar | null;
  readonly orderNumbers: readonly number[];
  readonly phase: 'grid' | 'racing' | 'finished' | 'aborted';
  readonly litLamps: number;
  readonly raceTime: number;
  readonly leaderLap: number;
  readonly fastestLap: number | null;
  carByNumber(carNumber: number): RaceCar | null;
  standings(out: StandingsEntry[]): StandingsEntry[];
  isResetAvailable(rc: RaceCar): boolean;
  isGhostPair(a: number, b: number): boolean;
}

/** 車の呼び方と、コース上に描くか (オンラインは名前で呼び、抜けた車を描かない) */
export interface RaceScreenLabels {
  /** 名前タグの車番の後ろ (1 人用は略称、自車は YOU) */
  nameTagOf(rc: RaceCar): string;
  /** 順位表・FASTEST LAP の 3 文字 */
  abbrOf(carNumber: number, isPlayer: boolean): string;
  /** false の車は描かない・鳴らさない (省略時はすべて描く) */
  isOnTrack?(rc: RaceCar): boolean;
}

export const singleRaceLabels: RaceScreenLabels = {
  nameTagOf: (rc) => displayAbbr(rc.carNumber, rc.isPlayer),
  abbrOf: (carNumber, isPlayer) => displayAbbr(carNumber, isPlayer),
};

/** ゴースト中の点滅: 0.125 秒ごとに通常表示とシャドウ表示を入れ替える (style-guide.md §2) */
const blinkInterval = 0.125;
/** カメラを回転するときのワールド層の大きさ (ドット)。TimeAttackScene と同じ */
const rotatedLayerSize = 504;
/** 消灯のあと、消えたランプを出しておく時間 (秒) */
const lampsAfterStartTime = 1.5;
/** 他車の衝突音が聞こえる距離 (自車から、px)。遠いほど小さくする */
const hearingDistance = 600;
/** 名前タグを描く範囲 (画面の外側の余裕、px) */
const nameTagMargin = 48;

interface CarSprites {
  normal: HTMLImageElement | null;
  shadow: HTMLImageElement | null;
}

/**
 * 決勝の走行画面の描画・HUD・効果音・演出 (RaceScene とオンラインの NetRaceScene で共用)。
 * レースの進め方 (step、ポーズ、リザルトへの遷移) は持たず、シーンが step の結果のイベントを handleEvent に渡す。
 *
 * ```ts
 * const screen = new RaceScreen(game, singleRaceLabels);
 * screen.build(track);                       // LOADING を出したあとの更新で (重い)
 * screen.start(session);                     // グリッドに並んだとき (リスタートでも)
 * for (const e of session.step(controls, dt)) screen.handleEvent(e);
 * screen.update(dt, controls, isGamepad);
 * screen.render(ctx);
 * screen.stopSounds();                       // 画面を抜けるとき
 * ```
 */
export class RaceScreen {
  readonly messages = new MessageQueue();
  readonly camera = new Camera();

  private source: RaceScreenSource | null = null;
  private renderer: TrackRenderer | null = null;
  private marks: TireMarks | null = null;
  private readonly fixedLayer = new WorldLayer();
  private readonly rotatedLayer = new WorldLayer(rotatedLayerSize, rotatedLayerSize);
  private readonly screenPoint = { x: 0, y: 0 };
  private readonly wheel = { x: 0, y: 0 };
  private readonly particles = new Particles();
  private readonly positions = new PositionChangeTracker();
  private readonly impact: ImpactEffect = { sound: null, volume: 0, shake: 0, sparks: 0 };
  private readonly minimapCars: MinimapCar[] = [];
  private readonly standingsEntries: StandingsEntry[] = [];
  private readonly standingsRows: StandingsRow[] = [];
  private readonly engineSources: OtherCarSource[] = [];
  /** 車番 → スプライト */
  private readonly sprites = new Map<number, CarSprites>();
  private readonly lampImages: LampImages | null;
  /** 描く順番 (シャドウ表示 → 通常表示 → 自車) に並べた車と、シャドウ表示にするか。毎フレーム作り直す */
  private readonly drawList: { rc: RaceCar; isShadow: boolean }[] = [];

  private sounds: DriveSounds | null = null;
  private otherEngines: OtherCarEngines | null = null;
  private slipstreamSound: LoopSound | null = null;
  private nameTags: NameTagVisibility;
  private isDebugVisible = false;
  private time = 0;
  private isPlayerFinished = false;
  private wasGridThrottle = false;

  constructor(
    private readonly game: Game,
    private readonly labels: RaceScreenLabels,
  ) {
    const settings = loadSettings();
    this.nameTags = settings.nameTags;
    this.camera.shakeEnabled = settings.screenShake;
    applyCameraMode(this.camera, settings.cameraMode, null);
    const { assets } = game;
    const lampOn = assets.getImage('ui-lamp-on');
    const lampOff = assets.getImage('ui-lamp-off');
    this.lampImages = lampOn && lampOff ? { on: lampOn, off: lampOff } : null;
    for (let n = 1; n <= 8; n++) {
      const name = `car-team-${String(n).padStart(2, '0')}`;
      // チームの画像がなければ基準車 (赤) で代用する
      this.sprites.set(n, {
        normal: assets.getImage(name) ?? assets.getImage('car-base'),
        shadow: assets.getImage(`${name}-ghost`) ?? assets.getImage('car-base-ghost'),
      });
    }
  }

  get isBuilt(): boolean {
    return this.renderer !== null;
  }

  private get layer(): WorldLayer {
    return this.camera.rotation === 'fixed' ? this.fixedLayer : this.rotatedLayer;
  }

  /** コースの絵とループ音を作る (重いので LOADING を出してから呼ぶ) */
  build(track: Track): void {
    this.renderer = new TrackRenderer(track, this.game.assets);
    this.marks = new TireMarks(track);
    this.sounds = new DriveSounds(this.game.audio);
    this.otherEngines = new OtherCarEngines(this.game.audio);
    this.slipstreamSound = this.game.audio.createLoop('slipstream-wind-loop');
  }

  /** グリッドに並んだ状態から表示を始める (最初とリスタート) */
  start(source: RaceScreenSource): void {
    this.source = source;
    const player = source.player;
    this.marks?.clear();
    this.particles.clear();
    this.messages.clear();
    this.positions.reset(source.orderNumbers);
    this.isPlayerFinished = false;
    this.wasGridThrottle = false;
    this.time = 0;
    if (player) {
      this.renderer?.prepare(player.car.x, player.car.y);
      this.camera.snapTo(player.car.x, player.car.y, player.car.heading);
    }
  }

  /** 設定画面を閉じたあとに呼ぶ (名前タグ・画面揺れ・カメラ) */
  applySettings(): void {
    const settings = loadSettings();
    this.nameTags = settings.nameTags;
    this.camera.shakeEnabled = settings.screenShake;
    applyCameraMode(this.camera, settings.cameraMode, this.source?.player?.car ?? null);
  }

  /** step のあとに 1 フレーム進める。isGamepad は PRESS Y TO RESET の出し分け */
  update(dt: number, controls: Readonly<Controls>, isGamepad: boolean): void {
    const source = this.source;
    const player = source?.player;
    if (!source || !player) return;
    if (this.game.input.wasPressed('F3')) this.isDebugVisible = !this.isDebugVisible;
    this.time += dt;
    this.positions.update(dt, source.orderNumbers);
    if (source.phase === 'racing' && this.positions.hasChangedNow(player.carNumber)) this.game.audio.playSe('position-change');
    followCar(this.camera, player.car, dt);
    this.updateStatusMessages(source, player, isGamepad);
    this.messages.update(dt);
    this.updateEffects(source, player, dt);
    this.updateSounds(source, player, controls);
  }

  stopSounds(): void {
    this.sounds?.stop();
    this.sounds = null;
    this.otherEngines?.stop();
    this.otherEngines = null;
    this.slipstreamSound?.stop();
    this.slipstreamSound = null;
  }

  // ---- イベント ----

  /** step が返したイベントの音とメッセージ。自分のゴールでは true を返す (シーンがリザルトへの時間を数える) */
  handleEvent(e: RaceEvent): boolean {
    const audio = this.game.audio;
    const source = this.source;
    const player = source?.player;
    if (!source || !player) return false;
    const isMine = 'carNumber' in e && e.carNumber === player.carNumber;
    switch (e.type) {
      case 'lampOn':
        audio.playSe('start-light-on');
        break;
      case 'lightsOut':
        audio.playSe('start-go');
        audio.playBgm('race-theme', 0.05);
        break;
      case 'jumpStart':
        if (isMine) {
          audio.playSe('false-start');
          this.messages.push(hudMessages.jumpStart());
        }
        break;
      case 'reaction':
        if (isMine) this.messages.push(hudMessages.reaction(e.time));
        break;
      case 'lap':
        if (isMine && e.event.type === 'wrongWayStarted') audio.playSe('ui-error');
        break;
      case 'sectorResult':
        if (!isMine) break;
        if (e.result === 'overall' || e.result === 'personal') audio.playSe('sector-best');
        else if (e.result === 'slower') audio.playSe('sector-time');
        break;
      case 'lapResult':
        // ゴールした周はジングルを鳴らすので、周回の音は鳴らさない
        if (isMine && player.status === 'racing') audio.playSe('lap-complete');
        break;
      case 'fastestLap': {
        const rc = source.carByNumber(e.carNumber);
        this.messages.push(hudMessages.fastestLap(this.labels.abbrOf(e.carNumber, rc?.isPlayer ?? false), e.time));
        audio.playSe('sector-best');
        break;
      }
      case 'finalLap':
        this.messages.push(hudMessages.finalLap());
        audio.playSe('final-lap');
        break;
      case 'carFinished':
        if (isMine) return this.onPlayerFinished(e.position);
        break;
      case 'contact':
        this.onContact(source, player, e.carA, e.carB, e.impact, e.x, e.y);
        break;
      case 'blueFlag':
        if (isMine) this.messages.push(hudMessages.blueFlag());
        break;
      case 'drsAvailable':
        if (isMine) audio.playSe('drs-available');
        break;
      case 'drsEnabled':
        if (isMine) this.messages.push(hudMessages.drsEnabled());
        break;
      case 'drsOpened':
        if (isMine) audio.playSe('drs-open');
        break;
      case 'drsClosed':
        if (isMine) audio.playSe('drs-close');
        break;
      case 'resetRejected':
        if (isMine) audio.playSe('ui-error');
        break;
      case 'resetPlaced':
        // 置き直したときは、向きもすぐに合わせる (回転する表示で画面が大きく回らないように)
        if (isMine) this.camera.snapTo(player.car.x, player.car.y, player.car.heading);
        break;
      case 'resetFinished':
        if (isMine) this.messages.setStatus('reset', null);
        break;
      default:
        break;
    }
    return false;
  }

  private onPlayerFinished(position: number): boolean {
    if (this.isPlayerFinished) return false;
    this.isPlayerFinished = true;
    const audio = this.game.audio;
    this.messages.push(hudMessages.finish(position));
    audio.stopBgm(0.5);
    audio.playSe(position === 1 ? 'win-jingle' : 'finish-jingle');
    return true;
  }

  /** 車同士の接触: 火花 (J 50 以上)、crash-car、自車が当たったときだけ画面揺れ (J 187.5 以上) */
  private onContact(source: RaceScreenSource, player: RaceCar, carA: number, carB: number, impact: number, x: number, y: number): void {
    const a = source.carByNumber(carA);
    const b = source.carByNumber(carB);
    const effect = wallImpactEffect(impact, this.impact);
    if (effect.sparks > 0) {
      const vx = ((a?.car.vx ?? 0) + (b?.car.vx ?? 0)) / 2;
      const vy = ((a?.car.vy ?? 0) + (b?.car.vy ?? 0)) / 2;
      this.particles.emitSparks(x, y, effect.sparks, vx, vy);
    }
    if (effect.sound === null) return;
    const isMine = carA === player.carNumber || carB === player.carNumber;
    const volume = effect.volume * (isMine ? 1 : hearingFactor(player, x, y));
    if (volume > 0) this.game.audio.playSe('crash-car', volume);
    if (isMine && effect.shake > 0) this.camera.shake(effect.shake);
  }

  /** 状態が続く間だけ出すメッセージ (10.2 節の優先度 1 と RESET のカウント)。ゴール・リタイア後は出さない */
  private updateStatusMessages(source: RaceScreenSource, player: RaceCar, isGamepad: boolean): void {
    const m = this.messages;
    const isRacing = player.status === 'racing' && source.phase !== 'aborted';
    const lap = player.lap;
    m.setStatus('wrongWay', isRacing && lap.isWrongWay ? hudMessages.wrongWay() : null);
    m.setStatus('missedCheckpoint', isRacing && lap.isCheckpointMissed ? hudMessages.missedCheckpoint() : null);
    // 踏んだまま消灯して発進できない間は、復帰より「離して踏み直す」を知らせる
    const canReset = isRacing && !player.isLaunchBlocked && source.isResetAvailable(player);
    m.setStatus('canReset', canReset ? hudMessages.pressToReset(isGamepad) : null);
    // 置き直したあとの操作不能の間だけカウントを出す (暗転中は出さない)
    const isCounting = isRacing && player.resetLockRemaining > 0 && player.screenFade < 1 && player.car.controlLocked;
    m.setStatus('reset', isCounting ? hudMessages.resetCount(player.resetLockRemaining) : null);
    m.setStatus('launchBlocked', isRacing && player.isLaunchBlocked ? hudMessages.liftOff() : null);
  }

  // ---- 演出 ----

  private isOnTrack(rc: RaceCar): boolean {
    return this.labels.isOnTrack?.(rc) ?? true;
  }

  private updateEffects(source: RaceScreenSource, player: RaceCar, dt: number): void {
    const marks = this.marks;
    if (!marks) return;
    marks.update(dt);
    const audio = this.game.audio;
    for (const rc of source.cars) {
      if (!this.isOnTrack(rc)) continue;
      const car = rc.car;
      emitWheelEffects(car, marks, this.particles, this.wheel);
      const isMine = rc === player;
      if (isMine && car.lockupStarted) audio.playSe('tire-lockup');
      // 壁との衝突: 火花は全車、音は距離で小さく、画面揺れは自車だけ
      if (car.wallImpact > 0) {
        const effect = wallImpactEffect(car.wallImpact, this.impact);
        if (effect.sparks > 0) this.particles.emitSparks(car.wallImpactX, car.wallImpactY, effect.sparks, car.vx, car.vy);
        if (effect.sound) {
          const volume = effect.volume * (isMine ? 1 : hearingFactor(player, car.x, car.y));
          if (volume > 0) audio.playSe(effect.sound, volume);
        }
        if (isMine && effect.shake > 0) this.camera.shake(effect.shake);
      }
    }
    this.particles.update(dt);
  }

  // ---- 音 ----

  private updateSounds(source: RaceScreenSource, player: RaceCar, controls: Readonly<Controls>): void {
    if (!this.sounds) return;
    const car = player.car;
    const throttle = car.controlLocked || controls.brake > 0 ? 0 : controls.throttle;
    this.sounds.update(car, player.gearbox, throttle);
    this.slipstreamSound?.set(car.fSlip);
    if (player.gearbox.shiftedUp) this.game.audio.playSe('gear-shift');
    // グリッドでアクセルを踏んだ瞬間の空ぶかし (消灯まで車は動かない。踏んだまま消灯すると、離して踏み直すまで発進できない)
    const isGridThrottle = source.phase === 'grid' && controls.throttle > 0;
    if (isGridThrottle && !this.wasGridThrottle) this.game.audio.playSe('engine-rev');
    this.wasGridThrottle = isGridThrottle;

    // 他車のエンジン (近い 4 台、600 px で 0)
    const sources = this.engineSources;
    let n = 0;
    for (const rc of source.cars) {
      if (rc === player || !this.isOnTrack(rc) || rc.status === 'retired') continue;
      if (n >= sources.length) sources.push({ id: 0, car: rc.car, throttle: 0 });
      const s = sources[n++];
      s.id = rc.carNumber;
      s.car = rc.car;
      s.throttle = rc.controls.brake > 0 ? 0 : rc.controls.throttle;
    }
    sources.length = n;
    this.otherEngines?.update(car, sources);
  }

  // ---- 描画 ----

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    const source = this.source;
    const player = source?.player;
    if (!source || !player || !this.renderer || !this.marks) {
      ctx.fillStyle = colors.base;
      ctx.fillRect(0, 0, width, height);
      drawText(ctx, 'LOADING COURSE', width / 2, height / 2 - 8, { color: colors.text, align: 'center' });
      return;
    }
    const layer = this.layer;
    const isRotated = this.camera.rotation !== 'fixed';
    if (isRotated) layer.setCamera(this.camera.x, this.camera.y, this.camera.renderAngle);
    else layer.setCamera(this.camera.renderX, this.camera.renderY);

    // ワールド層: コース → タイヤ痕 → 車 (シャドウ表示 → 通常表示 → 自車) → エフェクト
    this.renderer.render(layer);
    this.marks.render(layer);
    this.buildDrawList(source, player);
    if (!isRotated) {
      for (const { rc, isShadow } of this.drawList) drawCar(layer, this.spriteOf(rc, isShadow), rc.car.x, rc.car.y, rc.car.drawHeading);
    }
    for (const { rc } of this.drawList) {
      if (rc.car.drsOpen && layer.isVisible(rc.car.x, rc.car.y)) drawDrsWind(layer, rc.car, this.time, this.wheel);
    }
    this.particles.render(layer);
    let shakeX = 0;
    let shakeY = 0;
    if (isRotated) {
      // 回転する表示: 画面揺れは回転後の画面にかけ、車は画面に直接描く (TimeAttackScene と同じ)
      shakeX = this.camera.shakeX;
      shakeY = this.camera.shakeY;
      layer.present(ctx, shakeX, shakeY);
      for (const { rc, isShadow } of this.drawList) {
        const p = layer.worldToScreen(rc.car.x, rc.car.y, this.screenPoint);
        drawCarOnScreen(ctx, this.spriteOf(rc, isShadow), p.x + shakeX, p.y + shakeY, layer.toScreenAngle(rc.car.drawHeading));
      }
    } else {
      layer.present(ctx);
    }
    this.renderNameTags(ctx, player, shakeX, shakeY);

    // コース復帰の暗転 (HUD の手前まで)。4 段階で暗くする
    if (player.screenFade > 0) {
      ctx.save();
      ctx.globalAlpha = Math.ceil(player.screenFade * 4) / 4;
      ctx.fillStyle = colors.ink;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    this.renderHud(ctx, source, player);
  }

  /** シャドウ表示 (ゴースト) にするか。画面を見ている自車から見た判定 (style-guide.md §2) */
  private isShadow(source: RaceScreenSource, player: RaceCar, rc: RaceCar): boolean {
    if (rc.isGhostBlinking) return Math.floor(rc.ghostBlinkTime / blinkInterval) % 2 === 0;
    if (rc === player) return false;
    // ゴールしたあとは、自車との関係ではなくその車自身の状態で見せる (全車がシャドウになるのを避ける)
    if (player.status !== 'racing') return rc.isGhost;
    return source.isGhostPair(player.index, rc.index);
  }

  private buildDrawList(source: RaceScreenSource, player: RaceCar): void {
    const list = this.drawList;
    list.length = 0;
    for (const rc of source.cars) {
      if (rc !== player && this.isOnTrack(rc)) list.push({ rc, isShadow: this.isShadow(source, player, rc) });
    }
    // シャドウ表示を先に (重なったとき実体のある車を上にする)。自車は最後
    list.sort((p, q) => Number(q.isShadow) - Number(p.isShadow));
    list.push({ rc: player, isShadow: this.isShadow(source, player, player) });
  }

  private spriteOf(rc: RaceCar, isShadow: boolean): HTMLImageElement | null {
    const sprites = this.sprites.get(rc.carNumber);
    if (!sprites) return null;
    return isShadow ? sprites.shadow : sprites.normal;
  }

  private renderNameTags(ctx: CanvasRenderingContext2D, player: RaceCar, shakeX: number, shakeY: number): void {
    if (this.nameTags === 'off') return;
    const layer = this.layer;
    const { width, height } = this.game;
    // 自車のタグを最後に (一番上に) 描く
    for (const { rc } of this.drawList) {
      const isSelf = rc === player;
      if (!isNameTagVisible(this.nameTags, isSelf)) continue;
      let x: number;
      let y: number;
      if (layer.isRotated) {
        const p = layer.worldToScreen(rc.car.x, rc.car.y, this.screenPoint);
        x = p.x + shakeX;
        y = p.y + shakeY;
      } else {
        x = layer.screenX(rc.car.x);
        y = layer.screenY(rc.car.y);
      }
      if (x < -nameTagMargin || x > width + nameTagMargin || y < -nameTagMargin || y > height + nameTagMargin) continue;
      drawNameTag(ctx, x, y, rc.carNumber, this.labels.nameTagOf(rc), isSelf);
    }
  }

  private renderHud(ctx: CanvasRenderingContext2D, source: RaceScreenSource, player: RaceCar): void {
    // 順位表 (左上)
    const rows = this.standingsRows;
    const entries = source.standings(this.standingsEntries);
    entries.forEach((e, i) => {
      if (i >= rows.length) rows.push({ carNumber: 0, abbr: '', gap: e.gap, isSelf: false, hasFastestLap: false, change: null });
      const row = rows[i];
      row.carNumber = e.carNumber;
      row.abbr = this.labels.abbrOf(e.carNumber, e.isPlayer);
      row.gap = e.gap;
      row.isSelf = e.isPlayer;
      row.hasFastestLap = e.hasFastestLap;
      row.change = this.positions.changeOf(e.carNumber);
    });
    rows.length = entries.length;
    drawStandingsPanel(ctx, { lap: source.leaderLap, totalLaps: source.totalLaps, rows });

    // タイム (右上): 決勝では自分のセッション内のタイム。BEST は全体ベストなら紫、それ以外は緑
    const isStarted = source.phase !== 'grid';
    const hasLap = isStarted && player.lap.lap > 0;
    drawTimingPanel(ctx, {
      currentLapTime: isStarted ? player.currentLapTime : null,
      isCurrentLapInvalid: hasLap && !player.lap.lapValid,
      sectors: player.sectorResults,
      bestLapTime: player.bestLap,
      bestLapResult: player.bestLap !== null && player.bestLap === source.fastestLap ? 'overall' : 'personal',
      lastLapTime: player.lastLap,
      lastLapResult: player.lastLapResult,
      isLastLapInvalid: player.lastLap !== null && player.lastLapResult === 'none',
    });

    if (!isStarted || source.raceTime < lampsAfterStartTime) drawStartLamps(ctx, source.litLamps, 276, 12, this.lampImages);
    drawMessageBand(ctx, this.messages.getDisplay());

    const car = player.car;
    drawCarStatusPanel(ctx, {
      speedKmh: toKmh(car.speed),
      gear: car.isReversing ? 'R' : player.gearbox.gear,
      drs: player.drs.indicator(car),
    });
    // 前後の車との差 (下中央)。スタート前と、前後に車がいないときは ---
    const ahead = isStarted && player.position > 1 ? toPanelGap(player.gapToAhead) : null;
    const behind = isStarted ? toPanelGap(player.gapToBehind) : null;
    drawCarGapPanel(ctx, ahead, behind);

    if (player.lap.isCheckpointMissed && player.status === 'racing') {
      const gate = source.track.checkpoints[player.lap.nextCheckpoint];
      const angle = Math.atan2((gate.ay + gate.by) / 2 - car.y, (gate.ax + gate.bx) / 2 - car.x) - this.camera.renderAngle;
      drawCheckpointArrow(ctx, angle);
    }

    // ミニマップ (左下): 全車。シャドウ表示の車はゴーストの印で
    this.minimapCars.length = 0;
    for (const { rc, isShadow } of this.drawList) {
      this.minimapCars.push({ x: rc.car.x, y: rc.car.y, color: teamColors[rc.carNumber], isSelf: rc === player, isGhost: isShadow && rc !== player });
    }
    getCourseMinimap().draw(ctx, this.minimapCars);

    if (this.isDebugVisible) drawDebugPanel(ctx, this.debugRows(source, player));
  }

  private debugRows(source: RaceScreenSource, player: RaceCar): DebugRow[] {
    const car = player.car;
    const surfaces = car.wheelSurfaces.map((s) => s.slice(0, 2).toUpperCase()).join(' ');
    return [
      ['SPEED', `${Math.round(car.speed)} PX/S`],
      ['GRIP USE', car.uReq.toFixed(2)],
      ['GRIP MUL', car.grip.toFixed(2)],
      ['SURFACE', surfaces],
      ['SLIP', car.fSlip.toFixed(2)],
      ['DRS', car.fDrs.toFixed(2)],
      ['POS', `${player.position}/${source.cars.length}`],
      ['DIST', `${Math.round(player.distance)}`],
      ['TIME', source.raceTime.toFixed(2)],
    ];
  }
}

/** 自車からの距離による音量の倍率 (1 → 0) */
function hearingFactor(player: RaceCar, x: number, y: number): number {
  const d = Math.hypot(x - player.car.x, y - player.car.y);
  return Math.max(0, 1 - d / hearingDistance);
}

/** 前後の車との差のパネル用: 先頭 (leader) と「後ろなし」は --- で出す */
function toPanelGap(gap: RaceGap | null): RaceGap | null {
  if (gap === null || gap.kind === 'leader') return null;
  return gap;
}
