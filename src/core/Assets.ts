/** 読み込むアセットの一覧。キーは取り出すときの名前、値は URL (/assets/...) */
export interface AssetManifest {
  images: Readonly<Record<string, string>>;
  sounds: Readonly<Record<string, string>>;
  /** まだ作られていない予定のファイル。読めなくても警告を出さない */
  optional?: readonly string[];
}

/** 読み込みの進み具合 (0〜1) を受け取る */
export type LoadProgress = (ratio: number) => void;

/**
 * 画像と音声の事前読み込み。読めないファイルがあっても例外にせず、警告を出して null を返す
 * (呼び出し側が図形での代用や無音にする)。
 */
export class Assets {
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly sounds = new Map<string, AudioBuffer>();

  /**
   * すべて読み終えるか失敗し終えるまで待つ。音声のデコードに AudioContext が要る
   * (resume 前の suspended 状態でもデコードできる)。null なら音声は読まない
   */
  async load(manifest: AssetManifest, audioContext: BaseAudioContext | null, onProgress?: LoadProgress): Promise<void> {
    const optional = new Set(manifest.optional ?? []);
    const imageEntries = Object.entries(manifest.images);
    const soundEntries = audioContext ? Object.entries(manifest.sounds) : [];
    const total = imageEntries.length + soundEntries.length;
    let done = 0;
    const finishOne = (): void => {
      done++;
      onProgress?.(total === 0 ? 1 : done / total);
    };
    const report = (name: string, url: string, reason: unknown): void => {
      if (optional.has(name)) console.info(`未作成のアセットを省きます: ${name} (${url})`);
      else console.warn(`アセットを読み込めません: ${name} (${url})`, reason);
    };

    const tasks: Promise<void>[] = [];
    for (const [name, url] of imageEntries) {
      tasks.push(
        loadImage(url)
          .then((image) => void this.images.set(name, image))
          .catch((reason: unknown) => report(name, url, reason))
          .finally(finishOne),
      );
    }
    if (audioContext) {
      for (const [name, url] of soundEntries) {
        tasks.push(
          loadAudioBuffer(audioContext, url)
            .then((buffer) => void this.sounds.set(name, buffer))
            .catch((reason: unknown) => report(name, url, reason))
            .finally(finishOne),
        );
      }
    } else if (Object.keys(manifest.sounds).length > 0) {
      console.warn('Web Audio API が使えないため、音声を読み込みません');
    }
    onProgress?.(total === 0 ? 1 : 0);
    await Promise.all(tasks);
  }

  /** 読めなかった・一覧にない画像は null */
  getImage(name: string): HTMLImageElement | null {
    return this.images.get(name) ?? null;
  }

  /** 読めなかった・一覧にない音声は null */
  getSound(name: string): AudioBuffer | null {
    return this.sounds.get(name) ?? null;
  }

  hasImage(name: string): boolean {
    return this.images.has(name);
  }

  hasSound(name: string): boolean {
    return this.sounds.has(name);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image load error'));
    image.src = url;
  });
}

async function loadAudioBuffer(context: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.arrayBuffer();
  // 開発サーバーは存在しないファイルに index.html を返すため、デコードの失敗で気づく
  return context.decodeAudioData(data);
}
