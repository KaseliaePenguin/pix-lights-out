import type { LobbyPlayer } from '../shared/net/messages';
import { colors } from './colors';
import type { OverlayRect } from './DomOverlay';
import { drawFrame, drawPanel } from './panel';
import { teamOf } from './teams';
import { drawText } from './text';

/** 参加者一覧の 1 枠 (枠 0 はホスト本人) */
export interface LobbyRowView {
  slot: number;
  /** 参加済みの人 (いなければ null) */
  player: LobbyPlayer | null;
  /** 参加者がいないときの状態の表示 (OPEN、INVITED 9:41 など) */
  status: string;
  statusColor: string;
  isSelf: boolean;
  /** 招待コード欄に出している枠 (ホストだけ) */
  isSelected: boolean;
}

export const lobbyRowHeight = 24;
const headerH = 26;

/** 一覧の高さ (見出し + 8 行) */
export function lobbyListHeight(rows: number): number {
  return headerH + rows * lobbyRowHeight + 6;
}

/** 行の範囲 (クリックの判定用) */
export function lobbyRowRect(x: number, y: number, w: number, index: number): OverlayRect {
  return { x, y: y + headerH + index * lobbyRowHeight, w, h: lobbyRowHeight };
}

/**
 * 参加者一覧 (network.md「ホストの画面」): 枠番号、チーム色の帯、名前、チーム略称、準備状態、接続経路 LAN/NET、往復遅延。
 * 自分の行は地を overlay、選択中の枠は白の枠で囲む
 */
export function drawLobbyList(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, title: string, rows: readonly LobbyRowView[]): void {
  drawPanel(ctx, x, y, w, lobbyListHeight(rows.length));
  drawText(ctx, title, x + 8, y + 8, { color: colors.subtext });
  rows.forEach((row, i) => {
    const r = lobbyRowRect(x + 4, y, w - 8, i);
    const textY = r.y + 5;
    if (row.isSelf) {
      ctx.fillStyle = colors.overlay;
      ctx.fillRect(r.x, r.y, r.w, r.h - 2);
    }
    if (row.isSelected) drawFrame(ctx, r.x, r.y, r.w, r.h - 2, colors.white);
    drawText(ctx, String(row.slot), r.x + 8, textY, { color: colors.subtext });
    const p = row.player;
    if (!p) {
      drawText(ctx, row.status, r.x + 34, textY, { color: row.statusColor });
      return;
    }
    const team = teamOf(p.team);
    ctx.fillStyle = team.color;
    ctx.fillRect(r.x + 24, r.y + 4, 4, 16);
    drawText(ctx, p.name, r.x + 34, textY, { color: colors.white });
    drawText(ctx, `${p.team} ${team.abbr}`, r.x + 142, textY, { color: colors.text });
    drawText(ctx, p.isReady ? 'READY' : '-', r.x + 206, textY, { color: p.isReady ? colors.hudGreen : colors.midGrey });
    if (row.slot === 0) drawText(ctx, 'HOST', r.x + 280, textY, { color: colors.yellow });
    else if (p.route) drawText(ctx, p.route === 'lan' ? 'LAN' : 'NET', r.x + 280, textY, { color: colors.text });
    if (p.rttMs !== null) drawText(ctx, `${p.rttMs}MS`, r.x + r.w - 8, textY, { color: colors.text, align: 'right' });
  });
}

/** 押せるボタン (Canvas に描く)。選択中は白の枠 */
export function drawButton(ctx: CanvasRenderingContext2D, rect: OverlayRect, label: string, isEnabled = true, isFocused = false): void {
  drawPanel(ctx, rect.x, rect.y, rect.w, rect.h, isFocused ? colors.white : colors.overlay);
  drawText(ctx, label, rect.x + rect.w / 2, rect.y + (rect.h - 14) / 2, { color: isEnabled ? colors.white : colors.midGrey, align: 'center' });
}
