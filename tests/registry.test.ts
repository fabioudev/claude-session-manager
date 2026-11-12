import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeRegistry, runningJobIds } from '../server/registry.js'

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

async function harness(rosterWorkers?: Record<string, unknown>): Promise<{
  registry: ClaudeRegistry
  jobsDir: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'csm-registry-'))
  dirs.push(root)
  const jobsDir = path.join(root, 'jobs')
  const rosterFile = path.join(root, 'daemon', 'roster.json')
  if (rosterWorkers) {
    await mkdir(path.dirname(rosterFile), { recursive: true })
    await writeFile(rosterFile, JSON.stringify({ proto: 1, workers: rosterWorkers }))
  }
  const registry = new ClaudeRegistry({
    sessionsDir: path.join(root, 'sessions'),
    jobsDir,
    rosterFile,
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

  it('treats a job missing from the daemon roster as gone, even without an adopt record', async () => {
    const { registry, jobsDir } = await harness({ 'running-job': { pid: process.pid } })
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString()
    await jobFolder(
      jobsDir,
      'running-job',
      { state: 'working', sessionId: 'sess-running', updatedAt: tenMinutesAgo },
      false,
    )
    // Killed before it could write its exit; the roster no longer lists it.
    await jobFolder(
      jobsDir,
      'vanished-job',
      { state: 'working', sessionId: 'sess-vanished', updatedAt: tenMinutesAgo },
      false,
    )

    await registry.refresh()
    const jobs = registry.getSnapshot().jobs
    expect(jobs.find((job) => job.jobId === 'running-job')?.exited).toBe(false)
    expect(jobs.find((job) => job.jobId === 'vanished-job')?.exited).toBe(true)
  })

  it('reports a job that waits for an answer as blocked although its state says working', async () => {
    const { registry, jobsDir } = await harness()
    await jobFolder(
      jobsDir,
      'asked-job',
      {
        state: 'working',
        tempo: 'blocked',
        sessionId: 'sess-asked',
        updatedAt: new Date().toISOString(),
        block: { questions: [{ question: 'Darf ich das alte Asset löschen?' }] },
      },
      false,
    )

    await registry.refresh()
    const job = registry.getSnapshot().jobs.find((item) => item.jobId === 'asked-job')
    expect(job?.blocked).toBe(true)
  })

  it('lists only the roster workers whose process is alive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'csm-roster-'))
    dirs.push(root)
    const rosterFile = path.join(root, 'roster.json')
    await writeFile(
      rosterFile,
      JSON.stringify({
        workers: {
          alive: { pid: 11 },
          gone: { pid: 12 },
        },
      }),
    )
    const live = await runningJobIds(rosterFile, (pid) => pid !== 12)
    expect([...(live ?? [])]).toEqual(['alive'])
  })

  it.runIf(process.platform === 'linux')(
    'ignores a roster entry whose pid now belongs to another process',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'csm-roster-'))
      dirs.push(root)
      const rosterFile = path.join(root, 'roster.json')
      await writeFile(
        rosterFile,
        JSON.stringify({ workers: { reused: { pid: process.pid, procStart: '0' } } }),
      )
      const live = await runningJobIds(rosterFile)
      expect(live?.has('reused')).toBe(false)
    },
  )
})
