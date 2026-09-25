// ゲームリソース (public/assets と assets-src) の一覧を作る

import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

// ダッシュボードから配信してよいディレクトリ (プロジェクトルートからの相対パス)
export const ASSET_ROOTS = [
  { dir: 'public/assets', label: 'ゲーム用' },
  { dir: 'assets-src', label: '作業中' },
];

export const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.json': 'application/json',
};

function kindOf(ext) {
  const mime = MIME[ext] ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'other';
}

/** PNG の IHDR から幅と高さを読む (他の形式は null) */
function imageSize(file) {
  if (extname(file).toLowerCase() !== '.png') return null;
  const buf = Buffer.alloc(24);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (!entry.name.startsWith('.')) out.push(full);
  }
  return out;
}

/** 配信要求のパスが許可ディレクトリ内の実在ファイルなら絶対パスを返す (ディレクトリ外への参照は拒否) */
export function resolveAssetPath(projectPath, relPath) {
  const full = resolve(projectPath, relPath);
  const allowed = ASSET_ROOTS.some(({ dir }) => {
    const root = resolve(projectPath, dir) + sep;
    return full.startsWith(root);
  });
  if (!allowed || !existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

export function listAssets(projectPath = process.env.DASHBOARD_PROJECT ?? process.cwd()) {
  projectPath = resolve(projectPath);
  const toRel = (f) => relative(projectPath, f).split(sep).join('/');
  const previewDir = join(projectPath, 'assets-src', 'previews');

  const assets = [];
  for (const { dir, label } of ASSET_ROOTS) {
    for (const file of walk(join(projectPath, dir))) {
      const rel = toRel(file);
      // プレビュー画像は元ファイルに添えて表示するので一覧には出さない
      if (rel.startsWith('assets-src/previews/')) continue;
      const ext = extname(file).toLowerCase();
      const kind = kindOf(ext);
      const name = basename(file, ext);
      const st = statSync(file);

      let preview = null;
      if (kind === 'image') {
        const p = join(previewDir, `${name}.png`);
        if (existsSync(p) && resolve(p) !== resolve(file)) preview = toRel(p);
      }
      let waveform = null;
      let seam = null;
      if (kind === 'audio') {
        const w = join(previewDir, 'sound', `${name}.png`);
        const s = join(previewDir, 'sound', `${name}-seam.png`);
        if (existsSync(w)) waveform = toRel(w);
        if (existsSync(s)) seam = toRel(s);
      }

      assets.push({
        path: rel,
        name: basename(file),
        location: label,
        folder: toRel(join(file, '..')),
        kind,
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
        dimensions: kind === 'image' ? imageSize(file) : null,
        preview,
        waveform,
        seam,
      });
    }
  }
  assets.sort((a, b) => a.location.localeCompare(b.location) || a.path.localeCompare(b.path));
  return { generatedAt: new Date().toISOString(), projectPath, assets };
}
