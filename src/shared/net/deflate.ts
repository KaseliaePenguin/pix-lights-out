/**
 * deflate (raw) の圧縮・展開。ブラウザ・Worker・node 18 以降にある CompressionStream を使う。
 * 招待・返答コードの SDP 全文形式 (想定外の SDP のときのフォールバック) でだけ使う。
 */

export function isCompressionAvailable(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

async function pipe(
  stream: CompressionStream | DecompressionStream,
  input: Uint8Array<ArrayBuffer>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // 読み出しと並行して書く (先に書き終わるのを待つと、出力が詰まって止まることがある)
  const written = writer.write(input).then(() => writer.close()).catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  await written;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function deflateRaw(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const out = await pipe(new CompressionStream('deflate-raw'), input, Infinity);
  if (!out) throw new Error('deflate failed');
  return out;
}

/** 壊れたデータ・maxBytes を超える展開結果なら null */
export function inflateRaw(input: Uint8Array<ArrayBuffer>, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  return pipe(new DecompressionStream('deflate-raw'), input, maxBytes);
}
