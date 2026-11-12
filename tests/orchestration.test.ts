import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationService } from '../server/orchestration.js'
import { MAX_MESSAGE_LENGTH } from '../server/util.js'
import type {
  DelegatedTask,
  LaunchSessionInput,
  LaunchSessionResult,
  PromptResult,
  SessionSummary,
} from '../shared/types.js'
import { makeSession } from './support/session.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface HarnessOptions {
  /** Leave the command center without a commander, as a fresh install is. */
  autoCommander?: boolean
  launchCommander?: (input: LaunchSessionInput) => Promise<LaunchSessionResult>
  launchSession?: (input: LaunchSessionInput) => Promise<LaunchSessionResult>
}

async function harness(
  sendPrompt?: (id: string, text: string) => Promise<PromptResult>,
  options: HarnessOptions = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'csm-command-'))
  dirs.push(dir)
  const sessions = new Map<string, SessionSummary>([
    ['commander', makeSession({ id: 'commander', name: 'Commander', projectPath: '/work/main' })],
    ['worker', makeSession({ id: 'worker', name: 'Worker', projectPath: '/work/app/web' })],
    ['other', makeSession({ id: 'other', name: 'Other', projectPath: '/work/other' })],
  ])
  const deliveries: Array<{ id: string; text: string }> = []
  let readOnly = false
  let time = 10_000
  const service = new OrchestrationService({
    dataDir: dir,
    readOnly: () => readOnly,
    getSession: (id) => sessions.get(id) ?? null,
    sendPrompt: async (id, text) => {
      deliveries.push({ id, text })
      return sendPrompt?.(id, text) ?? { ok: true, mode: 'typed', note: 'Delivered now.' }
    },
    launchCommander: options.launchCommander,
    launchSession: options.launchSession,
    listSessions: () => [...sessions.values()],
    commanderCwd: '/work',
    onChange: vi.fn(),
    now: () => ++time,
  })
  await service.init()
  if (!options.autoCommander) await service.setCommander('commander')
  return {
    dir,
    service,
    sessions,
    deliveries,
    setReadOnly: (value: boolean) => {
      readOnly = value
    },
  }
}

async function assignedTask(service: OrchestrationService): Promise<DelegatedTask> {
  return service.createTask(
    {
      title: 'Ship the command center',
      brief: 'Build it and verify the result.',
      assigneeSessionId: 'worker',
    },
    'commander',
  )
}

describe('OrchestrationService tasks', () => {
  it('lets only the commander or human create tasks and dispatches the exact task id', async () => {
    const { service, deliveries } = await harness()
    await expect(
      service.createTask({ title: 'Nope', brief: 'Nope' }, 'worker'),
    ).rejects.toMatchObject({ code: 'commander_required' })

    const task = await assignedTask(service)
    expect(task).toMatchObject({ status: 'queued', progress: 0, revision: 2 })
    expect(task.lastDispatch).toMatchObject({ ok: true, mode: 'typed' })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].id).toBe('worker')
    expect(deliveries[0].text).toContain(`[Delegated task ${task.id}]`)
    expect(deliveries[0].text).toContain('set status review')

    const humanTask = await service.createTask(
      { title: 'Human task', brief: 'Direct assignment.' },
      null,
    )
    expect(humanTask.createdBySessionId).toBeNull()
  })

  it('keeps queued delivery separate from execution and marks failed delivery blocked', async () => {
    const queued = await harness(async () => ({ ok: true, mode: 'queued', note: 'Inbox only.' }))
    const task = await assignedTask(queued.service)
    expect(task).toMatchObject({ status: 'queued', progress: 0 })
    expect(task.lastDispatch).toMatchObject({ mode: 'queued' })

    const failed = await harness(async () => ({
      ok: false,
      mode: 'queued',
      error: 'Pane unavailable.',
    }))
    const blocked = await assignedTask(failed.service)
    expect(blocked).toMatchObject({ status: 'blocked', lastNote: 'Pane unavailable.' })
    expect(blocked.activities.at(-1)?.text).toContain('Delivery failed')
  })

  it('accepts explicit worker progress and review, but reserves closure for commander or human', async () => {
    const { service } = await harness()
    const task = await assignedTask(service)
    const reported = await service.updateTask(
      task.id,
      {
        status: 'in_progress',
        progress: 45,
        note: 'Pipeline is rendering.',
        expectedRevision: task.revision,
      },
      'worker',
    )
    expect(reported).toMatchObject({
      status: 'in_progress',
      progress: 45,
      lastNote: 'Pipeline is rendering.',
    })

    const review = await service.updateTask(
      task.id,
      {
        status: 'review',
        progress: 100,
        result: 'Tests and build pass.',
        expectedRevision: reported.revision,
      },
      'worker',
    )
    expect(review.status).toBe('review')
    expect(review.completedAt).toBeNull()
    await expect(
      service.updateTask(task.id, { status: 'done', expectedRevision: review.revision }, 'worker'),
    ).rejects.toMatchObject({ code: 'review_required' })

    const done = await service.updateTask(
      task.id,
      { status: 'done', expectedRevision: review.revision },
      'commander',
    )
    expect(done).toMatchObject({ status: 'done', progress: 100 })
    expect(done.completedAt).not.toBeNull()
  })

  it('prevents workers from redefining work or updating another worker task', async () => {
    const { service } = await harness()
    const task = await assignedTask(service)
    await expect(
      service.updateTask(task.id, { assigneeSessionId: 'other' }, 'worker'),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(service.updateTask(task.id, { progress: 10 }, 'other')).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('does not reset an active task when the unchanged assignee is saved again', async () => {
    const { service } = await harness()
    const task = await assignedTask(service)
    const active = await service.updateTask(
      task.id,
      { status: 'in_progress', progress: 30, note: 'Working.' },
      'worker',
    )
    const saved = await service.updateTask(
      task.id,
      {
        assigneeSessionId: 'worker',
        progress: 40,
        expectedRevision: active.revision,
      },
      'commander',
    )
    expect(saved).toMatchObject({ status: 'in_progress', progress: 40 })
    expect(saved.activities.map((activity) => activity.text)).not.toContain('Assigned to Worker.')
  })

  it('leaves the task untouched when any part of a patch is rejected', async () => {
    const { service } = await harness()
    const task = await assignedTask(service)
    await expect(
      service.updateTask(
        task.id,
        { progress: 90, title: '  ', expectedRevision: task.revision },
        'commander',
      ),
    ).rejects.toMatchObject({ code: 'bad_request' })
    expect(service.snapshot().tasks[0]).toMatchObject({
      title: task.title,
      progress: task.progress,
      revision: task.revision,
    })
  })

  it('rejects stale revisions without losing the newer report', async () => {
    const { service } = await harness()
    const task = await assignedTask(service)
    const staleRevision = task.revision
    const current = await service.updateTask(task.id, { progress: 60, note: 'Newest.' }, 'worker')
    await expect(
      service.updateTask(
        task.id,
        { progress: 5, note: 'Stale overwrite.', expectedRevision: staleRevision },
        'commander',
      ),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(service.snapshot().tasks[0]).toMatchObject({
      progress: 60,
      lastNote: 'Newest.',
      revision: current.revision,
    })
  })

  it('persists tasks across a daemon restart', async () => {
    const { service, dir } = await harness()
    const task = await assignedTask(service)
    await service.updateTask(
      task.id,
      { status: 'review', progress: 100, result: 'Verified.' },
      'worker',
    )

    const restarted = new OrchestrationService({
      dataDir: dir,
      readOnly: () => false,
      getSession: () => null,
      sendPrompt: vi.fn(),
      onChange: vi.fn(),
    })
    await restarted.init()
    expect(restarted.snapshot().commanderSessionId).toBe('commander')
    expect(restarted.snapshot().tasks[0]).toMatchObject({
      id: task.id,
      status: 'review',
      result: 'Verified.',
    })
    expect(JSON.parse(await readFile(path.join(dir, 'command-center.json'), 'utf8')).version).toBe(
      1,
    )
  })
})

describe('OrchestrationService commander updates', () => {
  it('reports to the channel, links tasks and derives their project', async () => {
    const { service } = await harness()
    const task = await assignedTask(service)
    const update = await service.report(
      {
        title: 'Two agents running',
        body: 'Worker is on the command center while the other session reviews docs.',
        taskIds: [task.id],
      },
      'commander',
    )
    expect(update).toMatchObject({
      kind: 'status',
      title: 'Two agents running',
      authorSessionId: 'commander',
      projectPath: '/work/app/web',
      taskIds: [task.id],
    })
    expect(service.snapshot().updates[0].id).toBe(update.id)
    const activities = service.snapshot().tasks.find((item) => item.id === task.id)?.activities
    expect(activities?.some((event) => event.text.includes('Commander report'))).toBe(true)
  })

  it('rejects reports from workers and unknown kinds', async () => {
    const { service } = await harness()
    await expect(
      service.report({ title: 'Hi', body: 'From a worker.' }, 'worker'),
    ).rejects.toMatchObject({ code: 'commander_required' })
    await expect(
      service.report({ title: 'Hi', body: 'Bad kind.', kind: 'bogus' as never }, 'commander'),
    ).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('logs delegated work and status milestones into the channel', async () => {
    const { service } = await harness()
    const task = await assignedTask(service)
    await service.updateTask(
      task.id,
      { status: 'review', progress: 100, result: 'Verified locally.' },
      'worker',
    )
    await service.updateTask(task.id, { status: 'done' }, 'commander')
    const titles = service.snapshot().updates.map((update) => update.title)
    expect(titles).toContain('Delegated: Ship the command center')
    expect(titles).toContain('Ready for review: Ship the command center')
    expect(titles).toContain('Completed: Ship the command center')
  })

  it('nudges the commander when a worker finishes, but not for its own changes', async () => {
    const { service, deliveries } = await harness()
    const task = await assignedTask(service)
    deliveries.length = 0
    await service.updateTask(task.id, { status: 'in_progress', progress: 30 }, 'worker')
    expect(deliveries).toHaveLength(0)
    await service.updateTask(
      task.id,
      { status: 'review', progress: 100, result: 'Verified.' },
      'worker',
    )
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ id: 'commander' })
    expect(deliveries[0].text).toContain('ready for review')
    await service.updateTask(task.id, { status: 'done' }, 'commander')
    expect(deliveries).toHaveLength(1)
  })

  it('asks the human in the channel when a decision blocks a task', async () => {
    const { service } = await harness()
    const task = await assignedTask(service)
    await service.requestDecision({ question: 'Use the new API?', taskId: task.id }, 'worker')
    const update = service.snapshot().updates.find((entry) => entry.kind === 'question')
    expect(update).toMatchObject({ title: 'Waiting on you: Use the new API?', taskIds: [task.id] })
  })
})

describe('OrchestrationService spawning workers', () => {
  it('starts a new session for a task instead of leaving it queued', async () => {
    const launchSession = vi.fn(
      async (_input: LaunchSessionInput): Promise<LaunchSessionResult> => ({
        ok: true,
        sessionId: 'worker-new',
        jobId: 'job-new',
      }),
    )
    const { service } = await harness(undefined, { launchSession })

    const task = await service.spawnTask(
      {
        title: 'Partner portal balance',
        brief: 'Show the credit balance on the partner page.',
        projectPath: '/work/partners',
      },
      'commander',
    )

    expect(launchSession).toHaveBeenCalledOnce()
    const input = launchSession.mock.calls[0][0]
    expect(input.cwd).toBe('/work/partners')
    expect(input.prompt).toContain(`[Delegated task ${task.id}]`)
    expect(input.prompt).toContain('Show the credit balance on the partner page.')
    expect(task).toMatchObject({
      status: 'in_progress',
      assigneeSessionId: 'worker-new',
      projectPath: '/work/partners',
    })
    expect(task.activities.at(-1)?.text).toContain('Started as a new session')
  })

  it('blocks the task when no session could be started', async () => {
    const launchSession = vi.fn(
      async (_input: LaunchSessionInput): Promise<LaunchSessionResult> => ({
        ok: false,
        error: 'Launching sessions is disabled',
      }),
    )
    const { service } = await harness(undefined, { launchSession })

    const task = await service.spawnTask(
      { title: 'Doomed', brief: 'Try anyway.', projectPath: '/work/partners' },
      'commander',
    )

    expect(task.status).toBe('blocked')
    expect(task.lastNote).toBe('Launching sessions is disabled')
    expect(task.assigneeSessionId).toBeNull()
  })

  it('needs a project directory and commander rights', async () => {
    const launchSession = vi.fn()
    const { service } = await harness(undefined, { launchSession })

    await expect(
      service.spawnTask({ title: 'No project', brief: 'Missing path.' }, 'commander'),
    ).rejects.toMatchObject({ code: 'project_required' })
    await expect(
      service.spawnTask(
        { title: 'Worker call', brief: 'Not allowed.', projectPath: '/work/app' },
        'worker',
      ),
    ).rejects.toMatchObject({ code: 'commander_required' })
    expect(launchSession).not.toHaveBeenCalled()
  })
})

describe('OrchestrationService orphaned tasks', () => {
  it('wakes the commander with the tasks a finished session still held', async () => {
    const { service, deliveries } = await harness()
    const task = await assignedTask(service)
    deliveries.length = 0

    await service.sessionEnded('worker')

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].id).toBe('commander')
    expect(deliveries[0].text).toContain('worker')
    expect(deliveries[0].text).toContain(task.id)
    expect(deliveries[0].text).toContain(task.title)
    expect(deliveries[0].text).toContain('spawn_task')
  })

  it('stays quiet when the session held nothing open or the commander itself ended', async () => {
    const { service, deliveries } = await harness()
    const task = await assignedTask(service)
    await service.updateTask(task.id, { status: 'cancelled' }, 'commander')
    deliveries.length = 0

    await service.sessionEnded('worker')
    await service.sessionEnded('commander')
    await service.sessionEnded('nobody')

    expect(deliveries).toHaveLength(0)
  })

  it('does not wake the commander in read-only mode', async () => {
    const { service, deliveries, setReadOnly } = await harness()
    await assignedTask(service)
    deliveries.length = 0
    setReadOnly(true)

    await service.sessionEnded('worker')

    expect(deliveries).toHaveLength(0)
  })
})

describe('OrchestrationService commands and decisions', () => {
  it('sends human goals to the commander with orchestration instructions and records delivery', async () => {
    const { service, deliveries } = await harness()
    const command = await service.command('Coordinate the next release.')
    expect(deliveries[0]).toMatchObject({ id: 'commander' })
    expect(deliveries[0].text).toContain('Coordinate the next release.')
    expect(deliveries[0].text).toContain('create_task')
    expect(command.text).toBe('Coordinate the next release.')
    expect(service.snapshot().commands[0].id).toBe(command.id)
  })

  it('sends a maximum-length command as one message instead of failing', async () => {
    const { service, deliveries } = await harness()
    const goal = 'y'.repeat(12_000)
    await service.command(goal)
    // The 8k message cap used to turn a long command into an "Internal server
    // error"; the prompt must fit in one deliverable message now.
    expect(deliveries[0].text.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH)
    expect(deliveries[0].text.endsWith(goal)).toBe(true)
  })

  it('starts a dedicated commander with the first command when none is selected', async () => {
    const launchCommander = vi.fn(
      async (_input: LaunchSessionInput): Promise<LaunchSessionResult> => ({
        ok: true,
        sessionId: 'commander-new',
      }),
    )
    const { service, deliveries } = await harness(undefined, {
      autoCommander: true,
      launchCommander,
    })

    const command = await service.command('Plan the next release.')

    expect(launchCommander).toHaveBeenCalledOnce()
    const input = launchCommander.mock.calls[0][0]
    expect(input).toMatchObject({ cwd: '/work', name: 'Commander' })
    expect(input.prompt).toContain('HUMAN GOAL:')
    expect(input.prompt).toContain('Plan the next release.')
    expect(service.snapshot().commanderSessionId).toBe('commander-new')
    expect(command.result).toMatchObject({ ok: true, mode: 'typed' })
    expect(command.result.note).toContain('Started a new commander')
    expect(deliveries).toHaveLength(0)
  })

  it('resumes an offline commander with its existing transcript', async () => {
    const launchCommander = vi.fn(
      async (_input: LaunchSessionInput): Promise<LaunchSessionResult> => ({
        ok: true,
        sessionId: 'commander',
      }),
    )
    const { service, sessions, deliveries } = await harness(undefined, { launchCommander })
    const commander = sessions.get('commander')
    if (!commander) throw new Error('commander fixture missing')
    sessions.set('commander', { ...commander, live: false, status: 'ended' })

    const command = await service.command('Continue where we stopped.')

    expect(launchCommander).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: 'commander' }),
    )
    expect(command.result.note).toContain('Resumed the commander')
    expect(deliveries).toHaveLength(0)
  })

  it('delivers to a background commander instead of resuming it as a copy', async () => {
    const launchCommander = vi.fn(
      async (_input: LaunchSessionInput): Promise<LaunchSessionResult> => ({
        ok: true,
        sessionId: 'commander',
      }),
    )
    const { service, sessions, deliveries } = await harness(undefined, { launchCommander })
    const commander = sessions.get('commander')
    if (!commander) throw new Error('commander fixture missing')
    // Background jobs report live: false because that flag is about a terminal.
    sessions.set('commander', {
      ...commander,
      live: false,
      status: 'waiting',
      tmux: null,
      jobId: 'commander',
      backgroundState: 'blocked',
    })

    const command = await service.command('Continue where we stopped.')

    expect(launchCommander).not.toHaveBeenCalled()
    expect(deliveries.at(-1)?.id).toBe('commander')
    expect(command.result.ok).toBe(true)
  })

  it('gives the commander a bounded snapshot of sessions, tasks and knowledge', async () => {
    const { service, deliveries } = await harness()
    await assignedTask(service)
    await service.shareKnowledge(
      { title: 'Deploy convention', body: 'Use the prod tag pipeline.' },
      null,
    )

    await service.command('Ship the release.')

    const prompt = deliveries.at(-1)?.text ?? ''
    expect(prompt).toContain('Live sessions')
    expect(prompt).toContain('worker')
    expect(prompt).toContain('Ship the command center')
    expect(prompt).toContain('Deploy convention')
    expect(prompt).toContain('HUMAN GOAL:')
    expect(prompt.length).toBeLessThan(20_000)
  })

  it('blocks a linked task, forwards the human answer and resumes explicit work', async () => {
    const { service, deliveries } = await harness()
    const task = await assignedTask(service)
    const decision = await service.requestDecision(
      { taskId: task.id, question: 'Deploy to production?', context: 'All checks pass.' },
      'worker',
    )
    expect(service.snapshot().tasks[0].status).toBe('blocked')
    expect(service.contextFor('worker', 'prompt')).toContain('waiting for the human')

    const resolved = await service.resolveDecision(decision.id, 'Yes, deploy the reviewed build.')
    expect(resolved).toMatchObject({ answer: 'Yes, deploy the reviewed build.' })
    expect(resolved.delivery).toMatchObject({ ok: true, mode: 'typed' })
    expect(resolved.resolvedAt).not.toBeNull()
    expect(service.snapshot().tasks[0]).toMatchObject({ status: 'queued' })
    expect(deliveries.at(-1)?.text).toContain('Yes, deploy the reviewed build.')
    expect(deliveries.at(-1)?.text).toContain(task.id)
    await expect(service.resolveDecision(decision.id, 'Again')).rejects.toMatchObject({
      code: 'already_resolved',
    })
  })

  it('keeps a task blocked until every linked decision is answered', async () => {
    const { service } = await harness()
    const task = await assignedTask(service)
    const first = await service.requestDecision(
      { taskId: task.id, question: 'Which database?' },
      'worker',
    )
    const second = await service.requestDecision(
      { taskId: task.id, question: 'Which region?' },
      'worker',
    )
    await service.resolveDecision(first.id, 'The existing database.')
    expect(service.snapshot().tasks[0]).toMatchObject({
      status: 'blocked',
      lastNote:
        'Human answered one question; another decision is still open. The existing database.',
    })
    await service.resolveDecision(second.id, 'EU only.')
    expect(service.snapshot().tasks[0]).toMatchObject({
      status: 'queued',
      lastNote: 'Human answered: EU only.',
    })
  })

  it('leaves a task blocked when the answer cannot be delivered', async () => {
    const failed = await harness(async () => ({
      ok: false,
      mode: 'queued',
      error: 'Pane unavailable.',
    }))
    const task = await assignedTask(failed.service)
    const decision = await failed.service.requestDecision(
      { taskId: task.id, question: 'Deploy?' },
      'worker',
    )
    const resolved = await failed.service.resolveDecision(decision.id, 'Wait for green CI.')
    expect(resolved.delivery?.ok).toBe(false)
    expect(failed.service.snapshot().tasks[0]).toMatchObject({
      status: 'blocked',
    })
    expect(failed.service.snapshot().tasks[0].lastNote).toContain('delivery failed')
  })

  it('keeps the answer durable even when the requesting session has ended', async () => {
    const { service, sessions } = await harness()
    const decision = await service.requestDecision({ question: 'Which database?' }, 'worker')
    sessions.set('worker', makeSession({ id: 'worker', live: false, status: 'ended' }))
    const resolved = await service.resolveDecision(decision.id, 'Use the existing database.')
    expect(resolved.answer).toBe('Use the existing database.')
    expect(resolved.delivery?.ok).toBe(false)
    expect(resolved.delivery?.error).toContain('requesting session has ended')
  })
})

describe('OrchestrationService knowledge and safety', () => {
  it('scopes knowledge to projects, pins only commander knowledge, and limits prompt injection', async () => {
    const { service } = await harness()
    await service.shareKnowledge(
      { title: 'Global rule', body: 'Use the shared API client.', always: true },
      null,
    )
    await service.shareKnowledge(
      {
        title: 'App rule',
        body: 'App sessions use pnpm.',
        projectPath: '/work/app',
        always: false,
      },
      null,
    )
    await service.shareKnowledge(
      { title: 'Elsewhere', body: 'Not relevant.', projectPath: '/work/elsewhere', always: true },
      null,
    )
    const workerNote = await service.shareKnowledge(
      { title: 'Worker note', body: 'A discovered quirk.', always: true },
      'worker',
    )
    expect(workerNote.always).toBe(false)

    const start = service.contextFor('worker', 'start') ?? ''
    expect(start).toContain('Global rule')
    expect(start).toContain('App rule')
    expect(start).toContain('Worker note')
    expect(start).not.toContain('Elsewhere')

    const prompt = service.contextFor('worker', 'prompt') ?? ''
    expect(prompt).toContain('Global rule')
    expect(prompt).not.toContain('App rule')
    expect(prompt).not.toContain('Worker note')
    const otherPrompt = service.contextFor('other', 'prompt') ?? ''
    expect(otherPrompt).toContain('Global rule')
    expect(otherPrompt).not.toContain('App rule')
    expect(otherPrompt).not.toContain('Elsewhere')
  })

  it('prevents workers from changing pinned knowledge', async () => {
    const { service } = await harness()
    const pinned = await service.shareKnowledge(
      { title: 'Pinned rule', body: 'Every worker follows this.', always: true },
      null,
    )
    await expect(
      service.updateKnowledge(
        pinned.id,
        { body: 'Rewritten by a worker.', expectedRevision: pinned.revision },
        'worker',
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(service.snapshot().knowledge[0].body).toBe('Every worker follows this.')
  })

  it('scopes a delegated task prompt to the task project, not the worker session project', async () => {
    const { service, deliveries } = await harness()
    await service.shareKnowledge(
      {
        title: 'Other project rule',
        body: 'Belongs to other.',
        projectPath: '/work/other',
        always: true,
      },
      null,
    )
    await service.shareKnowledge(
      {
        title: 'App project rule',
        body: 'Belongs to app.',
        projectPath: '/work/app',
        always: true,
      },
      null,
    )
    const task = await service.createTask(
      {
        title: 'Cross-project task',
        brief: 'Work in the other project.',
        projectPath: '/work/other',
        assigneeSessionId: 'worker',
      },
      'commander',
    )
    const prompt = deliveries.find((delivery) => delivery.text.includes(task.id))?.text ?? ''
    expect(prompt).toContain('Other project rule')
    expect(prompt).not.toContain('App project rule')
  })

  it('bounds pinned knowledge in a delegated task prompt', async () => {
    const { service, deliveries } = await harness()
    for (let index = 0; index < 10; index += 1) {
      await service.shareKnowledge(
        {
          title: `Long rule ${index}`,
          body: `${'detail '.repeat(1100)}end`,
          always: true,
        },
        null,
      )
    }
    const task = await service.createTask(
      {
        title: 'Large brief',
        brief: 'brief '.repeat(1600),
        assigneeSessionId: 'worker',
      },
      'commander',
    )
    const prompt = deliveries.find((delivery) => delivery.text.includes(task.id))?.text ?? ''
    expect(prompt.length).toBeLessThan(18_000)
    expect(prompt).toContain('list_knowledge')
  })

  it('drops archived knowledge from future context', async () => {
    const { service } = await harness()
    const entry = await service.shareKnowledge(
      { title: 'Old convention', body: 'No longer relevant.', always: true },
      null,
    )
    await service.updateKnowledge(
      entry.id,
      { archived: true, expectedRevision: entry.revision },
      null,
    )
    expect(service.contextFor('worker', 'start')).not.toContain('Old convention')
    expect(service.snapshot().knowledge[0].archivedAt).not.toBeNull()
  })

  it('enforces read-only mode in the service, not only in the UI', async () => {
    const { service, setReadOnly } = await harness()
    setReadOnly(true)
    await expect(service.createTask({ title: 'Nope', brief: 'Nope' }, null)).rejects.toMatchObject({
      code: 'read_only',
    })
    await expect(service.command('Nope')).rejects.toMatchObject({ code: 'read_only' })
    await expect(
      service.shareKnowledge({ title: 'Nope', body: 'Nope' }, null),
    ).rejects.toMatchObject({ code: 'read_only' })
  })

  it('quarantines corrupt state and starts with an empty ledger', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'csm-command-corrupt-'))
    dirs.push(dir)
    await writeFile(path.join(dir, 'command-center.json'), '{not json', 'utf8')
    const service = new OrchestrationService({
      dataDir: dir,
      readOnly: () => false,
      getSession: () => null,
      sendPrompt: vi.fn(),
      onChange: vi.fn(),
    })
    await service.init()
    expect(service.snapshot()).toEqual({
      commanderSessionId: null,
      tasks: [],
      epics: [],
      knowledge: [],
      decisions: [],
      commands: [],
      updates: [],
    })
    expect(
      (await readdir(dir)).some((name) => name.startsWith('command-center.json.corrupt-')),
    ).toBe(true)
  })
})
