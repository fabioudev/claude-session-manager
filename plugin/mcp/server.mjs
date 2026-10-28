#!/usr/bin/env node
/**
 * Dependency-free MCP server for the Claude Session Manager.
 *
 * Runs over stdio, talks to the local daemon over HTTP, and gives every Claude
 * Code session tools to see its peers, exchange messages, inspect shared file
 * changes and claim files before editing them.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const VERSION = '0.1.0'
const PROTOCOL_VERSION = '2024-11-05'
const DEBUG = process.env.CSM_DEBUG === '1'
const REQUEST_TIMEOUT_MS = 20_000

function debug(...args) {
  if (DEBUG) process.stderr.write(`[csm-mcp] ${args.join(' ')}\n`)
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

function dataDirs() {
  const dirs = []
  if (process.env.CSM_DATA_DIR) dirs.push(expandHome(process.env.CSM_DATA_DIR))
  dirs.push(path.join(os.homedir(), '.claude-session-manager'))
  if (process.env.XDG_STATE_HOME) {
    dirs.push(path.join(expandHome(process.env.XDG_STATE_HOME), 'claude-session-manager'))
  }
  dirs.push(path.join(os.homedir(), '.config', 'claude-session-manager'))
  return [...new Set(dirs)]
}

function loadClient() {
  const envUrl = process.env.CSM_URL?.trim()
  if (envUrl) {
    return {
      url: envUrl.replace(/\/+$/, ''),
      token: process.env.CSM_TOKEN?.trim() || null,
    }
  }
  for (const dir of dataDirs()) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, 'client.json'), 'utf8'))
      if (typeof parsed.url === 'string' && parsed.url.startsWith('http')) {
        return {
          url: parsed.url.replace(/\/+$/, ''),
          token: typeof parsed.token === 'string' ? parsed.token : null,
        }
      }
    } catch {
      // Try the next location.
    }
  }
  return null
}

class DaemonUnavailable extends Error {}

async function api(pathname, options = {}) {
  const client = loadClient()
  if (!client) {
    throw new DaemonUnavailable(
      'The Claude Session Manager daemon is not running. Start it with `csm` (or `npm start` in the repository), then try again.',
    )
  }
  const headers = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (client.token) headers.authorization = `Bearer ${client.token}`
  if (options.sessionId) headers['x-csm-session-id'] = options.sessionId
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await fetch(`${client.url}${pathname}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
  } catch (error) {
    throw new DaemonUnavailable(
      `Could not reach the Claude Session Manager at ${client.url} (${error?.name || 'network error'}). Is the daemon running?`,
    )
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    const message =
      payload && payload.error && typeof payload.error.message === 'string'
        ? payload.error.message
        : `The daemon returned HTTP ${response.status}.`
    throw new Error(message)
  }
  return payload
}

function claudeDir() {
  return expandHome(
    process.env.CSM_CLAUDE_DIR?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || '~/.claude',
  )
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function parentOf(pid) {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return Number(rest[1]) || null
    } catch {
      return null
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim()
    return Number(out) || null
  } catch {
    return null
  }
}

function ancestors() {
  const chain = []
  let pid = process.ppid
  for (let depth = 0; depth < 20 && pid && pid > 1; depth += 1) {
    chain.push(pid)
    pid = parentOf(pid)
  }
  return chain
}

function readRegistry() {
  const dir = path.join(claudeDir(), 'sessions')
  let files = []
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const sessions = []
  for (const file of files) {
    try {
      const value = JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
      if (typeof value.sessionId !== 'string' || typeof value.pid !== 'number') continue
      if (!isPidAlive(value.pid)) continue
      sessions.push(value)
    } catch {
      // Registry files can disappear while we read them.
    }
  }
  return sessions
}

let identityCache

/**
 * Figure out which Claude session this MCP server belongs to. The server is a
 * child of the Claude process, so its ancestor chain usually contains the pid
 * from the session registry. cwd/start time is the fallback on platforms where
 * the process tree is not readable.
 */
function identify() {
  if (identityCache) return identityCache
  const envId =
    process.env.CSM_SESSION_ID?.trim() ||
    process.env.CLAUDE_SESSION_ID?.trim() ||
    process.env.CLAUDE_CODE_SESSION_ID?.trim()
  if (envId) {
    identityCache = { sessionId: envId, name: null, source: 'environment' }
    return identityCache
  }
  const registry = readRegistry()
  const byPid = new Map(registry.map((session) => [session.pid, session]))
  for (const pid of ancestors()) {
    const match = byPid.get(pid)
    if (match) {
      identityCache = {
        sessionId: match.sessionId,
        name: typeof match.name === 'string' ? match.name : null,
        source: 'process-tree',
      }
      return identityCache
    }
  }

  const startedAt = Date.now() - process.uptime() * 1000
  let cwd = process.cwd()
  try {
    cwd = execFileSync('pwd', ['-P'], { encoding: 'utf8', timeout: 1000 }).trim() || cwd
  } catch {
    // Keep process.cwd().
  }
  const candidates = registry.filter((session) => {
    if (session.cwd !== cwd) return false
    const sessionStarted = typeof session.startedAt === 'number' ? session.startedAt : 0
    return sessionStarted > 0 && Math.abs(startedAt - sessionStarted) < 10 * 60 * 1000
  })
  if (candidates.length) {
    candidates.sort(
      (a, b) =>
        Math.abs(startedAt - (a.startedAt || 0)) - Math.abs(startedAt - (b.startedAt || 0)),
    )
    const match = candidates[0]
    identityCache = {
      sessionId: match.sessionId,
      name: typeof match.name === 'string' ? match.name : null,
      source: 'cwd',
    }
    return identityCache
  }
  identityCache = null
  return null
}

function requireIdentity() {
  const identity = identify()
  if (!identity) {
    throw new Error(
      'Could not determine which Claude session this MCP server belongs to. Set CSM_SESSION_ID to your session id (shown in the session manager) before starting Claude Code.',
    )
  }
  return identity
}

function oneLine(text, max = 160) {
  if (typeof text !== 'string') return ''
  const value = text.replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function short(text, max = 4000) {
  if (typeof text !== 'string') return ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function age(at) {
  if (!at) return 'unknown'
  const diff = Math.max(0, Date.now() - at)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function statusGlyph(status) {
  if (status === 'working') return '●'
  if (status === 'waiting') return '◆'
  if (status === 'idle') return '○'
  if (status === 'ended') return '·'
  return '?'
}

function selfId() {
  return identify()?.sessionId ?? null
}

function resolveSession(sessions, needle) {
  const value = needle?.trim()
  if (!value) throw new Error('session_id is required')
  const lower = value.toLowerCase()
  const matches = sessions.filter(
    (session) =>
      session.id === value ||
      session.shortId.toLowerCase() === lower ||
      (session.name && session.name.toLowerCase() === lower),
  )
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(
      `Session "${value}" is ambiguous. Use the full id. Candidates: ${matches
        .map((session) => `${session.shortId} (${session.name || session.title})`)
        .join(', ')}`,
    )
  }
  const byId = sessions.filter((session) => session.id.startsWith(lower))
  if (byId.length === 1) return byId[0]
  if (byId.length > 1) {
    throw new Error(
      `Session id prefix "${value}" is ambiguous: ${byId
        .map((session) => session.shortId)
        .join(', ')}`,
    )
  }
  throw new Error(`No session matches "${value}". Call list_sessions to see the ids.`)
}

function sessionLabel(session) {
  return session.name || session.title || session.shortId
}

function formatSession(session, self) {
  const marker = self && session.id === self ? ' (you)' : ''
  const bits = [
    `${statusGlyph(session.status)} ${session.status}`,
    `${session.shortId}${marker}`,
    sessionLabel(session),
    `in ${session.repoName || session.projectName}`,
  ]
  if (session.gitBranch) bits.push(`on ${session.gitBranch}`)
  const lines = [`- ${bits.join(' · ')}`]
  if (session.task) lines.push(`  task: ${oneLine(session.task, 220)}`)
  const detail = session.question
    ? oneLine(session.question.prompts[0]?.question || 'Waiting for an answer', 220)
    : oneLine(session.statusDetail, 180)
  if (detail) lines.push(`  now: ${detail}`)
  if (session.unreadMessages) lines.push(`  inbox: ${session.unreadMessages} unread`)
  return lines.join('\n')
}

async function listSessions(args) {
  const data = await api('/api/sessions')
  const self = selfId()
  const includeEnded = args?.include_ended === true
  const sessions = (data.sessions || []).filter(
    (session) => includeEnded || session.status !== 'ended',
  )
  if (!sessions.length) {
    return 'No live Claude Code sessions right now.'
  }
  const counts = new Map()
  for (const session of sessions) counts.set(session.status, (counts.get(session.status) || 0) + 1)
  const summary = [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(', ')
  const lines = [`# Claude Code sessions (${sessions.length}: ${summary})`, '']
  for (const session of sessions) lines.push(formatSession(session, self))
  if (self) {
    const me = sessions.find((session) => session.id === self)
    if (me) lines.push('', `You are ${me.shortId} (${sessionLabel(me)}).`)
  }
  lines.push('', 'Use get_session <id> for details, send_message to reach a peer, read_inbox for your mail.')
  return lines.join('\n')
}

async function getSession(args) {
  const data = await api('/api/sessions')
  const target = resolveSession(data.sessions || [], args?.session_id)
  const detail = await api(`/api/sessions/${encodeURIComponent(target.id)}`)
  const session = detail.session
  const lines = [
    `# ${sessionLabel(session)} (${session.shortId})`,
    '',
    `Status: ${session.status} — ${session.statusDetail}`,
    `Project: ${session.projectPath || 'unknown'}${session.gitBranch ? ` [${session.gitBranch}]` : ''}`,
  ]
  if (session.gitRemoteUrl) lines.push(`Remote: ${session.gitRemoteUrl}`)
  if (session.task) lines.push(`Task: ${short(session.task, 1500)}`)
  if (session.activity) lines.push(`Current activity: ${oneLine(session.activity.text, 500)}`)
  if (session.todos.length) {
    lines.push('', 'Todos:')
    for (const todo of session.todos.slice(0, 12)) {
      const mark = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '>' : ' '
      lines.push(`- [${mark}] ${oneLine(todo.content, 180)}`)
    }
  }
  if (session.question) {
    lines.push('', 'Pending question (the user answers this in the web UI):')
    for (const prompt of session.question.prompts) {
      lines.push(`- ${prompt.header}: ${prompt.question}`)
      for (const option of prompt.options) lines.push(`  - ${option.label}`)
    }
  }
  if (detail.activities?.length) {
    lines.push('', 'Recent activity:')
    for (const event of detail.activities.slice(-12)) {
      lines.push(`- ${age(event.at)} ${event.kind}: ${oneLine(event.title, 220)}`)
    }
  }
  if (session.unreadMessages) {
    lines.push(`\nInbox: ${session.unreadMessages} unread message(s).`)
  }
  if (detail.claims?.length) {
    lines.push(
      `Claims: ${detail.claims.flatMap((claim) => claim.paths).slice(0, 8).join(', ')}`,
    )
  }
  return lines.join('\n')
}

async function sendMessage(args) {
  const identity = requireIdentity()
  const body = typeof args?.body === 'string' ? args.body.trim() : ''
  if (!body) throw new Error('body must not be empty')
  const data = await api('/api/sessions')
  const sessions = data.sessions || []
  let toSessionId = null
  let target = null
  if (args?.to_session_id) {
    target = resolveSession(sessions, args.to_session_id)
    toSessionId = target.id
  }
  const message = await api('/api/mcp/messages', {
    method: 'POST',
    sessionId: identity.sessionId,
    body: { body, toSessionId, kind: 'note' },
  })
  if (target) {
    return `Message queued for ${sessionLabel(target)} (${target.shortId}). It arrives in their context on their next prompt.`
  }
  return `Message queued for every other session (${message.id}). It arrives in their context on their next prompt.`
}

async function readInbox() {
  const identity = requireIdentity()
  const data = await api('/api/mcp/inbox', { sessionId: identity.sessionId })
  const messages = data.messages || []
  if (!messages.length) return 'No unread messages.'
  const lines = [`# Inbox (${messages.length})`, '']
  for (const message of messages) {
    lines.push(
      `## from ${message.fromName} (${age(message.createdAt)}, ${message.kind})`,
      short(message.body, 2500),
      '',
    )
  }
  lines.push('Reply with send_message.')
  return lines.join('\n')
}

function nameFor(sessions, id) {
  const found = sessions.find((session) => session.id === id)
  return found ? `${sessionLabel(found)} (${found.shortId})` : id.slice(0, 8)
}

async function sharedChanges() {
  const identity = identify()
  const self = identity?.sessionId ?? null
  const data = await api('/api/coordination')
  const sessions = data.sessions || []
  const peers = sessions.filter(
    (session) => session.id !== self && session.status !== 'ended',
  )
  const touches = (data.fileTouches || []).filter((touch) => touch.sessionId !== self)
  const byPath = new Map()
  for (const touch of touches) {
    const entry = byPath.get(touch.path) || { path: touch.path, touches: [] }
    entry.touches.push(touch)
    byPath.set(touch.path, entry)
  }
  const overlaps = (data.overlaps || []).filter((overlap) => !self || overlap.sessionIds.includes(self) || overlap.claimedBy.includes(self))
  const claims = (data.claims || []).filter((claim) => claim.sessionId !== self)

  const lines = []
  if (peers.length) {
    lines.push('Other sessions:')
    for (const peer of peers.slice(0, 10)) {
      lines.push(
        `- ${statusGlyph(peer.status)} ${sessionLabel(peer)} (${peer.shortId}) in ${peer.repoName || peer.projectName}: ${oneLine(peer.statusDetail, 140)}`,
      )
    }
  } else {
    lines.push('No other live Claude sessions right now.')
  }

  lines.push('', 'Files changed by other sessions in the last 6 hours:')
  if (!byPath.size) {
    lines.push('- none')
  } else {
    const entries = [...byPath.values()]
      .sort(
        (a, b) =>
          Math.max(...b.touches.map((touch) => touch.at)) -
          Math.max(...a.touches.map((touch) => touch.at)),
      )
      .slice(0, 30)
    for (const entry of entries) {
      const people = [...new Set(entry.touches.map((touch) => nameFor(sessions, touch.sessionId)))]
      const latest = Math.max(...entry.touches.map((touch) => touch.at))
      const overlap = overlaps.some((item) => item.path === entry.path)
      lines.push(`- ${entry.path} — ${people.join(', ')} (${age(latest)})${overlap ? ' [OVERLAP]' : ''}`)
    }
  }

  if (claims.length) {
    lines.push('', 'Active claims by other sessions:')
    for (const claim of claims.slice(0, 10)) {
      lines.push(
        `- ${nameFor(sessions, claim.sessionId)}: ${claim.paths.slice(0, 6).join(', ')}${claim.paths.length > 6 ? ', …' : ''}${claim.note ? ` — ${oneLine(claim.note, 120)}` : ''}`,
      )
    }
  }

  if (overlaps.length) {
    lines.push(
      '',
      'Overlaps matter: review the other session\'s work (git status / git diff) before overwriting these files.',
    )
  }
  return lines.join('\n')
}

async function claimFiles(args) {
  const identity = requireIdentity()
  const paths = Array.isArray(args?.paths)
    ? args.paths.filter((item) => typeof item === 'string' && item.trim())
    : []
  if (!paths.length) throw new Error('paths must contain at least one file or directory')
  const note = typeof args?.note === 'string' ? args.note : null
  const ttlMinutes = typeof args?.ttl_minutes === 'number' ? args.ttl_minutes : undefined
  const result = await api('/api/mcp/claims', {
    method: 'POST',
    sessionId: identity.sessionId,
    body: { paths, note, ttlMinutes },
  })
  const lines = [
    `Claimed ${result.claim?.paths?.length ?? paths.length} path(s) until ${new Date(result.claim?.expiresAt ?? Date.now()).toISOString()}.`,
  ]
  if (result.conflicts?.length) {
    const sessions = (await api('/api/sessions')).sessions || []
    lines.push('', 'Conflicts — another session already claims:')
    for (const claim of result.conflicts) {
      lines.push(
        `- ${nameFor(sessions, claim.sessionId)}: ${claim.paths.join(', ')}${claim.note ? ` — ${claim.note}` : ''}`,
      )
    }
    lines.push('Coordinate with them before editing these paths.')
  }
  return lines.join('\n')
}

async function releaseFiles(args) {
  const identity = requireIdentity()
  const paths = Array.isArray(args?.paths)
    ? args.paths.filter((item) => typeof item === 'string' && item.trim())
    : []
  if (!paths.length) {
    const result = await api(`/api/sessions/${encodeURIComponent(identity.sessionId)}/claims`, {
      method: 'DELETE',
    })
    return `Released ${result.released ?? 0} claim(s).`
  }
  const result = await api('/api/mcp/claims', {
    method: 'POST',
    sessionId: identity.sessionId,
    body: { paths, release: true },
  })
  return `Released ${result.released ?? 0} claim(s) covering those paths.`
}

const TOOLS = [
  {
    name: 'list_sessions',
    description:
      'List every Claude Code session running on this machine: status (working, waiting, idle, ended), repository, branch, current task and pending question. Use it to discover peers before coordinating.',
    inputSchema: {
      type: 'object',
      properties: {
        include_ended: {
          type: 'boolean',
          description: 'Include sessions that have already ended (default false).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_session',
    description:
      'Show one Claude session in detail: status, task, todos, recent activity, pending question and unread messages. Accepts a full id, short id, or session name.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Full id, short id, or session name.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description:
      'Leave a short message for another Claude session, or for every other session when to_session_id is omitted. Delivery is asynchronous: the message is injected into the target on its next prompt. Use this to flag shared files, hand off work, or ask a peer to review a change.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Message text (max 8000 characters).' },
        to_session_id: {
          type: 'string',
          description: 'Target full id, short id, or session name. Omit to broadcast.',
        },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_inbox',
    description:
      'Read messages other sessions (or the human in the web UI) left for this session. Marks them as read. Messages are also injected automatically on each prompt.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'shared_changes',
    description:
      'Show which files other Claude sessions changed recently, which edits overlap, and which files they have claimed. Check this before editing files that a parallel session may also be working on.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'claim_files',
    description:
      'Announce that this session is about to change files. Other sessions see the claim in shared_changes and receive a warning if they touch the same paths. Claims expire automatically (default 120 minutes).',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths, or paths relative to the project directory.',
        },
        note: { type: 'string', description: 'Why you need these files.' },
        ttl_minutes: { type: 'number', description: 'Claim lifetime in minutes (5–1440).' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'release_files',
    description:
      'Release claims held by this session. Pass paths to release specific files, or omit paths to release all of this session\'s claims.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths to release; omit to release every claim.',
        },
      },
      additionalProperties: false,
    },
  },
]

const HANDLERS = {
  list_sessions: listSessions,
  get_session: getSession,
  send_message: sendMessage,
  read_inbox: readInbox,
  shared_changes: sharedChanges,
  claim_files: claimFiles,
  release_files: releaseFiles,
}

const INSTRUCTIONS = `You are one of several Claude Code sessions on this machine, and a human watches all of them in the Claude Session Manager web UI.

Use list_sessions to see your peers. Before editing files, call shared_changes and check whether another session touched or claimed the same files; review their work (git status / git diff) instead of overwriting it. Claim files with claim_files before multi-file or risky edits, and release them when done. Use send_message to leave short, actionable notes for a peer or for everyone; messages arrive on the recipient's next prompt. read_inbox shows messages addressed to you.

The human can answer your AskUserQuestion prompts from the web UI. When that happens, the tool call is denied with the answers in its reason; continue the task using those answers instead of asking again.`

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function errorResponse(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  if (!message || typeof message !== 'object') return
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null
  if (!method) return
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) return

  if (method === 'initialize') {
    if (!isRequest) return
    const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'csm', version: VERSION },
        instructions: INSTRUCTIONS,
      },
    })
    return
  }

  if (method === 'ping') {
    if (isRequest) send({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (method === 'tools/list') {
    if (isRequest) send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }

  if (method === 'tools/call') {
    if (!isRequest) return
    const name = params && params.name
    const args = params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    const handler = HANDLERS[name]
    if (!handler) {
      errorResponse(id, -32602, `Unknown tool: ${String(name)}`)
      return
    }
    try {
      const text = await handler(args)
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: String(text) }] },
      })
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: error?.message || 'The tool call failed.' }],
          isError: true,
        },
      })
    }
    return
  }

  if (method === 'shutdown') {
    if (isRequest) send({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (isRequest) errorResponse(id, -32601, `Method not found: ${method}`)
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      debug('ignoring invalid JSON line')
      continue
    }
    try {
      await handle(message)
    } catch (error) {
      debug(`handler failed: ${error?.message || error}`)
      if (message && message.id !== undefined) {
        errorResponse(message.id, -32603, 'Internal error')
      }
    }
  }
}

main().catch((error) => debug(`fatal: ${error?.message || error}`))
