import { ControlsReader } from '../core/ControlsReader';
import { TuningStore } from '../core/TuningStore';
import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { Camera, defaultCameraOptions } from '../core/Camera';
import type { CameraOptions } from '../core/Camera';
import { WorldLayer } from '../core/WorldLayer';
import { DriveSounds } from '../entities/DriveSounds';
import { Particles } from '../entities/Particles';
import { emitWheelEffects } from '../entities/wheelEffects';
import { drawCar, drawCarOnScreen, drawDrsWind } from '../render/drawCar';
import { TireMarks } from '../render/TireMarks';
import { TrackRenderer } from '../render/TrackRenderer';
import { wallImpactEffect } from '../shared/carEffects';
import type { ImpactEffect } from '../shared/carEffects';
import { defaultCarParams, physicsVersion, raceRules, recordVersionOf, setCarParam } from '../shared/carParams';
import { createControls } from '../shared/controls';
import { deserializeGhost, serializeGhost } from '../shared/ghost';
import type { GhostData } from '../shared/ghost';
import { TimeAttackSession } from '../shared/TimeAttackSession';
import type { TimeAttackEvent, TimeAttackRecord } from '../shared/TimeAttackSession';
import type { Track } from '../shared/Track';
import type { Pose } from '../shared/Track';
import { toKmh } from '../shared/VirtualGearbox';
import { drawCarStatusPanel } from '../ui/carStatusPanel';
import { drawCheckpointArrow } from '../ui/checkpointArrow';
import { drawCountdown } from '../ui/countdown';
import { colors, teamColors } from '../ui/colors';
import { drawDebugPanel } from '../ui/debugPanel';
import type { DebugRow } from '../ui/debugPanel';
import { drawGhostDelta } from '../ui/ghostDelta';
import { hudMessages } from '../ui/hudMessages';
import { MessageQueue } from '../ui/MessageQueue';
import type { MinimapCar } from '../ui/Minimap';
import { drawMessageBand } from '../ui/messageBand';
import { drawText } from '../ui/text';
import { drawTimingPanel } from '../ui/timingPanel';
import { TuningPanel } from '../ui/TuningPanel';
import { getCourseMinimap, getCourseTrack } from './courseCache';
import { applyCameraMode, followCar } from './driveCamera';
import { MenuScene } from './MenuScene';
import { PauseScene } from './PauseScene';
import { loadSettings, saveData } from './settingsStorage';
import type { CameraMode } from './settingsStorage';

/**
 * 開発時の調整パネル (F4) の値。起動中に 1 回だけ作り、シーンを作り直しても同じ値を使う。
 * カメラの値はシーンごとの Camera に写す (tunedCameraOptions → camera.options)
 */
let tuningStore: TuningStore | null = null;
const tunedCameraOptions: CameraOptions = { ...defaultCameraOptions };

/** carParams の上の階層の項目で、グループが始まるキー (carParams.ts の章の区切り)。ないキーは直前のグループに入る */
const carParamGroupStarts: Readonly<Record<string, string>> = {
  vBase: 'longitudinal',
  steerRise: 'steering',
  latGrip: 'cornering',
  squealStart: 'effects',
  slipBonus: 'slipstream',
  drsBonus: 'drs',
  cliffStart: 'tyre wear',
  restitution: 'contact',
  spinTimeLight: 'spin',
  pitSpeedLimit: 'pit',
  hitWidth: 'size',
};

function getTuningStore(): TuningStore {
  // 保存キーに物理のバージョンを入れる: 挙動を作り直したとき (第 4 版など)、古い調整値が新しい挙動に当たらないように
  tuningStore ??= new TuningStore(`pix-lights-out.tuning.v${physicsVersion}`, [
    { id: 'carParams', label: 'longitudinal', defaults: defaultCarParams, apply: setCarParam, groupStarts: carParamGroupStarts },
    {
      id: 'camera',
      label: 'camera',
      defaults: defaultCameraOptions,
      apply: (path, value) => {
        const key = path[0] as keyof CameraOptions;
        if (typeof tunedCameraOptions[key] === 'number') tunedCameraOptions[key] = value;
      },
    },
  ]);
  return tuningStore;
}

/** コース復帰直後の点滅: 0.125 秒ごとに通常表示とシャドウ表示を入れ替える (style-guide.md §2) */
const blinkInterval = 0.125;
/** カメラを回転するときのワールド層の大きさ (ドット)。画面 400×300 ドットの対角線 500 に余裕を足したもの */
const rotatedLayerSize = 504;

/**
 * タイムアタックの走行画面 (game-design.md 12 章 M1)。
 * 最初のフレームで「LOADING」を描いてから、次の更新でコースを作る (作る間は画面が止まるため)。
 */
export class TimeAttackScene implements Scene {
  private session: TimeAttackSession | null = null;
  private renderer: TrackRenderer | null = null;
  private marks: TireMarks | null = null;
  /** 読み込み中に経過した更新の回数 (LOADING を描いてからコースを作るため) */
  private loadingUpdates = 0;

  /** 北が上で固定の表示に使うワールド層 (400×300) と、回転する表示に使うワールド層 (対角線ぶんの正方形) */
  private readonly fixedLayer = new WorldLayer();
  private readonly rotatedLayer = new WorldLayer(rotatedLayerSize, rotatedLayerSize);
  private readonly camera = new Camera();
  /** 開発時だけの調整パネル (本番ビルドでは null で、F4 を無視する) */
  private readonly tuning: TuningPanel | null = null;
  /** この走行 (カウントダウンから) の間に調整した値で走ったか。true なら自己ベスト・ゴーストを保存しない */
  private isRunTuned = false;
  private readonly screenPoint = { x: 0, y: 0 };
  private readonly reader: ControlsReader;
  private readonly controls = createControls();
  private readonly messages = new MessageQueue();
  private readonly particles = new Particles();
  private readonly impact: ImpactEffect = { sound: null, volume: 0, shake: 0, sparks: 0 };
  private readonly ghostPose: Pose = { x: 0, y: 0, heading: 0 };
  private readonly wheel = { x: 0, y: 0 };
  private readonly minimapCars: MinimapCar[] = [];
  private sounds: DriveSounds | null = null;

  private pause: PauseScene | null = null;
  private isDebugVisible = false;
  private isGhostVisible: boolean;
  /** 最後に保存したゴースト (同じものを何度も書かない) */
  private savedGhost: GhostData | null = null;
  private time = 0;

  constructor(private readonly game: Game) {
    this.reader = ControlsReader.withKeyboard(game.input);
    if (import.meta.env.DEV) {
      this.tuning = new TuningPanel(getTuningStore(), game.input, () => {
        this.isRunTuned = true;
        Object.assign(this.camera.options, tunedCameraOptions);
      });
      Object.assign(this.camera.options, tunedCameraOptions);
    }
    const settings = loadSettings();
    this.isGhostVisible = settings.showGhost;
    this.camera.shakeEnabled = settings.screenShake;
    this.applyCameraMode(settings.cameraMode);
  }

  /** 今の表示で使うワールド層 */
  private get layer(): WorldLayer {
    return this.camera.rotation === 'fixed' ? this.fixedLayer : this.rotatedLayer;
  }

  /** 設定のカメラの方式を反映する。回転に切り替えたときは、向きをすぐに車に合わせる */
  private applyCameraMode(mode: CameraMode): void {
    applyCameraMode(this.camera, mode, this.session?.car ?? null);
  }

  enter(): void {
    this.game.audio.playBgm('qualifying-theme');
  }

  exit(): void {
    this.stopDriveSounds();
    // メニューへ戻るときに走行の BGM を鳴らし直さない (次の画面が自分の曲を流す)
    if (this.game.audio.isPaused) this.game.audio.resume({ resumeBgm: false });
  }

  update(dt: number): void {
    if (!this.session) {
      // 1 回目の更新のあとに LOADING が描かれ、2 回目で作る (作る間は画面が止まる)
      this.loadingUpdates++;
      if (this.loadingUpdates >= 2) this.build();
      return;
    }
    const { input } = this.game;
    if (this.pause) {
      this.pause.update(dt);
      return;
    }
    if (input.wasPressed('Escape') || input.wasBlurred()) {
      this.openPause();
      return;
    }
    if (input.wasPressed('F3')) this.isDebugVisible = !this.isDebugVisible;
    this.tuning?.update(dt);

    const session = this.session;
    this.time += dt;
    this.reader.read(this.controls);
    for (const e of session.step(this.controls, dt)) this.handleEvent(e);

    followCar(this.camera, session.car, dt);
    this.updateStatusMessages();
    this.messages.update(dt);
    this.updateEffects(dt);
    this.updateSounds();
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.game;
    if (!this.session || !this.renderer || !this.marks) {
      ctx.fillStyle = colors.base;
      ctx.fillRect(0, 0, width, height);
      drawText(ctx, 'LOADING COURSE', width / 2, height / 2 - 8, { color: colors.text, align: 'center' });
      return;
    }
    const session = this.session;
    const car = session.car;
    const layer = this.layer;
    const images = this.game.assets;

    // ワールド層: コース → タイヤ痕 → ゴースト (シャドウ表示) → 自車 → エフェクト
    const isRotated = this.camera.rotation !== 'fixed';
    const hasGhost = this.isGhostVisible && session.ghostPose(this.ghostPose);
    const playerImage = images.getImage(this.isPlayerShadow() ? 'car-base-ghost' : 'car-base');
    if (isRotated) layer.setCamera(this.camera.x, this.camera.y, this.camera.renderAngle);
    else layer.setCamera(this.camera.renderX, this.camera.renderY);
    this.renderer.render(layer);
    this.marks.render(layer);
    if (!isRotated) {
      if (hasGhost) drawCar(layer, images.getImage('car-base-ghost'), this.ghostPose.x, this.ghostPose.y, this.ghostPose.heading);
      drawCar(layer, playerImage, car.x, car.y, car.drawHeading);
    }
    if (car.drsOpen) drawDrsWind(layer, car, this.time, this.wheel);
    this.particles.render(layer);
    if (isRotated) {
      // 回転する表示: 画面揺れは回転後の画面にかける。車はワールド層ではなく画面に直接描く (回転を 1 回にしてドットの崩れを減らす)
      const shakeX = this.camera.shakeX;
      const shakeY = this.camera.shakeY;
      layer.present(ctx, shakeX, shakeY);
      if (hasGhost) this.drawCarOnScreen(ctx, images.getImage('car-base-ghost'), this.ghostPose.x, this.ghostPose.y, this.ghostPose.heading, shakeX, shakeY);
      this.drawCarOnScreen(ctx, playerImage, car.x, car.y, car.drawHeading, shakeX, shakeY);
    } else {
      layer.present(ctx);
    }

    // コース復帰の暗転 (HUD の手前まで)。4 段階で暗くする
    if (session.screenFade > 0) {
      ctx.save();
      ctx.globalAlpha = Math.ceil(session.screenFade * 4) / 4;
      ctx.fillStyle = colors.ink;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    this.renderHud(ctx);
    this.pause?.render(ctx);
  }

  // ---- 準備 ----

  private build(): void {
    const track = getCourseTrack();
    this.renderer = new TrackRenderer(track, this.game.assets);
    // 最初のフレームの引っかかりを減らすため、開始位置のまわりを先に塗っておく
    this.renderer.prepare(track.soloStart.x, track.soloStart.y);
    this.marks = new TireMarks(track);
    this.session = new TimeAttackSession(track, loadRecord(track));
    this.savedGhost = this.session.record.ghost;
    this.sounds = new DriveSounds(this.game.audio);
    this.startRun();
  }

  private drawCarOnScreen(ctx: CanvasRenderingContext2D, image: HTMLImageElement | null, x: number, y: number, heading: number, shakeX: number, shakeY: number): void {
    const p = this.layer.worldToScreen(x, y, this.screenPoint);
    drawCarOnScreen(ctx, image, p.x + shakeX, p.y + shakeY, this.layer.toScreenAngle(heading));
  }

  /** 開始位置からカウントダウンをやり直す (最初とリスタート) */
  private startRun(): void {
    const session = this.session;
    if (!session) return;
    const wasTuned = this.isRunTuned;
    this.isRunTuned = tuningStore?.isModified ?? false;
    if (wasTuned && !this.isRunTuned) {
      session.replaceRecord(loadRecord(session.track));
      this.savedGhost = session.record.ghost;
    }
    session.restart();
    this.marks?.clear();
    this.particles.clear();
    this.messages.clear();
    this.camera.snapTo(session.car.x, session.car.y, session.car.heading);
    this.time = 0;
    // コースの生成などで止まっていた時間をまとめて進めない (カウントダウンが短くならないように)
    this.game.resetClock();
  }

  // ---- イベント・状態 ----

  private handleEvent(e: TimeAttackEvent): void {
    const audio = this.game.audio;
    const session = this.session;
    if (!session) return;
    switch (e.type) {
      case 'sectorResult':
        if (e.result === 'overall' || e.result === 'personal') audio.playSe('sector-best');
        else if (e.result === 'slower') audio.playSe('sector-time');
        break;
      case 'lapResult':
        audio.playSe('lap-complete');
        if (e.isNewRecord) {
          this.messages.push(hudMessages.newRecord(e.time));
          audio.playSe('sector-best');
        }
        break;
      case 'recordUpdated':
        this.saveRecord(e.record);
        break;
      case 'lapInvalidated':
        // コース復帰による無効化では出さない (RESET のカウントを隠さないため。game-design.md 10.2 節)
        if (e.reason !== 'reset') this.messages.push(hudMessages.invalidLap());
        break;
      case 'wrongWayStarted':
        audio.playSe('ui-error');
        break;
      case 'resetRejected':
        audio.playSe('ui-error');
        break;
      case 'resetPlaced':
        // 置き直したときは、向きもすぐに合わせる (回転する表示で画面が大きく回らないように)
        this.camera.snapTo(session.car.x, session.car.y, session.car.heading);
        break;
      case 'resetFinished':
        this.messages.setStatus('reset', null);
        break;
      case 'drsEnabled':
        this.messages.push(hudMessages.drsEnabled());
        break;
      case 'drsOpened':
        audio.playSe('drs-open');
        break;
      case 'drsClosed':
        audio.playSe('drs-close');
        break;
      default:
        break;
    }
  }

  /** 状態が続く間だけ出すメッセージ (10.2 節の優先度 1 と RESET のカウント) */
  private updateStatusMessages(): void {
    const session = this.session;
    if (!session) return;
    const lap = session.lap;
    const m = this.messages;
    m.setStatus('wrongWay', lap.isWrongWay ? hudMessages.wrongWay() : null);
    m.setStatus('missedCheckpoint', lap.isCheckpointMissed ? hudMessages.missedCheckpoint() : null);
    m.setStatus('canReset', session.isResetAvailable ? hudMessages.pressToReset(this.reader.lastUsedKind === 'gamepad') : null);
    // 置き直したあとの操作不能の間だけカウントを出す (暗転中は出さない)
    const isCounting = session.resetLockRemaining > 0 && session.screenFade < 1 && session.car.controlLocked && session.phase === 'running';
    m.setStatus('reset', isCounting ? hudMessages.resetCount(session.resetLockRemaining) : null);
  }

  private saveRecord(record: TimeAttackRecord): void {
    // 調整した値で走った記録は、既定の値の記録と比べられないため保存しない
    if (this.isRunTuned) return;
    saveData.saveBest(record.trackId, record.recordVersion, { bestLap: record.bestLap, bestSectors: record.bestSectors });
    if (record.ghost && record.ghost !== this.savedGhost) {
      saveData.saveGhost(record.trackId, record.recordVersion, serializeGhost(record.ghost));
      this.savedGhost = record.ghost;
    }
  }

  // ---- 演出 ----

  private updateEffects(dt: number): void {
    const session = this.session;
    const marks = this.marks;
    if (!session || !marks) return;
    const car = session.car;

    marks.update(dt);
    emitWheelEffects(car, marks, this.particles, this.wheel);

    if (car.lockupStarted) this.game.audio.playSe('tire-lockup');

    // 壁との衝突: 音・画面揺れ・火花
    if (car.wallImpact > 0) {
      const effect = wallImpactEffect(car.wallImpact, this.impact);
      if (effect.sound) this.game.audio.playSe(effect.sound, effect.volume);
      if (effect.shake > 0) this.camera.shake(effect.shake);
      if (effect.sparks > 0) this.particles.emitSparks(car.wallImpactX, car.wallImpactY, effect.sparks, car.vx, car.vy);
    }
    this.particles.update(dt);
  }

  /** コース復帰直後の自車の点滅: 最初の 0.125 秒はシャドウ表示から始める */
  private isPlayerShadow(): boolean {
    const session = this.session;
    if (!session || session.ghostTimeRemaining <= 0) return false;
    const elapsed = raceRules.resetGhostTime - session.ghostTimeRemaining;
    return Math.floor(elapsed / blinkInterval) % 2 === 0;
  }

  // ---- 音 ----

  private updateSounds(): void {
    const session = this.session;
    const s = this.sounds;
    if (!session || !s) return;
    const car = session.car;
    const throttle = car.controlLocked || this.controls.brake > 0 ? 0 : this.controls.throttle;
    s.update(car, session.gearbox, throttle);
  }

  private stopDriveSounds(): void {
    this.sounds?.stop();
    this.sounds = null;
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
        game.audio.resume();
        this.startRun();
      },
      onQuitToMenu: () => game.changeScene(new MenuScene(game)),
      onSettingsClosed: () => {
        const settings = loadSettings();
        this.isGhostVisible = settings.showGhost;
        this.camera.shakeEnabled = settings.screenShake;
        this.applyCameraMode(settings.cameraMode);
      },
    });
  }

  // ---- HUD ----

  private renderHud(ctx: CanvasRenderingContext2D): void {
    const session = this.session;
    if (!session) return;
    const car = session.car;
    const lap = session.lap;

    drawTimingPanel(ctx, {
      currentLapTime: lap.lap > 0 ? session.currentLapTime : null,
      isCurrentLapInvalid: lap.lap > 0 && !lap.lapValid,
      sectors: session.sectorResults,
      // BEST は保存されている全期間の自己ベスト (タイムアタックの全体ベスト) なので紫
      bestLapTime: session.record.bestLap,
      bestLapResult: 'overall',
      lastLapTime: session.lastLap,
      lastLapResult: session.lastLapResult,
      isLastLapInvalid: session.lastLap !== null && session.lastLapResult === 'none',
    });
    drawMessageBand(ctx, this.messages.getDisplay());
    drawCarStatusPanel(ctx, {
      speedKmh: toKmh(car.speed),
      gear: car.isReversing ? 'R' : session.gearbox.gear,
      drs: session.drs.indicator(car),
    });
    if (this.isGhostVisible && session.hasGhost) drawGhostDelta(ctx, session.ghostDelta);

    if (lap.isCheckpointMissed) {
      const gate = session.track.checkpoints[lap.nextCheckpoint];
      // ワールドでの向きを、回転した画面の上での向きに直す
      const angle = Math.atan2((gate.ay + gate.by) / 2 - car.y, (gate.ax + gate.bx) / 2 - car.x) - this.camera.renderAngle;
      drawCheckpointArrow(ctx, angle);
    }
    // ミニマップ: ゴースト → 自車の順に描く (自車を上にする)
    this.minimapCars.length = 0;
    if (this.isGhostVisible && session.ghostPose(this.ghostPose)) {
      this.minimapCars.push({ x: this.ghostPose.x, y: this.ghostPose.y, color: teamColors[1], isGhost: true });
    }
    this.minimapCars.push({ x: car.x, y: car.y, color: teamColors[1], isSelf: true });
    getCourseMinimap().draw(ctx, this.minimapCars);

    if (session.phase === 'countdown') drawCountdown(ctx, Math.ceil(session.countdownRemaining - 1e-9));
    if (this.isDebugVisible) drawDebugPanel(ctx, this.debugRows());
    // 調整パネルで物理の値を変えている間は記録を保存しない (car-physics.md 16.1 節の表記 TUNED)
    if (this.isRunTuned) drawText(ctx, 'TUNED', 12, 12, { color: colors.yellow });
    this.tuning?.render(ctx);
  }

  private debugRows(): DebugRow[] {
    const session = this.session;
    if (!session) return [];
    const car = session.car;
    const surfaces = car.wheelSurfaces.map((s) => s.slice(0, 2).toUpperCase()).join(' ');
    return [
      ['SPEED', `${Math.round(car.speed)} PX/S`],
      ['GRIP USE', car.uReq.toFixed(2)],
      ['GRIP MUL', car.grip.toFixed(2)],
      ['BRAKE MUL', car.brakeGrip.toFixed(2)],
      ['SURFACE', surfaces],
      ['SLIP', car.fSlip.toFixed(2)],
      ['DRS', car.fDrs.toFixed(2)],
      ['WEAR', `${Math.round(car.wear * 100)}%`],
      ['LAP S', `${Math.round(session.lap.projection.s)}`],
    ];
  }
}

/** 保存されている自己ベストとゴーストを、セッションに渡す形にする。どちらもなければ null */
function loadRecord(track: Track): TimeAttackRecord | null {
  const trackId = track.id;
  const version = recordVersionOf(track);
  const best = saveData.loadBest(trackId, version);
  const ghost = deserializeGhost(saveData.loadGhost(trackId, version), trackId, track.version);
  if (!best && !ghost) return null;
  return {
    recordVersion: recordVersionOf(track),
    trackId,
    bestLap: best?.bestLap ?? null,
    bestSectors: best?.bestSectors ?? [null, null, null],
    ghost,
  };
}
