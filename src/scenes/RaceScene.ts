import { ControlsReader } from '../core/ControlsReader';
import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { createControls } from '../shared/controls';
import { RaceSession } from '../shared/RaceSession';
import { getCourseRacingLine, getCourseTrack } from './courseCache';
import { MenuScene } from './MenuScene';
import { PauseScene } from './PauseScene';
import { RaceScreen, singleRaceLabels } from './RaceScreen';
import type { RaceSetup } from './raceSetup';
import { ResultScene } from './ResultScene';

/** 自分のゴールからリザルトへ進むまで (秒、game-design.md 10.2 節) */
const finishToResultTime = 3;

/**
 * 決勝の走行画面 (game-design.md 7 章・10 章、12 章 M2)。
 * グリッド → スタートランプ → 消灯 → レース → チェッカー → リザルト。
 * 最初のフレームで「LOADING」を描いてから、次の更新でコースと CPU のレーシングラインを作る (作る間は画面が止まるため)。
 * 描画・HUD・音は RaceScreen (オンラインの NetRaceScene と共用)。
 */
export class RaceScene implements Scene {
  private session: RaceSession | null = null;
  private loadingUpdates = 0;

  private readonly screen: RaceScreen;
  private readonly reader: ControlsReader;
  private readonly controls = createControls();
  private pause: PauseScene | null = null;
  /** 自分がゴールしてからリザルトへ進むまでの残り秒 (まだなら負) */
  private finishTimer = -1;

  constructor(
    private readonly game: Game,
    private readonly setup: Readonly<RaceSetup>,
    private readonly seed: number,
  ) {
    this.reader = ControlsReader.withKeyboardAndTouch(game.input, game.touchPad);
    this.screen = new RaceScreen(game, singleRaceLabels);
  }

  enter(): void {
    // グリッドに並んだ時点で BGM を止め、消灯と同時にレースの曲を頭から流す (game-design.md 7.2 節)
    this.game.audio.stopBgm(0.3);
  }

  exit(): void {
    this.screen.stopSounds();
    if (this.game.audio.isPaused) this.game.audio.resume({ resumeBgm: false });
  }

  update(dt: number): void {
    if (!this.session) {
      this.loadingUpdates++;
      if (this.loadingUpdates >= 2) this.build();
      return;
    }
    const session = this.session;
    if (!session.player) return;
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
    } else if (input.wasPressed('Escape') || input.wasBlurred() || this.game.touchPad.wasPressed('pause') || this.game.screen.isRotateNeeded) {
      // ゴール後 (リザルトへ進むまでの 3 秒) はポーズしない
      this.openPause();
      return;
    }

    this.game.touchPad.show(this.screen.touchPadOptions());
    this.reader.read(this.controls);
    for (const e of session.step(this.controls, dt)) {
      if (this.screen.handleEvent(e)) this.finishTimer = finishToResultTime;
      if (e.type === 'raceFinished' && this.finishTimer < 0) this.finishTimer = finishToResultTime;
    }
    this.screen.update(dt, this.controls, this.reader.lastUsedKind);
  }

  render(ctx: CanvasRenderingContext2D): void {
    this.screen.render(ctx);
    this.pause?.render(ctx);
  }

  // ---- 準備 ----

  private build(): void {
    const track = getCourseTrack();
    // CPU のレーシングラインも、ここで (LOADING を出している間に) 作っておく
    getCourseRacingLine();
    this.screen.build(track);
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
    this.screen.start(session);
    this.finishTimer = -1;
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
        const player = session?.player;
        this.pause = null;
        if (!session || !player) return;
        // 1 人用のリタイアはその場で結果が確定する (game-design.md 7.7 節)
        session.retire(player.carNumber);
        this.goToResults();
      },
      onQuitToMenu: () => game.changeScene(new MenuScene(game, 'singleRace')),
      onSettingsClosed: () => this.screen.applySettings(),
    });
  }
}
