import { describe, expect, it } from 'vitest'
import type {
  CommandCenterSnapshot,
  DelegatedTask,
  KnowledgeEntry,
  PendingQuestion,
} from '../shared/types.js'
import {
  activeKnowledge,
  commanderFeed,
  commandStats,
  featureGroups,
  offlineAssignments,
  taskColumns,
  visibleQuestions,
} from '../web/src/lib/command.js'
import { makeSession } from './support/session.js'

function task(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id: 'task_1',
    title: 'Build the feature',
    brief: 'A useful outcome.',
    status: 'queued',
    priority: 'normal',
    progress: 0,
    assigneeSessionId: 'worker',
    createdBySessionId: 'commander',
    projectPath: '/work/app',
    lastNote: null,
    result: null,
    lastDispatch: null,
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
    activities: [],
    ...overrides,
  }
}

function knowledge(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'know_1',
    title: 'Release convention',
    body: 'Run the complete verification suite.',
    tags: ['release'],
    projectPath: null,
    always: true,
    createdBySessionId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    archivedAt: null,
    revision: 1,
    ...overrides,
  }
}

function snapshot(overrides: Partial<CommandCenterSnapshot> = {}): CommandCenterSnapshot {
  return {
    commanderSessionId: 'commander',
    tasks: [],
    knowledge: [],
    decisions: [],
    commands: [],
    updates: [],
    ...overrides,
  }
}

describe('command center presentation helpers', () => {
  it('groups tasks into the pipeline, hides cancelled tasks and sorts recent updates first', () => {
    const tasks = [
      task({ id: 'old', status: 'in_progress', updatedAt: 1_000 }),
      task({ id: 'new', status: 'in_progress', updatedAt: 2_000 }),
      task({ id: 'done', status: 'done', progress: 100 }),
      task({ id: 'cancelled', status: 'cancelled' }),
    ]
    expect(taskColumns(tasks).map((column) => column.status)).toEqual([
      'queued',
      'in_progress',
      'blocked',
      'review',
      'done',
    ])
    expect(taskColumns(tasks)[1].tasks.map((item) => item.id)).toEqual(['new', 'old'])
    expect(taskColumns(tasks).flatMap((column) => column.tasks)).toHaveLength(3)
    expect(taskColumns(tasks, false)).toHaveLength(4)
  })

  it('reports only declared active progress and verified work completed today', () => {
    const noon = new Date('2026-11-10T12:00:00').getTime()
    const today = new Date('2026-11-10T10:00:00').getTime()
    const stats = commandStats(
      snapshot({
        tasks: [
          task({ id: 'a', status: 'in_progress', progress: 40 }),
          task({ id: 'b', status: 'review', progress: 100 }),
          task({ id: 'c', status: 'done', progress: 100, completedAt: today }),
          task({ id: 'd', status: 'done', progress: 100, completedAt: today - 86_400_000 }),
          task({ id: 'e', status: 'cancelled', progress: 80 }),
        ],
        decisions: [
          {
            id: 'decision_open',
            question: 'Continue?',
            context: null,
            taskId: null,
            requestedBySessionId: 'worker',
            createdAt: today,
            resolvedAt: null,
            answer: null,
            delivery: null,
          },
        ],
      }),
      noon,
    )
    expect(stats).toEqual({
      active: 2,
      inProgress: 1,
      review: 1,
      openDecisions: 1,
      doneToday: 1,
      averageProgress: 70,
    })
  })

  it('surfaces only open assignments whose worker is unavailable', () => {
    const sessions = [
      makeSession({ id: 'worker', live: false, status: 'ended' }),
      makeSession({ id: 'online', live: true, status: 'idle' }),
    ]
    const tasks = [
      task({ id: 'offline', assigneeSessionId: 'worker' }),
      task({ id: 'online', assigneeSessionId: 'online' }),
      task({ id: 'blocked', assigneeSessionId: 'worker', status: 'blocked' }),
      task({ id: 'done', assigneeSessionId: 'worker', status: 'done' }),
      task({ id: 'unassigned', assigneeSessionId: null }),
    ]
    expect(offlineAssignments(tasks, sessions).map((item) => item.id)).toEqual(['offline'])
  })

  it('hides questions from sessions that have ended', () => {
    const question = (id: string, sessionId: string): PendingQuestion => ({
      id,
      sessionId,
      toolUseId: null,
      prompts: [],
      createdAt: 1_000,
      expiresAt: null,
      answerable: true,
      source: 'hook',
    })
    const sessions = [
      makeSession({ id: 'live', status: 'idle' }),
      makeSession({ id: 'ended', status: 'ended' }),
    ]
    expect(
      visibleQuestions(
        [question('open', 'live'), question('gone', 'ended'), question('unknown', 'missing')],
        sessions,
      ).map((item) => item.id),
    ).toEqual(['open', 'unknown'])
  })

  it('searches active knowledge across title, body, scope and tags', () => {
    const entries = [
      knowledge({ id: 'release', title: 'Release convention', tags: ['deploy'] }),
      knowledge({
        id: 'api',
        title: 'Backend contract',
        body: 'Use the generated client.',
        projectPath: '/work/api',
      }),
      knowledge({ id: 'archived', title: 'Release archive', archivedAt: 2_000 }),
    ]
    expect(
      activeKnowledge(snapshot({ knowledge: entries }), 'generated').map((entry) => entry.id),
    ).toEqual(['api'])
    expect(
      activeKnowledge(snapshot({ knowledge: entries }), 'DEPLOY').map((entry) => entry.id),
    ).toEqual(['release'])
    expect(
      activeKnowledge(snapshot({ knowledge: entries }), '/work/api').map((entry) => entry.id),
    ).toEqual(['api'])
    expect(activeKnowledge(snapshot({ knowledge: entries }), '')).toHaveLength(2)
  })

  it('groups open work by project and ranks attention first', () => {
    const groups = featureGroups([
      task({ id: 'a', projectPath: '/work/shop/web', status: 'in_progress', progress: 40 }),
      task({ id: 'b', projectPath: '/work/shop/web', status: 'blocked', progress: 70 }),
      task({ id: 'c', projectPath: '/work/api', status: 'review', progress: 100 }),
      task({ id: 'd', projectPath: null, status: 'queued', progress: 0 }),
      task({ id: 'e', projectPath: '/work/api', status: 'done', progress: 100 }),
    ])
    expect(groups.map((group) => group.label)).toEqual(['web', 'api', 'Unassigned'])
    expect(groups[0]).toMatchObject({ inProgress: 1, blocked: 1, averageProgress: 55 })
    expect(groups[1]).toMatchObject({ review: 1, averageProgress: 100 })
    expect(groups[2]).toMatchObject({ key: 'unassigned', projectPath: null, queued: 1 })
  })

  it('merges human commands and commander reports into one chronological feed', () => {
    const feed = commanderFeed(
      snapshot({
        commands: [
          {
            id: 'cmd_1',
            text: 'Ship it.',
            createdAt: 1_000,
            result: { ok: true, mode: 'typed', note: null },
          },
        ],
        updates: [
          {
            id: 'update_1',
            at: 2_000,
            kind: 'status',
            title: 'Two agents running',
            body: 'Shop and API are covered.',
            projectPath: '/work/api',
            taskIds: [],
            authorSessionId: 'commander',
          },
          {
            id: 'update_2',
            at: 500,
            kind: 'progress',
            title: 'Started',
            body: '',
            projectPath: null,
            taskIds: [],
            authorSessionId: null,
          },
        ],
      }),
    )
    expect(feed.map((entry) => entry.id)).toEqual(['update_2', 'cmd_1', 'update_1'])
  })
})
