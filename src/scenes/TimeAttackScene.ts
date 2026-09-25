import { ControlsReader } from '../core/ControlsReader';
import type { EngineSound } from '../core/EngineSound';
import type { Game } from '../core/Game';
import type { LoopSound } from '../core/LoopSound';
import type { Scene } from '../core/Scene';
import { Camera } from '../core/Camera';
import { WorldLayer } from '../core/WorldLayer';
import { Particles } from '../entities/Particles';
import { drawCar } from '../render/drawCar';
import { TireMarks } from '../render/TireMarks';
import { TrackRenderer } from '../render/TrackRenderer';
import type { WheelIndex } from '../shared/Car';
import { computeCarSound, createCarSoundParams, wallImpactEffect } from '../shared/carEffects';
import type { ImpactEffect } from '../shared/carEffects';
import { physicsVersion, raceRules, recordVersionOf } from '../shared/carParams';
import { createControls } from '../shared/controls';
import { deserializeGhost, serializeGhost } from '../shared/ghost';
import type { GhostData } from '../shared/ghost';
import { TimeAttackSession } from '../shared/TimeAttackSession';
import type { TimeAttackEvent, TimeAttackRecord } from '../shared/TimeAttackSession';
import { Track } from '../shared/Track';
import type { Pose } from '../shared/Track';
import { course1 } from '../shared/tracks/course1';
import { toKmh } from '../shared/VirtualGearbox';
import { drawCarStatusPanel } from '../ui/carStatusPanel';
import { drawCheckpointArrow } from '../ui/checkpointArrow';
import { colors } from '../ui/colors';
import { drawDebugPanel } from '../ui/debugPanel';
import type { DebugRow } from '../ui/debugPanel';
import { drawGhostDelta } from '../ui/ghostDelta';
import { hudMessages } from '../ui/hudMessages';
import { MessageQueue } from '../ui/MessageQueue';
import { drawMessageBand } from '../ui/messageBand';
import { drawText } from '../ui/text';
import { drawTimingPanel } from '../ui/timingPanel';
import { MenuScene } from './MenuScene';
import { PauseScene } from './PauseScene';
import { loadSettings, saveData } from './settingsStorage';

/** 起動中に 1 回だけ作る (Track の生成は約 0.5 秒かかるため、リスタートやメニューから戻っても使い回す) */
let cachedTrack: Track | null = null;

/** コース復帰直後の点滅: 0.125 秒ごとに通常表示とシャドウ表示を入れ替える (style-guide.md §2) */
const blinkInterval = 0.125;
/** 砂利・芝の跳ねを出す最低速度 (px/秒、game-design.md 10.4 節) */
const dirtMinSpeed = 125;
const wheels: readonly WheelIndex[] = [0, 1, 2, 3];
const rearWheels: readonly WheelIndex[] = [2, 3];

interface DriveSounds {
  engine: EngineSound;
  squeal: LoopSound;
  grass: LoopSound;
  gravel: LoopSound;
  kerb: LoopSound;
  scrape: LoopSound;
}

/**
 * タイムアタックの走行画面 (game-design.md 12 章 M1)。
 * 最初のフレームで「LOADING」を描いてから、次の更新でコースを作る (作る間は画面が止まるため)。
 */
export class TimeAttackScene implements Scene {
  private session: TimeAttackSession | null = null;
  private renderer: TrackRenderer | null = null;
  private marks: TireMarks | null = null;
  private hasShownLoading = false;

  private readonly layer = new WorldLayer();
  private readonly camera = new Camera();
  private readonly reader: ControlsReader;
  private readonly controls = createControls();
  private readonly messages = new MessageQueue();
  private readonly particles = new Particles();
  private readonly soundParams = createCarSoundParams();
  private readonly impact: ImpactEffect = { sound: null, volume: 0, shake: 0, sparks: 0 };
  private readonly ghostPose: Pose = { x: 0, y: 0, heading: 0 };
  private readonly wheel = { x: 0, y: 0 };
  private sounds: DriveSounds | null = null;

  private pause: PauseScene | null = null;
  private isDebugVisible = false;
  private isGhostVisible: boolean;
  /** 最後に保存したゴースト (同じものを何度も書かない) */
  private savedGhost: GhostData | null = null;
  private time = 0;

  constructor(private readonly game: Game) {
    this.reader = ControlsReader.withKeyboard(game.input);
    const settings = loadSettings();
    this.isGhostVisible = settings.showGhost;
    this.camera.shakeEnabled = settings.screenShake;
  }

  enter(): void {
    this.game.audio.playBgm('qualifying-theme');
  }

  exit(): void {
    this.stopDriveSounds();
    if (this.game.audio.isPaused) this.game.audio.resume();
  }

  update(dt: number): void {
    if (!this.session) {
      if (this.hasShownLoading) this.build();
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

    const session = this.session;
    this.time += dt;
    this.reader.read(this.controls);
    for (const e of session.step(this.controls, dt)) this.handleEvent(e);

    const car = session.car;
    this.camera.update(dt, car.x, car.y, car.vx, car.vy);
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
      this.hasShownLoading = true;
      return;
    }
    const session = this.session;
    const car = session.car;
    const layer = this.layer;
    const images = this.game.assets;

    // ワールド層: コース → タイヤ痕 → ゴースト (シャドウ表示) → 自車 → エフェクト
    layer.setCamera(this.camera.renderX, this.camera.renderY);
    this.renderer.render(layer);
    this.marks.render(layer);
    if (this.isGhostVisible && session.ghostPose(this.ghostPose)) {
      const p = this.ghostPose;
      drawCar(layer, images.getImage('car-base-ghost'), p.x, p.y, p.heading);
    }
    drawCar(layer, images.getImage(this.isPlayerShadow() ? 'car-base-ghost' : 'car-base'), car.x, car.y, car.drawHeading);
    if (car.drsOpen) this.drawDrsWind();
    this.particles.render(layer);
    layer.present(ctx);

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
    cachedTrack ??= new Track(course1);
    const track = cachedTrack;
    this.renderer = new TrackRenderer(track, this.game.assets);
    // 最初のフレームの引っかかりを減らすため、開始位置のまわりを先に塗っておく
    this.renderer.prepare(track.soloStart.x, track.soloStart.y);
    this.marks = new TireMarks(track);
    this.session = new TimeAttackSession(track, loadRecord(track));
    this.savedGhost = this.session.record.ghost;
    this.startRun();
    const audio = this.game.audio;
    this.sounds = {
      engine: audio.createEngine('engine-player-loop', 'engine-player-decel-loop'),
      squeal: audio.createLoop('tire-squeal-loop'),
      grass: audio.createLoop('offtrack-grass-loop'),
      gravel: audio.createLoop('offtrack-gravel-loop'),
      kerb: audio.createLoop('kerb-rumble-loop'),
      scrape: audio.createLoop('scrape-loop'),
    };
  }

  /** 開始位置からカウントダウンをやり直す (最初とリスタート) */
  private startRun(): void {
    const session = this.session;
    if (!session) return;
    session.restart();
    this.marks?.clear();
    this.particles.clear();
    this.messages.clear();
    this.camera.snapTo(session.car.x, session.car.y);
    this.time = 0;
  }

  // ---- イベント・状態 ----

  private handleEvent(e: TimeAttackEvent): void {
    const audio = this.game.audio;
    const session = this.session;
    if (!session) return;
    switch (e.type) {
      case 'countdown':
        this.messages.setStatus('countdown', hudMessages.countdown(e.value));
        break;
      case 'go':
        this.messages.setStatus('countdown', null);
        break;
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
        this.messages.push(hudMessages.invalidLap());
        break;
      case 'wrongWayStarted':
        audio.playSe('ui-error');
        break;
      case 'resetRejected':
        audio.playSe('ui-error');
        break;
      case 'resetPlaced':
        this.camera.snapTo(session.car.x, session.car.y);
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
    saveData.saveBest(record.trackId, physicsVersion, { bestLap: record.bestLap, bestSectors: record.bestSectors });
    if (record.ghost && record.ghost !== this.savedGhost) {
      saveData.saveGhost(record.trackId, physicsVersion, serializeGhost(record.ghost));
      this.savedGhost = record.ghost;
    }
  }

  // ---- 演出 ----

  private updateEffects(dt: number): void {
    const session = this.session;
    const marks = this.marks;
    if (!session || !marks) return;
    const car = session.car;

    // タイヤ痕: skidRear で後輪 2 本、skidFront で前輪 2 本 (スピン中は Car が両方立てる)
    marks.update(dt);
    for (const index of wheels) {
      const isFront = index < 2;
      if (isFront ? car.skidFront : car.skidRear) {
        car.wheelPosition(index, this.wheel);
        marks.add(this.wheel.x, this.wheel.y);
      }
    }

    // 壁との衝突: 音・画面揺れ・火花
    if (car.wallImpact > 0) {
      const effect = wallImpactEffect(car.wallImpact, this.impact);
      if (effect.sound === 'crash-wall') this.game.audio.playSe('crash-wall', effect.volume);
      // TODO(audio): tire-barrier-hit は未作成で音の設定 (assetList.ts) もない。できるまで crash-wall を小さく鳴らす
      else if (effect.sound === 'tire-barrier-hit') this.game.audio.playSe('crash-wall', effect.volume * 0.5);
      if (effect.shake > 0) this.camera.shake(effect.shake);
      if (effect.sparks > 0) this.particles.emitSparks(car.wallImpactX, car.wallImpactY, effect.sparks, car.vx, car.vy);
    }

    // 砂利・芝の跳ね (車輪ごと、毎フレームは多すぎるので確率で間引く)
    if (car.speed >= dirtMinSpeed) {
      for (const index of wheels) {
        const surface = car.wheelSurfaces[index];
        if ((surface === 'grass' || surface === 'gravel') && Math.random() < 0.5) {
          car.wheelPosition(index, this.wheel);
          this.particles.emitDirt(surface, this.wheel.x, this.wheel.y, car.vx, car.vy);
        }
      }
    }
    if (car.isSpinning && Math.random() < 0.6) {
      car.wheelPosition(rearWheels[Math.random() < 0.5 ? 0 : 1], this.wheel);
      this.particles.emitSmoke(this.wheel.x, this.wheel.y);
    }
    this.particles.update(dt);
  }

  /** DRS が開いている間、車の後方に風の線 (白、2 本、ちらつかせる) */
  private drawDrsWind(): void {
    const session = this.session;
    if (!session) return;
    const car = session.car;
    const ctx = this.layer.ctx;
    ctx.fillStyle = colors.white;
    const phase = Math.floor(this.time * 20) % 3;
    for (const side of [-4, 4]) {
      for (let k = 0; k < 3; k++) {
        if (k === phase) continue;
        car.localToWorld(side, -26 - k * 6, this.wheel);
        ctx.fillRect(this.layer.dotX(this.wheel.x), this.layer.dotY(this.wheel.y), 1, 2);
      }
    }
  }

  /** コース復帰直後の自車の点滅: 最初の 0.125 秒はシャドウ表示から始める */
  private isPlayerShadow(): boolean {
    const session = this.session;
    if (!session || session.ghostTimeRemaining <= 0) return false;
    const elapsed = raceRules.resetGhostTime - session.ghostTimeRemaining;
    return Math.floor(elapsed / blinkInterval) % 2 === 0;
  }

  // ---- 音 ----

  // TODO(audio): tire-lockup (car.lockupStarted) は未作成で音の設定もない。できたら updateEffects で鳴らす
  private updateSounds(): void {
    const session = this.session;
    const s = this.sounds;
    if (!session || !s) return;
    const car = session.car;
    const throttle = car.controlLocked || this.controls.brake > 0 ? 0 : this.controls.throttle;
    const p = computeCarSound(car, session.gearbox, throttle, this.soundParams);
    s.engine.update(session.gearbox.rpmRatio, throttle);
    s.squeal.set(p.squealVolume, p.squealRate);
    s.grass.set(p.grassVolume, p.surfaceRate);
    s.gravel.set(p.gravelVolume, p.surfaceRate);
    s.kerb.set(p.kerbVolume, p.surfaceRate);
    s.scrape.set(p.scrapeVolume);
  }

  private stopDriveSounds(): void {
    const s = this.sounds;
    if (!s) return;
    s.engine.stop();
    s.squeal.stop();
    s.grass.stop();
    s.gravel.stop();
    s.kerb.stop();
    s.scrape.stop();
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
      const angle = Math.atan2((gate.ay + gate.by) / 2 - car.y, (gate.ax + gate.bx) / 2 - car.x);
      drawCheckpointArrow(ctx, angle);
    }
    if (this.isDebugVisible) drawDebugPanel(ctx, this.debugRows());
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
  const best = saveData.loadBest(trackId, physicsVersion);
  const ghost = deserializeGhost(saveData.loadGhost(trackId, physicsVersion), trackId, track.version);
  if (!best && !ghost) return null;
  return {
    recordVersion: recordVersionOf(track),
    trackId,
    bestLap: best?.bestLap ?? null,
    bestSectors: best?.bestSectors ?? [null, null, null],
    ghost,
  };
}
