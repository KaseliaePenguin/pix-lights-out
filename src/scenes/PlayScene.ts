import type { Game } from '../core/Game';
import type { Scene } from '../core/Scene';
import { Player } from '../entities/Player';
import { drawCarStatusPanel } from '../ui/carStatusPanel';
import { drawCheckpointArrow } from '../ui/checkpointArrow';
import { colors } from '../ui/colors';
import { drawDebugPanel } from '../ui/debugPanel';
import { toDisplayKmh } from '../ui/format';
import { drawGhostDelta } from '../ui/ghostDelta';
import { hudMessages } from '../ui/hudMessages';
import { MessageQueue } from '../ui/MessageQueue';
import { drawMessageBand } from '../ui/messageBand';
import { drawText } from '../ui/text';
import { drawTimingPanel } from '../ui/timingPanel';
import type { TimingResult } from '../ui/timingPanel';
import { MenuScene } from './MenuScene';
import { PauseScene } from './PauseScene';
import { loadSettings } from './settingsStorage';

/**
 * 仮のプレイ画面。RaceScene (基盤ができてから作る) に置き換えるまでの間、
 * ポーズ画面と HUD 部品の動作確認に使う。HUD に出している値はすべて見本 (実際の計測ではない)。
 */
export class PlayScene implements Scene {
  private readonly player: Player;
  private readonly messages = new MessageQueue();
  private pause: PauseScene | null = null;
  private isGhostVisible = loadSettings().showGhost;
  private isDebugVisible = false;
  private isWrongWayDemo = false;
  private isDrsOpen = false;
  private lapTime = 0;
  private speed = 0;

  constructor(private readonly game: Game) {
    this.player = new Player(game.width / 2, game.height / 2);
  }

  update(dt: number): void {
    if (this.pause) {
      this.pause.update(dt);
      return;
    }
    const { input } = this.game;
    if (input.wasPressed('Escape')) {
      this.openPause();
      return;
    }

    const prevX = this.player.x;
    const prevY = this.player.y;
    this.player.update(dt, input, this.game.width, this.game.height);
    this.speed = Math.hypot(this.player.x - prevX, this.player.y - prevY) / dt;
    this.lapTime += dt;

    // 見本: Space で DRS、R で逆走警告、F3 でデバッグ表示
    if (input.wasPressed('Space')) {
      this.isDrsOpen = !this.isDrsOpen;
      if (this.isDrsOpen) this.messages.push(hudMessages.drsEnabled());
    }
    if (input.wasPressed('KeyR')) {
      this.isWrongWayDemo = !this.isWrongWayDemo;
      this.messages.setStatus('wrongWay', this.isWrongWayDemo ? hudMessages.wrongWay() : null);
    }
    if (input.wasPressed('F3')) this.isDebugVisible = !this.isDebugVisible;
    this.messages.update(dt);
  }

  render(ctx: CanvasRenderingContext2D): void {
    this.player.render(ctx);
    drawText(ctx, 'MOVE: WASD  DRS: SPACE  WRONG WAY: R  DEBUG: F3', 12, 12, { color: colors.subtext });

    // 見本の区間結果: 経過時間に応じて S1〜S3 が埋まっていく
    const sampleSectors: readonly TimingResult[] = ['personal', 'slower', 'overall'];
    const sectors = sampleSectors.map((result, i): TimingResult => (this.lapTime % 45 > (i + 1) * 15 ? result : 'none'));
    drawTimingPanel(ctx, {
      currentLapTime: this.lapTime % 45,
      isCurrentLapInvalid: false,
      sectors,
      bestLapTime: 41.234,
      bestLapResult: 'overall',
      lastLapTime: 42.1,
      lastLapResult: 'slower',
    });
    drawMessageBand(ctx, this.messages.getDisplay());
    drawCarStatusPanel(ctx, {
      speedKmh: toDisplayKmh(this.speed),
      gear: this.speed > 0 ? 3 : 'N',
      drs: this.isDrsOpen ? 'active' : 'available',
    });
    if (this.isGhostVisible) drawGhostDelta(ctx, Math.sin(this.lapTime * 0.5) * 0.5);
    if (this.isWrongWayDemo) drawCheckpointArrow(ctx, this.lapTime);
    if (this.isDebugVisible) {
      drawDebugPanel(ctx, [
        ['SPEED', `${Math.round(this.speed)}`],
        ['GRIP USE', '0.00'],
        ['GRIP MUL', '1.00'],
        ['SURFACE', 'ASPHALT'],
      ]);
    }

    this.pause?.render(ctx);
  }

  private openPause(): void {
    const game = this.game;
    this.pause = new PauseScene(game, {
      onResume: () => {
        this.pause = null;
      },
      onRestart: () => game.changeScene(new PlayScene(game)),
      onQuitToMenu: () => game.changeScene(new MenuScene(game)),
      onSettingsClosed: () => {
        this.isGhostVisible = loadSettings().showGhost;
      },
    });
  }
}
