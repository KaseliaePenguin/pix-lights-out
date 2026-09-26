/**
 * ページを開いたまま招待リンクを開いた (アドレス欄に貼った。フラグメントだけが変わり読み込み直されない) ときの受け先。
 * 招待を受け取れるシーン (タイトル・メニュー・参加画面など) が enter で登録し、exit で外す。
 * 登録がない (レース中など) ときは routeInvite が false を返し、呼び出し側が「今は使えない」と知らせる
 */
export type InviteHandler = (inviteCode: string) => void;

let current: InviteHandler | null = null;

export function setInviteHandler(handler: InviteHandler): void {
  current = handler;
}

/** 自分が登録したものだけを外す (次のシーンの enter が先に登録していても消さない) */
export function clearInviteHandler(handler: InviteHandler): void {
  if (current === handler) current = null;
}

/** 招待コードを今のシーンに渡す。受け取れるシーンがなければ false */
export function routeInvite(inviteCode: string): boolean {
  if (!current) return false;
  current(inviteCode);
  return true;
}
