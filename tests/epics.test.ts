import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationService } from '../server/orchestration.js'
import type {
  CommandCenterSnapshot,
  Epic,
  LaunchSessionInput,
  LaunchSessionResult,
  PromptResult,
  SessionSummary,
} from '../shared/types.js'
import { epicRollup, epicRollups, epicStatusLabel, standaloneTasks } from '../web/src/lib/epics.js'
import { makeSession } from './support/session.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function harness(
  options: {
    launchSession?: (input: LaunchSessionInput) => Promise<LaunchSessionResult>
    sendPrompt?: (id: string, text: string) => Promise<PromptResult>
  } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'csm-epic-'))
  dirs.push(dir)
  const sessions = new Map<string, SessionSummary>([
    ['commander', makeSession({ id: 'commander', name: 'Commander', projectPath: '/work/main' })],
    ['epic-owner', makeSession({ id: 'epic-owner', name: 'Epic Owner', projectPath: '/work/app' })],
    ['worker', makeSession({ id: 'worker', name: 'Worker', projectPath: '/work/app/web' })],
  ])
  const deliveries: Array<{ id: string; text: string }> = []
  let time = 10_000
  const service = new OrchestrationService({
    dataDir: dir,
    readOnly: () => false,
    getSession: (id) => sessions.get(id) ?? null,
    sendPrompt: async (id, text) => {
      deliveries.push({ id, text })
      return options.sendPrompt?.(id, text) ?? { ok: true, mode: 'typed', note: 'Delivered.' }
    },
    launchSession: options.launchSession,
    listSessions: () => [...sessions.values()],
    commanderCwd: '/work',
    onChange: vi.fn(),
    now: () => ++time,
  })
  await service.init()
  await service.setCommander('commander')
  return { service, sessions, deliveries }
}

describe('epics', () => {
  it('lets the human and the commander open an epic, never a worker', async () => {
    const { service } = await harness()
    await expect(service.createEpic({ title: 'Worker epic' }, 'worker')).rejects.toMatchObject({
      code: 'commander_required',
    })

    const epic = await service.createEpic(
      {
        title: 'Partner portal',
        goal: 'Balance and sales for partners.',
        repositories: ['/work/partners', '/work/partners/'],
        previewUrl: 'https://partners.example.test',
      },
      null,
    )
    expect(epic).toMatchObject({
      title: 'Partner portal',
      status: 'active',
      statusLine: null,
      ownerSessionId: null,
      revision: 1,
    })
    expect(epic.repositories).toEqual(['/work/partners'])
    expect(service.snapshot().epics).toHaveLength(1)
    expect(service.snapshot().updates[0].epicId).toBe(epic.id)
  })

  it('limits an epic owner to its status line and status, and refuses other sessions', async () => {
    const { service } = await harness()
    const epic = await service.createEpic(
      { title: 'Owned', ownerSessionId: 'epic-owner', repositories: ['/work/app'] },
      'commander',
    )

    const updated = await service.updateEpic(
      epic.id,
      { statusLine: 'Two workers on the API, one on the UI.', status: 'paused' },
      'epic-owner',
    )
    expect(updated.statusLine).toBe('Two workers on the API, one on the UI.')
    expect(updated.status).toBe('paused')
    expect(updated.revision).toBe(epic.revision + 1)
    expect(updated.messages.some((message) => message.kind === 'status')).toBe(true)

    await expect(
      service.updateEpic(epic.id, { title: 'Renamed' }, 'epic-owner'),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      service.updateEpic(epic.id, { statusLine: 'Not mine.' }, 'worker'),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await service.updateEpic(epic.id, { statusLine: 'Again.' }, 'commander')
    await expect(
      service.updateEpic(epic.id, { statusLine: 'Stale.', expectedRevision: 1 }, 'commander'),
    ).rejects.toMatchObject({ code: 'revision_conflict' })

    const done = await service.updateEpic(epic.id, { status: 'done' }, 'commander')
    expect(done.completedAt).not.toBeNull()
  })

  it('keeps an epic commander inside its own epic when it creates tasks', async () => {
    const { service } = await harness()
    const epic = await service.createEpic(
      { title: 'Owned', ownerSessionId: 'epic-owner', repositories: ['/work/app'] },
      'commander',
    )
    await expect(
      service.createTask(
        { title: 'Loose task', brief: 'No epic here, but long enough.' },
        'epic-owner',
      ),
    ).rejects.toMatchObject({ code: 'epic_required' })

    const other = await service.createEpic({ title: 'Other epic' }, 'commander')
    await expect(
      service.createTask(
        { title: 'Wrong epic', brief: 'Belongs to another owner.', epicId: other.id },
        'epic-owner',
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })

    const task = await service.createTask(
      {
        title: 'Build the balance endpoint',
        brief: 'Expose the partner balance and cover it with a handler test.',
        epicId: epic.id,
      },
      'epic-owner',
    )
    expect(task.epicId).toBe(epic.id)
    expect(task.projectPath).toBe('/work/app')
  })

  it('delivers a human question to a live epic owner and marks it read', async () => {
    const { service, deliveries } = await harness()
    const epic = await service.createEpic(
      { title: 'Owned', ownerSessionId: 'epic-owner' },
      'commander',
    )
    deliveries.length = 0
    const updated = await service.postEpicMessage(
      epic.id,
      { body: 'Wie weit bist du mit dem Login?' },
      null,
    )
    const message = updated.messages.at(-1)
    expect(message).toMatchObject({ kind: 'question', authorSessionId: null })
    expect(message?.deliveredAt).not.toBeNull()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].id).toBe('epic-owner')
    expect(deliveries[0].text).toContain('Wie weit bist du mit dem Login?')

    const answered = await service.postEpicMessage(
      epic.id,
      { body: 'Fertig, wartet auf Review.', kind: 'answer' },
      'epic-owner',
    )
    expect(answered.messages.at(-1)).toMatchObject({
      kind: 'answer',
      authorSessionId: 'epic-owner',
    })
    expect(answered.messages.at(-1)?.deliveredAt).not.toBeNull()

    await expect(
      service.postEpicMessage(epic.id, { body: 'Fremd.' }, 'worker'),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('keeps a question pending when the owner could only queue it, then injects it on its next turn', async () => {
    const { service } = await harness({
      sendPrompt: async () => ({
        ok: true,
        mode: 'queued',
        note: 'The session is working; the prompt waits for its next turn.',
      }),
    })
    const epic = await service.createEpic(
      { title: 'Busy', ownerSessionId: 'epic-owner' },
      'commander',
    )
    const updated = await service.postEpicMessage(epic.id, { body: 'Status?' }, null)
    const message = updated.messages.at(-1)
    expect(message).toMatchObject({ kind: 'question', authorSessionId: null })
    expect(message?.deliveredAt).toBeNull()

    // The owner's next prompt carries the still-pending message and marks it read.
    const context = service.contextFor('epic-owner', 'prompt')
    expect(context).toContain('Status?')
    const reread = (await service.snapshot()).epics.find((item) => item.id === epic.id)
    expect(reread?.messages.at(-1)?.deliveredAt).not.toBeNull()
  })

  it('delivers a pending question when the busy background owner goes idle', async () => {
    let mode: PromptResult['mode'] = 'queued'
    const { service, deliveries } = await harness({
      sendPrompt: async () =>
        mode === 'typed'
          ? { ok: true, mode: 'typed', note: 'Delivered.' }
          : {
              ok: true,
              mode: 'queued',
              note: 'The session is working; the prompt waits for its next turn.',
            },
    })
    const epic = await service.createEpic(
      { title: 'Busy', ownerSessionId: 'epic-owner' },
      'commander',
    )
    const posted = await service.postEpicMessage(epic.id, { body: 'Status?' }, null)
    expect(posted.messages.at(-1)?.deliveredAt).toBeNull()

    deliveries.length = 0
    mode = 'typed'
    await service.sessionIdle('epic-owner')
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].id).toBe('epic-owner')
    expect(deliveries[0].text).toContain('Status?')
    const reread = service.snapshot().epics.find((item) => item.id === epic.id)
    expect(reread?.messages.at(-1)?.deliveredAt).not.toBeNull()
  })

  it('leaves a question pending when the epic has no commander and nudges the commander', async () => {
    const { service, deliveries } = await harness()
    const epic = await service.createEpic({ title: 'Unowned' }, null)
    deliveries.length = 0
    const updated = await service.postEpicMessage(epic.id, { body: 'Wer macht das?' }, null)
    expect(updated.messages.at(-1)?.deliveredAt).toBeNull()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].id).toBe('commander')
    expect(deliveries[0].text).toContain('No epic commander owns it yet')
  })

  it('nudges the main commander when the epic commander is not running', async () => {
    const { service, sessions, deliveries } = await harness()
    const epic = await service.createEpic(
      { title: 'Offline', ownerSessionId: 'epic-owner' },
      'commander',
    )
    // It was live when the epic was created; now its job is gone.
    sessions.set(
      'epic-owner',
      makeSession({ id: 'epic-owner', name: 'Epic Owner', live: false, status: 'ended' }),
    )
    deliveries.length = 0
    const updated = await service.postEpicMessage(epic.id, { body: 'Bist du da?' }, null)
    expect(updated.messages.at(-1)?.deliveredAt).toBeNull()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].id).toBe('commander')
    expect(deliveries[0].text).toContain('is not running')
  })

  it('moves commander, epic owners and task assignees to a woken copy', async () => {
    const { service } = await harness()
    const epic = await service.createEpic(
      { title: 'Copied', ownerSessionId: 'epic-owner' },
      'commander',
    )
    const task = await service.createTask(
      {
        title: 'Carry on',
        brief: 'The copy keeps working where the original stopped.',
        assigneeSessionId: 'epic-owner',
        epicId: epic.id,
      },
      'commander',
    )
    await service.setCommander('epic-owner')

    await service.reassignSession('epic-owner', 'epic-owner-copy')

    const snapshot = service.snapshot()
    expect(snapshot.commanderSessionId).toBe('epic-owner-copy')
    expect(snapshot.epics.find((item) => item.id === epic.id)?.ownerSessionId).toBe(
      'epic-owner-copy',
    )
    expect(snapshot.tasks.find((item) => item.id === task.id)?.assigneeSessionId).toBe(
      'epic-owner-copy',
    )
    expect(snapshot.epics.find((item) => item.id === epic.id)?.messages.at(-1)?.body).toContain(
      'continued as',
    )
  })

  it('starts an epic commander and records the owner', async () => {
    const launchSession = vi.fn(
      async (_input: LaunchSessionInput): Promise<LaunchSessionResult> => ({
        ok: true,
        sessionId: 'epic-owner-2',
        jobId: 'job-1',
      }),
    )
    const { service } = await harness({ launchSession })
    const epic = await service.createEpic(
      { title: 'Partner portal', repositories: ['/work/partners'] },
      'commander',
    )
    const started = await service.spawnEpicCommander(epic.id, {}, 'commander')
    expect(launchSession).toHaveBeenCalledOnce()
    expect(launchSession.mock.calls[0]?.[0]).toMatchObject({ cwd: '/work/partners' })
    expect(started.ownerSessionId).toBe('epic-owner-2')
    expect(started.messages.at(-1)?.body).toContain('Epic commander started')

    await expect(service.spawnEpicCommander(epic.id, {}, 'worker')).rejects.toMatchObject({
      code: 'commander_required',
    })
  })

  it('blocks the epic when its commander cannot be started', async () => {
    const { service } = await harness({
      launchSession: async () => ({ ok: false, error: 'tmux is missing' }),
    })
    const epic = await service.createEpic({ title: 'Doomed' }, 'commander')
    const failed = await service.spawnEpicCommander(epic.id, {}, 'commander')
    expect(failed.status).toBe('blocked')
    expect(failed.ownerSessionId).toBeNull()
    expect(failed.messages.at(-1)?.body).toContain('tmux is missing')
  })

  it('frees open epics when their commander session ends', async () => {
    const { service, sessions, deliveries } = await harness()
    const epic = await service.createEpic(
      { title: 'Owned', ownerSessionId: 'epic-owner' },
      'commander',
    )
    deliveries.length = 0
    sessions.delete('epic-owner')
    await service.sessionEnded('epic-owner')
    const freed = service.snapshot().epics.find((item) => item.id === epic.id)
    expect(freed?.ownerSessionId).toBeNull()
    expect(freed?.messages.at(-1)?.body).toContain('unowned')
    expect(deliveries.some((delivery) => delivery.id === 'commander')).toBe(true)
  })
})

function snapshotWith(epics: Epic[], tasks: CommandCenterSnapshot['tasks']): CommandCenterSnapshot {
  return {
    commanderSessionId: null,
    tasks,
    epics,
    knowledge: [],
    decisions: [],
    commands: [],
    updates: [],
  }
}

function sampleEpic(overrides: Partial<Epic> = {}): Epic {
  return {
    id: 'epic_1',
    title: 'Partner portal',
    goal: '',
    status: 'active',
    statusLine: 'API done, UI in progress.',
    repositories: [],
    previewUrl: null,
    ownerSessionId: null,
    createdBySessionId: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 5,
    completedAt: null,
    messages: [],
    ...overrides,
  }
}

function sampleTask(
  overrides: Partial<CommandCenterSnapshot['tasks'][number]> = {},
): CommandCenterSnapshot['tasks'][number] {
  return {
    id: 'task_1',
    title: 'Task',
    brief: 'Brief',
    status: 'in_progress',
    priority: 'normal',
    progress: 50,
    assigneeSessionId: null,
    createdBySessionId: null,
    projectPath: '/work/app',
    epicId: null,
    lastNote: null,
    result: null,
    lastDispatch: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 4,
    activities: [],
    ...overrides,
  }
}

describe('epic rollups', () => {
  it('counts done work as 100% and derives open tasks and needs-you', () => {
    const epic = sampleEpic({
      messages: [
        {
          id: 'm1',
          at: 6,
          authorSessionId: null,
          kind: 'question',
          body: 'Wie weit?',
          deliveredAt: null,
        },
      ],
    })
    const tasks = [
      sampleTask({ id: 'a', epicId: epic.id, status: 'done', progress: 0 }),
      sampleTask({ id: 'b', epicId: epic.id, status: 'in_progress', progress: 50 }),
      sampleTask({ id: 'c', epicId: 'epic_other' }),
    ]
    const sessions = [makeSession({ id: 'worker', name: 'Worker' })]
    const rollup = epicRollup(epic, tasks, sessions)
    expect(rollup.total).toBe(2)
    expect(rollup.done).toBe(1)
    expect(rollup.progress).toBe(75)
    expect(rollup.openTasks.map((task) => task.id)).toEqual(['b'])
    expect(rollup.unanswered).toBe(1)
    expect(rollup.needsHuman).toBe(true)
    expect(rollup.lastActivityAt).toBe(6)
  })

  it('does not flag an epic as needing the human for review or blocked tasks', () => {
    const epic = sampleEpic({ status: 'active' })
    const tasks = [
      sampleTask({ id: 'r', epicId: epic.id, status: 'review', progress: 100 }),
      sampleTask({ id: 'b', epicId: epic.id, status: 'blocked', progress: 40 }),
    ]
    const rollup = epicRollup(epic, tasks, [])
    expect(rollup.needsHuman).toBe(false)
    expect(epicStatusLabel(rollup)).toBe('Blockiert')

    const blockedEpic = epicRollup(sampleEpic({ status: 'blocked' }), [], [])
    expect(blockedEpic.needsHuman).toBe(true)
  })

  it('flags an epic whose own commander is waiting for an answer', () => {
    const epic = sampleEpic({ ownerSessionId: 'owner' })
    const owner = makeSession({
      id: 'owner',
      name: 'Epic Owner',
      status: 'waiting',
      question: {
        id: 'q1',
        sessionId: 'owner',
        toolUseId: null,
        prompts: [{ question: 'Darf ich das alte APK löschen?', header: 'DEV', options: [] }],
        createdAt: 9,
        expiresAt: null,
        answerable: true,
        source: 'hook',
      },
    })
    const rollup = epicRollup(epic, [], [owner])
    expect(rollup.ownerQuestion?.id).toBe('q1')
    expect(rollup.needsHuman).toBe(true)
    expect(epicStatusLabel(rollup)).toBe('Wartet auf dich')

    const idle = epicRollup(epic, [], [makeSession({ id: 'owner' })])
    expect(idle.needsHuman).toBe(false)
  })

  it('sorts closed epics last and reports standalone open tasks', () => {
    const open = sampleEpic({ id: 'open', updatedAt: 10 })
    const closed = sampleEpic({ id: 'closed', status: 'done', updatedAt: 99 })
    const tasks = [
      sampleTask({ id: 'loose', epicId: null }),
      sampleTask({ id: 'gone', epicId: 'epic_deleted' }),
      sampleTask({ id: 'done', status: 'done', epicId: null }),
      sampleTask({ id: 'linked', epicId: 'open' }),
    ]
    const snapshot = snapshotWith([closed, open], tasks)
    expect(epicRollups(snapshot, []).map((rollup) => rollup.epic.id)).toEqual(['open', 'closed'])
    expect(standaloneTasks(snapshot).map((task) => task.id)).toEqual(['loose', 'gone'])
  })
})
