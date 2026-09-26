/**
 * クリップボード (network.md「手間を減らす工夫」の 3)。navigator.clipboard は https か localhost でだけ使える。
 * 使えないとき (権限の拒否など) は、コードの読み取り専用テキスト欄を選択して Ctrl+C してもらう。
 */

/** text をコピーする。fallback は選択してコピーを試すテキスト欄 */
export async function copyText(text: string, fallback: HTMLTextAreaElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 下の方法を試す
  }
  if (!fallback) return false;
  try {
    fallback.focus();
    fallback.select();
    // 古い方法 (非推奨だが、navigator.clipboard が使えない環境の代わり)
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

/** クリップボードの文字を読む。読めなければ null (権限の拒否・非対応) */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText) return null;
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
