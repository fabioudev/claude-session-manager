import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeRegistry } from '../server/registry.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function jobFolder(
  root: string,
  jobId: string,
  state: Record<string, unknown>,
  adopted: boolean,
): Promise<void> {
  const dir = path.join(root, jobId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state))
  if (adopted) {
    await writeFile(
      path.join(dir, 'adopt.json'),
      JSON.stringify({ writtenAtMs: Date.now(), origin: 'exit', shells: [] }),
    )
  }
}

async function harness(): Promise<{ registry: ClaudeRegistry; jobsDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'csm-registry-'))
  dirs.push(root)
  const jobsDir = path.join(root, 'jobs')
  const registry = new ClaudeRegistry({
    sessionsDir: path.join(root, 'sessions'),
    jobsDir,
  })
  return { registry, jobsDir }
}

describe('background job registry', () => {
  it('reports a running job as not exited and one with an adopt record as exited', async () => {
    const { registry, jobsDir } = await harness()
    const recent = new Date().toISOString()
    await jobFolder(
      jobsDir,
      'live-job',
      { state: 'working', sessionId: 'sess-live', updatedAt: recent },
      false,
    )
    // A restart killed this job before it could write its exit into state.json;
    // Claude Code's adopt.json is the only proof that it is over.
    await jobFolder(
      jobsDir,
      'dead-job',
      { state: 'working', sessionId: 'sess-dead', updatedAt: recent },
      true,
    )

    await registry.refresh()
    const jobs = registry.getSnapshot().jobs
    expect(jobs.find((job) => job.jobId === 'live-job')?.exited).toBe(false)
    expect(jobs.find((job) => job.jobId === 'dead-job')?.exited).toBe(true)
  })
})
