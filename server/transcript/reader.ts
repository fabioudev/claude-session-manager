import { open, stat } from 'node:fs/promises'

export interface FileInfo {
  size: number
  mtimeMs: number
  ino: number | null
}

export async function statTranscript(file: string): Promise<FileInfo | null> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return null
    return {
      size: info.size,
      mtimeMs: info.mtimeMs,
      ino: typeof info.ino === 'number' ? info.ino : null,
    }
  } catch {
    return null
  }
}

export async function readSlice(file: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0)
  const handle = await open(file, 'r')
  try {
    const length = end - start
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read)
      if (bytesRead <= 0) break
      read += bytesRead
    }
    return read === length ? buffer : buffer.subarray(0, read)
  } finally {
    await handle.close()
  }
}

export interface SplitResult {
  lines: string[]
  /** Bytes after the last newline, kept for the next append. */
  remainder: Buffer
}

/**
 * Split a byte slice into complete JSONL lines. When the slice starts mid-line (a tail
 * read), `dropFirstPartial` removes the leading fragment. The final partial line is
 * always kept as a Buffer so a multi-byte character cannot be corrupted between reads.
 */
export function splitBufferLines(buffer: Buffer, dropFirstPartial: boolean): SplitResult {
  if (!buffer.length) return { lines: [], remainder: Buffer.alloc(0) }
  const lastNewline = buffer.lastIndexOf(0x0a)
  const completeEnd = lastNewline + 1
  if (completeEnd === 0) {
    // No newline at all: either a partial line from the middle of the file (drop it)
    // or the start of a line we are still receiving (keep it).
    return { lines: [], remainder: dropFirstPartial ? Buffer.alloc(0) : buffer }
  }
  const remainder = buffer.subarray(completeEnd)
  let complete = buffer.subarray(0, completeEnd)
  if (dropFirstPartial) {
    const firstNewline = complete.indexOf(0x0a)
    if (firstNewline === -1) return { lines: [], remainder }
    complete = complete.subarray(firstNewline + 1)
  }
  const text = complete.toString('utf8')
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  return { lines, remainder }
}

export interface InitialRead {
  lines: string[]
  remainder: Buffer
  offset: number
  /** Byte offset just past the last complete head line — safe to resume a scan. */
  headEnd: number
  /** How many of `lines` came from the head; the rest are the tail. */
  headLineCount: number
}

/**
 * Read the useful ends of a transcript without ever loading a 300 MB file:
 * a small head (first prompt, metadata) and a larger tail (recent activity).
 */
export async function readInitialTranscript(
  file: string,
  info: FileInfo,
  options: { headBytes?: number; tailBytes?: number } = {},
): Promise<InitialRead> {
  const headBytes = options.headBytes ?? 131_072
  const tailBytes = options.tailBytes ?? 1_048_576
  const size = info.size

  if (size <= headBytes + tailBytes) {
    const buffer = await readSlice(file, 0, size)
    const { lines, remainder } = splitBufferLines(buffer, false)
    return {
      lines,
      remainder,
      offset: size,
      headEnd: size - remainder.length,
      headLineCount: lines.length,
    }
  }

  const headBuffer = await readSlice(file, 0, headBytes)
  const head = splitBufferLines(headBuffer, false)
  const tailStart = Math.max(headBytes, size - tailBytes)
  const tailBuffer = await readSlice(file, tailStart, size)
  const tail = splitBufferLines(tailBuffer, true)
  return {
    lines: [...head.lines, ...tail.lines],
    remainder: tail.remainder,
    offset: size,
    headEnd: headBytes - head.remainder.length,
    headLineCount: head.lines.length,
  }
}

/**
 * Read complete lines from a known line boundary forward, one bounded chunk at a
 * time, until `onLines` reports it has what it needs. Used to find a session's
 * first prompt when slash commands or long pastes push it past the head window;
 * the caller never has to load the middle of a huge transcript.
 */
export async function scanLines(
  file: string,
  start: number,
  size: number,
  onLines: (lines: string[]) => boolean,
  options: { maxBytes?: number; chunkBytes?: number } = {},
): Promise<boolean> {
  const budget = options.maxBytes ?? 4 * 1024 * 1024
  const chunkBytes = options.chunkBytes ?? 262_144
  const limit = Math.min(size, start + budget)
  let cursor = start
  let carry: Buffer = Buffer.alloc(0)
  while (cursor < limit) {
    const end = Math.min(limit, cursor + chunkBytes)
    const slice = await readSlice(file, cursor, end)
    const buffer = carry.length ? Buffer.concat([carry, slice]) : slice
    const { lines, remainder } = splitBufferLines(buffer, false)
    carry = remainder
    if (onLines(lines)) return true
    cursor = end
  }
  return false
}
