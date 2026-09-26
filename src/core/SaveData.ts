/**
 * 保存形式のバージョン。形を変えたら上げ、readRoot / readGhost で古い形を読み替える。
 * 1: 記録の有効判定に物理のバージョン番号 (physicsVersion: number) を使っていた形
 * 2: 有効判定をバージョン文字列 (recordVersion: string) にした形
 */
const dataVersion = 2;
const knownVersions: readonly number[] = [1, 2];

/**
 * 自己ベスト・ゴーストが今のゲームで使えるかを表す文字列 (例: `${physicsVersion}-${trackVersion}`)。
 * 保存時と違えば、読むときに破棄する。数値を渡した場合は文字列にして比べる
 */
export type RecordVersion = string | number;

/** コースごとの自己ベスト */
export interface CourseBest {
  bestLap: number | null;
  /** 保存されている全期間の最速区間 (未記録は null) */
  bestSectors: (number | null)[];
}

interface CourseEntry extends CourseBest {
  recordVersion: string;
}

interface SaveRoot {
  version: number;
  /** 設定の中身は呼び出し側 (settingsStorage) が検証する */
  settings: Record<string, unknown> | null;
  courses: Record<string, CourseEntry>;
}

interface GhostEntry {
  version: number;
  recordVersion: string;
  /** ゴーストをシリアライズした文字列 (形式は shared/ghost.ts が決める) */
  data: string;
}

/**
 * localStorage のセーブデータ: 設定、コースごとの自己ベスト、コースごとのゴースト。
 * 読み書きは try/catch で囲み、保存できない環境 (プライベートモード・容量不足) でも起動中はメモリ上の値を保つ。
 * 自己ベストとゴーストはバージョン文字列と一緒に保存し、読むときに違えば破棄する。
 * ゴーストは 1 周 約 10 KB あるため、失敗しても他のデータを巻き込まないよう別のキーに置く。
 * 知らない形式 (新しい版で保存されたなど) のデータを見つけたら、それを壊さないよう、そのキーには書き込まない。
 */
export class SaveData {
  private root: SaveRoot | null = null;
  /** 設定・自己ベストのキーに書き込んでよいか (知らない形式を読んだら false) */
  private isRootWritable = true;
  private readonly ghosts = new Map<string, GhostEntry | null>();
  /** 知らない形式のゴーストが入っているコース (そのキーには書き込まない) */
  private readonly foreignGhosts = new Set<string>();

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

  /** コースの自己ベスト。記録がない・バージョンが違う (破棄する) ときは null */
  loadBest(courseId: string, version: RecordVersion): CourseBest | null {
    const entry = this.getCourse(courseId, String(version));
    return entry ? { bestLap: entry.bestLap, bestSectors: [...entry.bestSectors] } : null;
  }

  saveBest(courseId: string, version: RecordVersion, best: CourseBest): void {
    const recordVersion = String(version);
    const root = this.getRoot();
    const old = root.courses[courseId];
    if (old && old.recordVersion !== recordVersion) this.discardGhost(courseId);
    root.courses[courseId] = { recordVersion, bestLap: best.bestLap, bestSectors: [...best.bestSectors] };
    this.writeRoot();
  }

  // ---- ゴースト ----

  /** コースのゴースト (シリアライズした文字列)。ない・バージョンが違う (破棄する) ときは null */
  loadGhost(courseId: string, version: RecordVersion): string | null {
    const entry = this.getGhostEntry(courseId);
    if (!entry) return null;
    if (entry.recordVersion !== String(version)) {
      this.discardGhost(courseId);
      return null;
    }
    return entry.data;
  }

  /**
   * 保存できたら true。失敗しても起動中は loadGhost で読める。
   * 失敗したときは古いゴーストを消す (次の起動で自己ベストより遅いゴーストを読まないように)
   */
  saveGhost(courseId: string, version: RecordVersion, data: string): boolean {
    const entry: GhostEntry = { version: dataVersion, recordVersion: String(version), data };
    this.getGhostEntry(courseId);
    this.ghosts.set(courseId, entry);
    if (this.foreignGhosts.has(courseId)) return false;
    const key = this.ghostKey(courseId);
    if (writeItem(key, JSON.stringify(entry))) return true;
    removeItem(key);
    return false;
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

  private getCourse(courseId: string, recordVersion: string): CourseEntry | null {
    const root = this.getRoot();
    const entry = root.courses[courseId];
    if (!entry) return null;
    if (entry.recordVersion !== recordVersion) {
      delete root.courses[courseId];
      this.writeRoot();
      this.discardGhost(courseId);
      return null;
    }
    return entry;
  }

  private getGhostEntry(courseId: string): GhostEntry | null {
    if (!this.ghosts.has(courseId)) {
      const data = parseJson(readItem(this.ghostKey(courseId)));
      if (isForeign(data)) {
        console.warn(`ゴーストの形式が違うため読み込みません (上書きもしません): ${courseId}`);
        this.foreignGhosts.add(courseId);
      }
      this.ghosts.set(courseId, toGhostEntry(data));
    }
    return this.ghosts.get(courseId) ?? null;
  }

  private discardGhost(courseId: string): void {
    this.getGhostEntry(courseId);
    this.ghosts.set(courseId, null);
    if (!this.foreignGhosts.has(courseId)) removeItem(this.ghostKey(courseId));
  }

  private readRoot(): SaveRoot {
    const root: SaveRoot = { version: dataVersion, settings: null, courses: {} };
    const data = parseJson(readItem(this.rootKey));
    if (isForeign(data)) {
      // 新しい版で保存されたなどで読めない。既定値で続け、ユーザーのデータを壊さないよう書き込まない
      console.warn('セーブデータの形式が違うため読み込みません (上書きもしません)');
      this.isRootWritable = false;
    } else if (isRecord(data)) {
      if (isRecord(data.settings)) root.settings = data.settings;
      if (isRecord(data.courses)) {
        for (const [id, value] of Object.entries(data.courses)) {
          const entry = toCourseEntry(value);
          if (entry) root.courses[id] = entry;
        }
      }
    }
    if (root.settings === null && this.isRootWritable) {
      // セーブデータ導入前の設定のキー
      const legacy = parseJson(readItem(`${this.keyPrefix}.settings`));
      if (isRecord(legacy)) root.settings = legacy;
    }
    return root;
  }

  private writeRoot(): void {
    if (!this.isRootWritable) return;
    writeItem(this.rootKey, JSON.stringify(this.getRoot()));
  }
}

/** 形式のバージョンが付いているが、このコードの知らないものか (壊れたデータ・空は false) */
function isForeign(data: unknown): boolean {
  return isRecord(data) && !(typeof data.version === 'number' && knownVersions.includes(data.version));
}

/** 形式 1 の physicsVersion (数値) は、その数値の文字列として読む */
function toRecordVersion(value: Record<string, unknown>): string | null {
  if (typeof value.recordVersion === 'string') return value.recordVersion;
  if (typeof value.physicsVersion === 'number') return String(value.physicsVersion);
  return null;
}

function toCourseEntry(value: unknown): CourseEntry | null {
  if (!isRecord(value)) return null;
  const recordVersion = toRecordVersion(value);
  if (recordVersion === null) return null;
  const bestLap = isPositiveNumber(value.bestLap) ? value.bestLap : null;
  const bestSectors = Array.isArray(value.bestSectors)
    ? value.bestSectors.map((v: unknown) => (isPositiveNumber(v) ? v : null))
    : [];
  return { recordVersion, bestLap, bestSectors };
}

function toGhostEntry(data: unknown): GhostEntry | null {
  if (!isRecord(data) || isForeign(data) || typeof data.data !== 'string') return null;
  const recordVersion = toRecordVersion(data);
  if (recordVersion === null) return null;
  return { version: dataVersion, recordVersion, data: data.data };
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
