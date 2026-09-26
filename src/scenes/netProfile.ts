import type { NetProfile } from '../net/NetClientSession';
import { isValidPlayerName } from '../shared/net/messages';

/**
 * オンライン対戦の名前とチーム。次に開いたときも同じ値で始められるよう localStorage に残す
 * (保存できない環境では起動中だけ覚える)。初回は入力画面を出さず PLAYER + 乱数 2 桁で始め、ロビーでいつでも変えられる
 */
const storageKey = 'pix-lights-out:net-profile';

let current: NetProfile | null = null;

/** 名前の入力中の文字を整える (英大文字と数字だけ、8 文字まで) */
export function filterPlayerName(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

export function loadNetProfile(): NetProfile {
  if (!current) {
    current = readStored() ?? {
      name: `PLAYER${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`,
      team: 1 + Math.floor(Math.random() * 8),
    };
  }
  return { ...current };
}

export function saveNetProfile(profile: NetProfile): void {
  current = { ...profile };
  try {
    localStorage.setItem(storageKey, JSON.stringify(current));
  } catch {
    // 保存できなくても起動中は current で続ける
  }
}

function readStored(): NetProfile | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const v = JSON.parse(raw) as { name?: unknown; team?: unknown };
    if (!isValidPlayerName(v.name) || typeof v.team !== 'number' || !Number.isInteger(v.team) || v.team < 1 || v.team > 8) return null;
    return { name: v.name, team: v.team };
  } catch {
    return null;
  }
}
