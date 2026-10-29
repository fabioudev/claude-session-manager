import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readInitialTranscript,
  scanLines,
  splitBufferLines,
  statTranscript,
} from '../server/transcript/reader.js'

let dir = ''

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

describe('splitBufferLines', () => {
  it('splits complete lines and keeps the trailing partial line', () => {
    const result = splitBufferLines(Buffer.from('{"a":1}\n{"b":2}\n{"c"'), false)
    expect(result.lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(result.remainder.toString()).toBe('{"c"')
  })

  it('drops the first partial line when reading from the middle of a file', () => {
    const result = splitBufferLines(Buffer.from('partial\n{"b":2}\nrest'), true)
    expect(result.lines).toEqual(['{"b":2}'])
    expect(result.remainder.toString()).toBe('rest')
  })

  it('keeps everything as remainder when no newline exists', () => {
    const result = splitBufferLines(Buffer.from('no newline'), false)
    expect(result.lines).toEqual([])
    expect(result.remainder.toString()).toBe('no newline')
    expect(splitBufferLines(Buffer.from('no newline'), true).remainder.length).toBe(0)
  })

  it('handles empty buffers and blank lines', () => {
    expect(splitBufferLines(Buffer.alloc(0), false)).toEqual({
      lines: [],
      remainder: Buffer.alloc(0),
    })
    expect(splitBufferLines(Buffer.from('\n\n{"a":1}\n\n'), false).lines).toEqual(['{"a":1}'])
  })
})

describe('transcript file reads', () => {
  it('returns null for a missing file', async () => {
    expect(await statTranscript('/definitely/not/here.jsonl')).toBeNull()
  })

  it('reads a small file whole and keeps a trailing partial record', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'csm-reader-'))
    const file = path.join(dir, 'session.jsonl')
    await writeFile(file, '{"a":1}\n{"b":2}\n{"c"', 'utf8')
    const info = await statTranscript(file)
    expect(info?.size).toBeGreaterThan(0)
    const read = await readInitialTranscript(file, info!, { headBytes: 1024, tailBytes: 1024 })
    expect(read.lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(read.remainder.toString()).toBe('{"c"')
    expect(read.offset).toBe(info!.size)
    expect(read.headLineCount).toBe(2)
    expect(read.headEnd).toBe('{"a":1}\n{"b":2}\n'.length)
  })

  it('reads the head and tail of a large file without loading the middle', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'csm-reader-'))
    const file = path.join(dir, 'large.jsonl')
    const lines: string[] = []
    for (let index = 0; index < 100; index += 1) {
      lines.push(JSON.stringify({ index, padding: 'x'.repeat(100) }))
    }
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
    const info = await statTranscript(file)
    const read = await readInitialTranscript(file, info!, { headBytes: 1000, tailBytes: 1500 })
    expect(read.lines[0]).toContain('"index":0')
    expect(read.lines.at(-1)).toContain('"index":99')
    expect(read.lines.length).toBeLessThan(100)
    expect(read.offset).toBe(info!.size)
    expect(read.headLineCount).toBeGreaterThan(0)
    expect(read.headLineCount).toBeLessThan(read.lines.length)
    expect(read.headEnd).toBeLessThanOrEqual(1000)
    expect(read.headEnd).toBeGreaterThan(0)
    expect(read.lines[read.headLineCount - 1]).toContain(`"index":${read.headLineCount - 1}`)
  })

  it('scans forward from the head boundary in bounded chunks', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'csm-reader-'))
    const file = path.join(dir, 'scan.jsonl')
    const lines: string[] = []
    for (let index = 0; index < 100; index += 1) {
      lines.push(JSON.stringify({ index, padding: 'x'.repeat(100) }))
    }
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
    const info = await statTranscript(file)
    const read = await readInitialTranscript(file, info!, { headBytes: 500, tailBytes: 500 })
    const seen: number[] = []
    const hit = await scanLines(
      file,
      read.headEnd,
      info!.size,
      (chunk) => {
        for (const line of chunk) seen.push((JSON.parse(line) as { index: number }).index)
        return seen.includes(12)
      },
      { chunkBytes: 128, maxBytes: 4096 },
    )
    expect(hit).toBe(true)
    expect(seen[0]).toBe(read.headLineCount)
    expect(seen).toContain(12)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('stops scanning at the byte budget', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'csm-reader-'))
    const file = path.join(dir, 'budget.jsonl')
    const lines: string[] = []
    for (let index = 0; index < 100; index += 1) {
      lines.push(JSON.stringify({ index, padding: 'x'.repeat(100) }))
    }
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
    const info = await statTranscript(file)
    const hit = await scanLines(file, 0, info!.size, () => false, {
      chunkBytes: 128,
      maxBytes: 256,
    })
    expect(hit).toBe(false)
  })
})
