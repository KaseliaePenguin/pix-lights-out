import type { HostLobby } from '../host/HostLobby';

/**
 * ホストのタブを閉じる・再読み込みしようとしたとき、参加者がいる間は確認ダイアログを出す
 * (network.md「ホストのタブがバックグラウンドに回ったときの対策」の 7)。ロビーを作ってから閉じるまで有効にする
 */
const guards = new Map<HostLobby, (e: BeforeUnloadEvent) => void>();

export function guardHostTab(lobby: HostLobby): void {
  if (guards.has(lobby)) return;
  const handler = (e: BeforeUnloadEvent) => {
    if (!lobby.hasGuests) return;
    e.preventDefault();
    // 古いブラウザは returnValue を設定しないとダイアログを出さない
    e.returnValue = '';
  };
  guards.set(lobby, handler);
  window.addEventListener('beforeunload', handler);
}

/** ロビーを閉じる (全員に hostClosed) */
export function closeHostLobby(lobby: HostLobby): void {
  const handler = guards.get(lobby);
  if (handler) window.removeEventListener('beforeunload', handler);
  guards.delete(lobby);
  lobby.close();
}
