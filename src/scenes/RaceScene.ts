import { Camera } from '../core/Camera';
import { ControlsReader } from '../core/ControlsReader';
import type { Game } from '../core/Game';
import type { LoopSound } from '../core/LoopSound';
import type { Scene } from '../core/Scene';
import { WorldLayer } from '../core/WorldLayer';
import { DriveSounds } from '../entities/DriveSounds';
import { Particles } from '../entities/Particles';
import { emitWheelEffects } from '../entities/wheelEffects';
import { drawCar, drawCarOnScreen, drawDrsWind } from '../render/drawCar';
import { TireMarks } from '../render/TireMarks';
import { TrackRenderer } from '../render/TrackRenderer';
import { wallImpactEffect } from '../shared/carEffects';
import type { ImpactEffect } from '../shared/carEffects';
import { createControls } from '../shared/controls';
import type { RaceCar } from '../shared/RaceCar';
import { RaceSession } from '../shared/RaceSession';
import type { RaceEvent, StandingsEntry } from '../shared/RaceSession';
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
import { getCourseMinimap, getCourseRacingLine, getCourseTrack } from './courseCache';
import { applyCameraMode, followCar } from './driveCamera';
import { MenuScene } from './MenuScene';
import { PauseScene } from './PauseScene';
import type { RaceSetup } from './raceSetup';
import { ResultScene } from './ResultScene';
import { loadSettings } from './settingsStorage';

/** ゴースト中の点滅: 0.125 秒ごとに通常表示とシャドウ表示を入れ替える (style-guide.md §2) */
const blinkInterval = 0.125;
/** カメラを回転するときのワールド層の大きさ (ドット)。TimeAttackScene と同じ */
const rotatedLayerSize = 504;
/** 自分のゴールからリザルトへ進むまで (秒、game-design.md 10.2 節) */
const finishToResultTime = 3;
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
 * 決勝の走行画面 (game-design.md 7 章・10 章、12 章 M2)。
 * グリッド → スタートランプ → 消灯 → レース → チェッカー → リザルト。
 * 最初のフレームで「LOADING」を描いてから、次の更新でコースと CPU のレーシングラインを作る (作る間は画面が止まるため)。
 */
export class RaceScene implements Scene {
  private session: RaceSession | null = null;
  private renderer: TrackRenderer | null = null;
  private marks: TireMarks | null = null;
  private loadingUpdates = 0;

  private readonly fixedLayer = new WorldLayer();
  private readonly rotatedLayer = new WorldLayer(rotatedLayerSize, rotatedLayerSize);
  private readonly camera = new Camera();
  private readonly screenPoint = { x: 0, y: 0 };
  private readonly wheel = { x: 0, y: 0 };
  private readonly reader: ControlsReader;
  private readonly controls = createControls();
  private readonly messages = new MessageQueue();
  private readonly particles = new Particles();
  private readonly positions = new PositionChangeTracker();
  private readonly impact: ImpactEffect = { sound: null, volume: 0, shake: 0, sparks: 0 };
  private readonly minimapCars: MinimapCar[] = [];
  private readonly standingsEntries: StandingsEntry[] = [];
  private readonly standingsRows: StandingsRow[] = [];
  /** 車番 → スプライト */
  private readonly sprites = new Map<number, CarSprites>();
  private readonly lampImages: LampImages | null;
  /** 描く順番 (シャドウ表示 → 通常表示 → 自車) に並べた車と、シャドウ表示にするか。毎フレーム作り直す */
  private readonly drawList: { rc: RaceCar; isShadow: boolean }[] = [];
  /** 車ごと (cars の番号) の点滅の経過秒。点滅していない間は 0 */

  private sounds: DriveSounds | null = null;
  private slipstreamSound: LoopSound | null = null;
  private pause: PauseScene | null = null;
  private isDebugVisible = false;
  private nameTags: NameTagVisibility;
  private time = 0;
  /** 自分がゴールしてからリザルトへ進むまでの残り秒 (まだなら負) */
  private finishTimer = -1;
  private isPlayerFinished = false;
  private wasGridThrottle = false;

  constructor(
    private readonly game: Game,
    private readonly setup: Readonly<RaceSetup>,
    private readonly seed: number,
  ) {
    this.reader = ControlsReader.withKeyboard(game.input);
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

  private get layer(): WorldLayer {
    return this.camera.rotation === 'fixed' ? this.fixedLayer : this.rotatedLayer;
  }

  private get player(): RaceCar | null {
    return this.session?.player ?? null;
  }

  enter(): void {
    // グリッドに並んだ時点で BGM を止め、消灯と同時にレースの曲を頭から流す (game-design.md 7.2 節)
    this.game.audio.stopBgm(0.3);
  }

  exit(): void {
    this.stopDriveSounds();
    if (this.game.audio.isPaused) this.game.audio.resume({ resumeBgm: false });
  }

  update(dt: number): void {
    if (!this.session) {
      this.loadingUpdates++;
      if (this.loadingUpdates >= 2) this.build();
      return;
    }
    const session = this.session;
    const player = session.player;
    if (!player) return;
    const { input } = this.game;
    if (this.pause) {
      this.pause.update(dt);
      return;
    }
    if (this.finishTimer >= 0) {
      this.finishTimer -= dt;
      if (this.finishTimer <= 0) {
        this.goToResults();
        return;
      }
    } else if (input.wasPressed('Escape') || input.wasBlurred()) {
      // ゴール後 (リザルトへ進むまでの 3 秒) はポーズしない
      this.openPause();
      return;
    }
    if (input.wasPressed('F3')) this.isDebugVisible = !this.isDebugVisible;

    this.time += dt;
    this.reader.read(this.controls);
    for (const e of session.step(this.controls, dt)) this.handleEvent(e);

    this.positions.update(dt, session.orderNumbers);
    if (session.phase === 'racing' && this.positions.hasChangedNow(player.carNumber)) this.game.audio.playSe('position-change');

    followCar(this.camera, player.car, dt);
    this.updateStatusMessages();
    this.messages.update(dt);
    this.updateEffects(dt);
    this.updateSounds();
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    const session = this.session;
    const player = this.player;
    if (!session || !player || !this.renderer || !this.marks) {
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
    this.buildDrawList(session, player);
    if (!isRotated) {
      for (const { rc, isShadow } of this.drawList) drawCar(layer, this.spriteOf(rc, isShadow), rc.car.x, rc.car.y, rc.car.drawHeading);
    }
    for (const rc of session.cars) {
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

    this.renderHud(ctx, session, player);
    this.pause?.render(ctx);
  }

  // ---- 準備 ----

  private build(): void {
    const track = getCourseTrack();
    // CPU のレーシングラインも、ここで (LOADING を出している間に) 作っておく
    getCourseRacingLine();
    this.renderer = new TrackRenderer(track, this.game.assets);
    this.marks = new TireMarks(track);
    this.sounds = new DriveSounds(this.game.audio);
    this.slipstreamSound = this.game.audio.createLoop('slipstream-wind-loop');
    this.startRace();
  }

  /** グリッドからやり直す (最初とリスタート)。同じ seed なので、グリッドと CPU は同じになる */
  private startRace(): void {
    const session = new RaceSession({
      track: getCourseTrack(),
      totalLaps: this.setup.totalLaps,
      playerCarNumber: this.setup.carNumber,
      cpuCount: this.setup.cpuCount,
      difficulty: this.setup.difficulty,
      seed: this.seed,
      racingLine: getCourseRacingLine(),
    });
    this.session = session;
    const player = session.player;
    this.marks?.clear();
    this.particles.clear();
    this.messages.clear();
    this.positions.reset(session.orderNumbers);
    this.finishTimer = -1;
    this.isPlayerFinished = false;
    this.wasGridThrottle = false;
    this.time = 0;
    if (player) {
      this.renderer?.prepare(player.car.x, player.car.y);
      this.camera.snapTo(player.car.x, player.car.y, player.car.heading);
    }
    this.game.audio.stopBgm(0.3);
    // コースの生成などで止まっていた時間をまとめて進めない (スタートランプが早く進まないように)
    this.game.resetClock();
  }

  private goToResults(): void {
    const session = this.session;
    if (!session) return;
    const game = this.game;
    game.changeScene(new ResultScene(game, session.results, this.setup));
  }

  // ---- イベント・状態 ----

  private handleEvent(e: RaceEvent): void {
    const audio = this.game.audio;
    const session = this.session;
    const player = this.player;
    if (!session || !player) return;
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
        const rc = session.carByNumber(e.carNumber);
        this.messages.push(hudMessages.fastestLap(displayAbbr(e.carNumber, rc?.isPlayer ?? false), e.time));
        audio.playSe('sector-best');
        break;
      }
      case 'finalLap':
        this.messages.push(hudMessages.finalLap());
        audio.playSe('final-lap');
        break;
      case 'carFinished':
        if (isMine) this.onPlayerFinished(e.position);
        break;
      case 'raceFinished':
        if (this.finishTimer < 0) this.finishTimer = finishToResultTime;
        break;
      case 'contact':
        this.onContact(e.carA, e.carB, e.impact, e.x, e.y);
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
  }

  private onPlayerFinished(position: number): void {
    if (this.isPlayerFinished) return;
    this.isPlayerFinished = true;
    const audio = this.game.audio;
    this.messages.push(hudMessages.finish(position));
    audio.stopBgm(0.5);
    audio.playSe(position === 1 ? 'win-jingle' : 'finish-jingle');
    this.finishTimer = finishToResultTime;
  }

  /** 車同士の接触: 火花 (J 50 以上)、crash-car、自車が当たったときだけ画面揺れ (J 187.5 以上) */
  private onContact(carA: number, carB: number, impact: number, x: number, y: number): void {
    const session = this.session;
    const player = this.player;
    if (!session || !player) return;
    const a = session.carByNumber(carA);
    const b = session.carByNumber(carB);
    const effect = wallImpactEffect(impact, this.impact);
    if (effect.sparks > 0) {
      const vx = ((a?.car.vx ?? 0) + (b?.car.vx ?? 0)) / 2;
      const vy = ((a?.car.vy ?? 0) + (b?.car.vy ?? 0)) / 2;
      this.particles.emitSparks(x, y, effect.sparks, vx, vy);
    }
    if (effect.sound === null) return;
    const isMine = carA === player.carNumber || carB === player.carNumber;
    const volume = effect.volume * (isMine ? 1 : this.hearingFactor(x, y));
    if (volume > 0) this.game.audio.playSe('crash-car', volume);
    if (isMine && effect.shake > 0) this.camera.shake(effect.shake);
  }

  /** 自車からの距離による音量の倍率 (1 → 0) */
  private hearingFactor(x: number, y: number): number {
    const player = this.player;
    if (!player) return 0;
    const d = Math.hypot(x - player.car.x, y - player.car.y);
    return Math.max(0, 1 - d / hearingDistance);
  }

  /** 状態が続く間だけ出すメッセージ (10.2 節の優先度 1 と RESET のカウント)。ゴール・リタイア後は出さない */
  private updateStatusMessages(): void {
    const session = this.session;
    const player = this.player;
    if (!session || !player) return;
    const m = this.messages;
    const isRacing = player.status === 'racing';
    const lap = player.lap;
    m.setStatus('wrongWay', isRacing && lap.isWrongWay ? hudMessages.wrongWay() : null);
    m.setStatus('missedCheckpoint', isRacing && lap.isCheckpointMissed ? hudMessages.missedCheckpoint() : null);
    const canReset = isRacing && session.isResetAvailable(player);
    m.setStatus('canReset', canReset ? hudMessages.pressToReset(this.reader.lastUsedKind === 'gamepad') : null);
    // 置き直したあとの操作不能の間だけカウントを出す (暗転中は出さない)
    const isCounting = isRacing && player.resetLockRemaining > 0 && player.screenFade < 1 && player.car.controlLocked;
    m.setStatus('reset', isCounting ? hudMessages.resetCount(player.resetLockRemaining) : null);
  }

  // ---- 演出 ----

  private updateEffects(dt: number): void {
    const session = this.session;
    const player = this.player;
    const marks = this.marks;
    if (!session || !player || !marks) return;
    marks.update(dt);
    const audio = this.game.audio;
    for (const rc of session.cars) {
      const car = rc.car;
      emitWheelEffects(car, marks, this.particles, this.wheel);
      const isMine = rc === player;
      if (isMine && car.lockupStarted) audio.playSe('tire-lockup');
      // 壁との衝突: 火花は全車、音は距離で小さく、画面揺れは自車だけ
      if (car.wallImpact > 0) {
        const effect = wallImpactEffect(car.wallImpact, this.impact);
        if (effect.sparks > 0) this.particles.emitSparks(car.wallImpactX, car.wallImpactY, effect.sparks, car.vx, car.vy);
        if (effect.sound) {
          const volume = effect.volume * (isMine ? 1 : this.hearingFactor(car.x, car.y));
          if (volume > 0) audio.playSe(effect.sound, volume);
        }
        if (isMine && effect.shake > 0) this.camera.shake(effect.shake);
      }
    }
    this.particles.update(dt);
  }

  /** シャドウ表示 (ゴースト) にするか。画面を見ている自車から見た判定 (style-guide.md §2) */
  private isShadow(session: RaceSession, player: RaceCar, rc: RaceCar): boolean {
    if (rc.isGhostBlinking) return Math.floor(rc.ghostBlinkTime / blinkInterval) % 2 === 0;
    if (rc === player) return false;
    // ゴールしたあとは、自車との関係ではなくその車自身の状態で見せる (全車がシャドウになるのを避ける)
    if (player.status !== 'racing') return rc.isGhost;
    return session.isGhostPair(player.index, rc.index);
  }

  private buildDrawList(session: RaceSession, player: RaceCar): void {
    const list = this.drawList;
    list.length = 0;
    for (const rc of session.cars) {
      if (rc !== player) list.push({ rc, isShadow: this.isShadow(session, player, rc) });
    }
    // シャドウ表示を先に (重なったとき実体のある車を上にする)。自車は最後
    list.sort((p, q) => Number(q.isShadow) - Number(p.isShadow));
    list.push({ rc: player, isShadow: this.isShadow(session, player, player) });
  }

  private spriteOf(rc: RaceCar, isShadow: boolean): HTMLImageElement | null {
    const sprites = this.sprites.get(rc.carNumber);
    if (!sprites) return null;
    return isShadow ? sprites.shadow : sprites.normal;
  }

  // ---- 音 ----

  private updateSounds(): void {
    const player = this.player;
    const session = this.session;
    if (!player || !session || !this.sounds) return;
    const car = player.car;
    const c = this.controls;
    const throttle = car.controlLocked || c.brake > 0 ? 0 : c.throttle;
    this.sounds.update(car, player.gearbox, throttle);
    this.slipstreamSound?.set(car.fSlip);
    if (player.gearbox.shiftedUp) this.game.audio.playSe('gear-shift');
    // グリッドでアクセルを踏んだ瞬間の空ぶかし (動けばフライング)
    const isGridThrottle = session.phase === 'grid' && c.throttle > 0;
    if (isGridThrottle && !this.wasGridThrottle) this.game.audio.playSe('engine-rev');
    this.wasGridThrottle = isGridThrottle;
  }

  private stopDriveSounds(): void {
    this.sounds?.stop();
    this.sounds = null;
    this.slipstreamSound?.stop();
    this.slipstreamSound = null;
  }

  // ---- ポーズ ----

  private openPause(): void {
    const game = this.game;
    game.audio.pause();
    this.pause = new PauseScene(game, {
      onResume: () => {
        this.pause = null;
        game.audio.resume();
      },
      onRestart: () => {
        this.pause = null;
        game.audio.resume({ resumeBgm: false });
        this.startRace();
      },
      onRetire: () => {
        const session = this.session;
        const player = this.player;
        this.pause = null;
        if (!session || !player) return;
        // 1 人用のリタイアはその場で結果が確定する (game-design.md 7.7 節)
        session.retire(player.carNumber);
        this.goToResults();
      },
      onQuitToMenu: () => game.changeScene(new MenuScene(game, 'singleRace')),
      onSettingsClosed: () => {
        const settings = loadSettings();
        this.nameTags = settings.nameTags;
        this.camera.shakeEnabled = settings.screenShake;
        applyCameraMode(this.camera, settings.cameraMode, this.player?.car ?? null);
      },
    });
  }

  // ---- HUD ----

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
      drawNameTag(ctx, x, y, rc.carNumber, displayAbbr(rc.carNumber, rc.isPlayer), isSelf);
    }
  }

  private renderHud(ctx: CanvasRenderingContext2D, session: RaceSession, player: RaceCar): void {
    // 順位表 (左上)
    const rows = this.standingsRows;
    const entries = session.standings(this.standingsEntries);
    entries.forEach((e, i) => {
      if (i >= rows.length) rows.push({ carNumber: 0, abbr: '', gap: e.gap, isSelf: false, hasFastestLap: false, change: null });
      const row = rows[i];
      row.carNumber = e.carNumber;
      row.abbr = displayAbbr(e.carNumber, e.isPlayer);
      row.gap = e.gap;
      row.isSelf = e.isPlayer;
      row.hasFastestLap = e.hasFastestLap;
      row.change = this.positions.changeOf(e.carNumber);
    });
    rows.length = entries.length;
    drawStandingsPanel(ctx, { lap: session.leaderLap, totalLaps: session.totalLaps, rows });

    // タイム (右上): 決勝では自分のセッション内のタイム。BEST は全体ベストなら紫、それ以外は緑
    const isStarted = session.phase !== 'grid';
    const hasLap = isStarted && player.lap.lap > 0;
    drawTimingPanel(ctx, {
      currentLapTime: isStarted ? player.currentLapTime : null,
      isCurrentLapInvalid: hasLap && !player.lap.lapValid,
      sectors: player.sectorResults,
      bestLapTime: player.bestLap,
      bestLapResult: player.bestLap !== null && player.bestLap === session.fastestLap ? 'overall' : 'personal',
      lastLapTime: player.lastLap,
      lastLapResult: player.lastLapResult,
      isLastLapInvalid: player.lastLap !== null && player.lastLapResult === 'none',
    });

    if (!isStarted || session.raceTime < lampsAfterStartTime) drawStartLamps(ctx, session.litLamps, 276, 12, this.lampImages);
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
      const gate = session.track.checkpoints[player.lap.nextCheckpoint];
      const angle = Math.atan2((gate.ay + gate.by) / 2 - car.y, (gate.ax + gate.bx) / 2 - car.x) - this.camera.renderAngle;
      drawCheckpointArrow(ctx, angle);
    }

    // ミニマップ (左下): 全車。シャドウ表示の車はゴーストの印で
    this.minimapCars.length = 0;
    for (const { rc, isShadow } of this.drawList) {
      this.minimapCars.push({ x: rc.car.x, y: rc.car.y, color: teamColors[rc.carNumber], isSelf: rc === player, isGhost: isShadow && rc !== player });
    }
    getCourseMinimap().draw(ctx, this.minimapCars);

    if (this.isDebugVisible) drawDebugPanel(ctx, this.debugRows(session, player));
  }

  private debugRows(session: RaceSession, player: RaceCar): DebugRow[] {
    const car = player.car;
    const surfaces = car.wheelSurfaces.map((s) => s.slice(0, 2).toUpperCase()).join(' ');
    return [
      ['SPEED', `${Math.round(car.speed)} PX/S`],
      ['GRIP USE', car.uReq.toFixed(2)],
      ['GRIP MUL', car.grip.toFixed(2)],
      ['SURFACE', surfaces],
      ['SLIP', car.fSlip.toFixed(2)],
      ['DRS', car.fDrs.toFixed(2)],
      ['POS', `${player.position}/${session.cars.length}`],
      ['DIST', `${Math.round(player.distance)}`],
      ['TIME', session.raceTime.toFixed(2)],
    ];
  }
}

/** 前後の車との差のパネル用: 先頭 (leader) と「後ろなし」は --- で出す */
function toPanelGap(gap: RaceGap | null): RaceGap | null {
  if (gap === null || gap.kind === 'leader') return null;
  return gap;
}
