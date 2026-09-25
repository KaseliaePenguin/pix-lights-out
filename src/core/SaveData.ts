/** 保存形式のバージョン。形を変えたら上げ、readRoot で古い形を読み替える */
const dataVersion = 1;

/** コースごとの自己ベスト */
export interface CourseBest {
  bestLap: number | null;
  /** 保存されている全期間の最速区間 (未記録は null) */
  bestSectors: (number | null)[];
}

interface CourseEntry extends CourseBest {
  physicsVersion: number;
}

interface SaveRoot {
  version: number;
  /** 設定の中身は呼び出し側 (settingsStorage) が検証する */
  settings: Record<string, unknown> | null;
  courses: Record<string, CourseEntry>;
}

interface GhostEntry {
  version: number;
  physicsVersion: number;
  /** ゴーストをシリアライズした文字列 (形式は shared/ghost.ts が決める) */
  data: string;
}

/**
 * localStorage のセーブデータ: 設定、コースごとの自己ベスト、コースごとのゴースト。
 * 読み書きは try/catch で囲み、保存できない環境 (プライベートモード・容量不足) でも起動中はメモリ上の値を保つ。
 * 自己ベストとゴーストは物理のバージョン番号と一緒に保存し、読むときに違えば破棄する。
 * ゴーストは 1 周 約 18 KB あるため、失敗しても他のデータを巻き込まないよう別のキーに置く。
 */
export class SaveData {
  private root: SaveRoot | null = null;
  private readonly ghosts = new Map<string, GhostEntry | null>();

  constructor(private readonly keyPrefix: string) {}

  // ---- 設定 ----

  /** 保存されている設定 (未検証)。なければ null */
  loadSettings(): Record<string, unknown> | null {
    const settings = this.getRoot().settings;
    return settings ? { ...settings } : null;
  }

  saveSettings(settings: object): void {
    this.getRoot().settings = { ...(settings as Record<string, unknown>) };
    this.writeRoot();
  }

  // ---- 自己ベスト ----

  /** コースの自己ベスト。記録がない・物理のバージョンが違う (破棄する) ときは null */
  loadBest(courseId: string, physicsVersion: number): CourseBest | null {
    const entry = this.getCourse(courseId, physicsVersion);
    return entry ? { bestLap: entry.bestLap, bestSectors: [...entry.bestSectors] } : null;
  }

  saveBest(courseId: string, physicsVersion: number, best: CourseBest): void {
    const root = this.getRoot();
    const old = root.courses[courseId];
    if (old && old.physicsVersion !== physicsVersion) this.discardGhost(courseId);
    root.courses[courseId] = { physicsVersion, bestLap: best.bestLap, bestSectors: [...best.bestSectors] };
    this.writeRoot();
  }

  // ---- ゴースト ----

  /** コースのゴースト (シリアライズした文字列)。ない・物理のバージョンが違う (破棄する) ときは null */
  loadGhost(courseId: string, physicsVersion: number): string | null {
    const entry = this.getGhostEntry(courseId);
    if (!entry) return null;
    if (entry.physicsVersion !== physicsVersion) {
      this.discardGhost(courseId);
      return null;
    }
    return entry.data;
  }

  /** 保存できたら true。失敗しても起動中は loadGhost で読める */
  saveGhost(courseId: string, physicsVersion: number, data: string): boolean {
    const entry: GhostEntry = { version: dataVersion, physicsVersion, data };
    this.ghosts.set(courseId, entry);
    return writeItem(this.ghostKey(courseId), JSON.stringify(entry));
  }

  /** コースの自己ベストとゴーストを消す */
  clearCourse(courseId: string): void {
    delete this.getRoot().courses[courseId];
    this.writeRoot();
    this.discardGhost(courseId);
  }

  // ---- 内部 ----

  private get rootKey(): string {
    return `${this.keyPrefix}.save`;
  }

  private ghostKey(courseId: string): string {
    return `${this.keyPrefix}.ghost.${courseId}`;
  }

  private getRoot(): SaveRoot {
    this.root ??= this.readRoot();
    return this.root;
  }

  private getCourse(courseId: string, physicsVersion: number): CourseEntry | null {
    const root = this.getRoot();
    const entry = root.courses[courseId];
    if (!entry) return null;
    if (entry.physicsVersion !== physicsVersion) {
      delete root.courses[courseId];
      this.writeRoot();
      this.discardGhost(courseId);
      return null;
    }
    return entry;
  }

  private getGhostEntry(courseId: string): GhostEntry | null {
    if (!this.ghosts.has(courseId)) this.ghosts.set(courseId, readGhost(this.ghostKey(courseId)));
    return this.ghosts.get(courseId) ?? null;
  }

  private discardGhost(courseId: string): void {
    this.ghosts.set(courseId, null);
    removeItem(this.ghostKey(courseId));
  }

  private readRoot(): SaveRoot {
    const root: SaveRoot = { version: dataVersion, settings: null, courses: {} };
    const data = parseJson(readItem(this.rootKey));
    if (isRecord(data) && data.version === dataVersion) {
      if (isRecord(data.settings)) root.settings = data.settings;
      if (isRecord(data.courses)) {
        for (const [id, value] of Object.entries(data.courses)) {
          const entry = toCourseEntry(value);
          if (entry) root.courses[id] = entry;
        }
      }
    } else if (data !== null) {
      // 知らないバージョン (新しい版で保存されたなど) は読まずに既定値で続ける。上書きは保存時まで起きない
      console.warn('セーブデータの形式が違うため読み込みません');
    }
    if (root.settings === null) {
      // セーブデータ導入前の設定のキー
      const legacy = parseJson(readItem(`${this.keyPrefix}.settings`));
      if (isRecord(legacy)) root.settings = legacy;
    }
    return root;
  }

  private writeRoot(): void {
    writeItem(this.rootKey, JSON.stringify(this.getRoot()));
  }
}

function toCourseEntry(value: unknown): CourseEntry | null {
  if (!isRecord(value) || typeof value.physicsVersion !== 'number') return null;
  const bestLap = isPositiveNumber(value.bestLap) ? value.bestLap : null;
  const bestSectors = Array.isArray(value.bestSectors)
    ? value.bestSectors.map((v: unknown) => (isPositiveNumber(v) ? v : null))
    : [];
  return { physicsVersion: value.physicsVersion, bestLap, bestSectors };
}

function readGhost(key: string): GhostEntry | null {
  const data = parseJson(readItem(key));
  if (
    isRecord(data) &&
    data.version === dataVersion &&
    typeof data.physicsVersion === 'number' &&
    typeof data.data === 'string'
  ) {
    return { version: dataVersion, physicsVersion: data.physicsVersion, data: data.data };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    console.warn('壊れたセーブデータを無視します');
    return null;
  }
}

function readItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeItem(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 消せなくても、メモリ上では破棄済みとして扱う
  }
}
