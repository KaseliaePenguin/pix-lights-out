/**
 * Origin の確認。allowed はカンマ区切りの一覧 (例: `https://kaseliaepenguin.github.io,http://localhost:*`)。
 * ポートを `*` にした項目は、そのホストのどのポートでも通す (開発サーバーのポートが変わっても使えるように)。
 * Origin がない要求 (ブラウザ以外) は通さない
 */
export function isAllowedOrigin(origin: string | null, allowed: string): boolean {
  if (!origin) return false;
  for (const raw of allowed.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === origin) return true;
    if (entry.endsWith(':*')) {
      const base = entry.slice(0, -2);
      if (origin === base || (origin.startsWith(`${base}:`) && /^\d{1,5}$/.test(origin.slice(base.length + 1)))) return true;
    }
  }
  return false;
}
