#!/usr/bin/env node
/**
 * Claude Code hook bridge for the Claude Session Manager.
 *
 * Reads the hook payload from stdin, forwards it to the local daemon and prints
 * whatever JSON the daemon returns. It is intentionally dependency-free and
 * always exits 0: when the daemon is not running, Claude Code must behave exactly
 * as it would without the plugin.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const VERSION = '0.1.0'
const DEBUG = process.env.CSM_DEBUG === '1'
const DEFAULT_TIMEOUT_MS = 5000
const MAX_QUESTION_TIMEOUT_MS = 640_000

function debug(...args) {
  if (DEBUG) process.stderr.write(`[csm-hook] ${args.join(' ')}\n`)
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 4 * 1024 * 1024) raw = raw.slice(0, 4 * 1024 * 1024)
    })
    process.stdin.on('end', () => resolve(raw))
    process.stdin.on('error', () => resolve(raw))
  })
}

function dataDirs() {
  const dirs = []
  if (process.env.CSM_DATA_DIR) dirs.push(process.env.CSM_DATA_DIR)
  dirs.push(path.join(os.homedir(), '.claude-session-manager'))
  if (process.env.XDG_STATE_HOME) {
    dirs.push(path.join(process.env.XDG_STATE_HOME, 'claude-session-manager'))
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

function claudePid() {
  let pid = process.ppid
  for (let depth = 0; depth < 16 && pid && pid > 1; depth += 1) {
    try {
      if (process.platform === 'linux') {
        const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase()
        if (comm.includes('claude')) return pid
      } else {
        const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
          encoding: 'utf8',
          timeout: 1000,
        })
          .trim()
          .toLowerCase()
        if (comm.includes('claude')) return pid
      }
    } catch {
      // Ignore a process that vanished mid-walk.
    }
    pid = parentOf(pid)
  }
  return null
}

function shortString(value, max = 2000) {
  if (typeof value !== 'string') return undefined
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function pickToolInput(toolName, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  if (toolName === 'AskUserQuestion') return input
  const keys = [
    'file_path',
    'notebook_path',
    'path',
    'command',
    'description',
    'pattern',
    'glob',
    'url',
    'query',
    'skill',
    'name',
    'subagent_type',
    'recipient',
    'to',
  ]
  const picked = {}
  for (const key of keys) {
    if (!(key in input)) continue
    const value = input[key]
    if (typeof value === 'string') picked[key] = shortString(value, 2000)
    else if (typeof value === 'number' || typeof value === 'boolean') picked[key] = value
  }
  const encoded = JSON.stringify(picked)
  if (encoded.length > 12_000) {
    return Object.fromEntries(
      Object.entries(picked)
        .filter(([, value]) => typeof value !== 'string' || value.length <= 300)
        .slice(0, 8),
    )
  }
  return picked
}

function buildEnvelope(input, event) {
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : undefined
  return {
    event,
    sessionId: input.session_id,
    transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : undefined,
    cwd:
      (typeof input.cwd === 'string' && input.cwd) ||
      process.env.CLAUDE_PROJECT_DIR ||
      process.cwd(),
    permissionMode:
      typeof input.permission_mode === 'string' ? input.permission_mode : undefined,
    toolName,
    toolInput: pickToolInput(toolName, input.tool_input),
    source: typeof input.source === 'string' ? input.source : undefined,
    prompt: shortString(input.prompt, 100_000),
    notificationType:
      typeof input.notification_type === 'string' ? input.notification_type : undefined,
    message: shortString(input.message, 2000),
    reason: shortString(input.reason, 500),
    stopHookActive: input.stop_hook_active === true,
    timestamp: Date.now(),
    client: {
      pid: process.pid,
      ppid: process.ppid,
      claudePid: claudePid(),
      tmux: process.env.TMUX_PANE || null,
      tty: null,
      csmVersion: VERSION,
    },
    pluginVersion: VERSION,
  }
}

async function requestJson(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const raw = await readStdin()
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    debug('stdin was not JSON')
    return
  }
  if (!input || typeof input !== 'object') return
  const event =
    (typeof input.hook_event_name === 'string' && input.hook_event_name) ||
    (typeof process.argv[2] === 'string' ? process.argv[2] : '')
  if (!event || typeof input.session_id !== 'string' || !input.session_id) {
    debug('missing event or session_id')
    return
  }

  const client = loadClient()
  if (!client) {
    debug('no client.json found; is the daemon running?')
    return
  }

  const headers = { 'content-type': 'application/json' }
  if (client.token) headers.authorization = `Bearer ${client.token}`

  let timeoutMs =
    event === 'SessionStart' || event === 'UserPromptSubmit' ? 10_000 : DEFAULT_TIMEOUT_MS
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') {
    let questionTimeout = 110
    try {
      const configResponse = await requestJson(
        `${client.url}/api/config`,
        { method: 'GET', headers },
        2500,
      )
      if (configResponse.ok) {
        const config = await configResponse.json()
        if (typeof config.questionTimeoutSeconds === 'number') {
          questionTimeout = config.questionTimeoutSeconds
        }
      }
    } catch {
      // Fall back to a timeout above the default broker timeout.
    }
    timeoutMs = Math.min(
      MAX_QUESTION_TIMEOUT_MS,
      Math.max(30_000, Math.round(questionTimeout * 1000) + 20_000),
    )
  }

  const envelope = buildEnvelope(input, event)
  let response
  try {
    response = await requestJson(
      `${client.url}/api/hooks/event`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope),
      },
      timeoutMs,
    )
  } catch (error) {
    debug(`request failed: ${error?.name || error}`)
    return
  }
  if (!response.ok) {
    debug(`daemon returned ${response.status}`)
    return
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    debug('daemon returned invalid JSON')
    return
  }
  if (payload && payload.output && typeof payload.output === 'object') {
    process.stdout.write(`${JSON.stringify(payload.output)}\n`)
  }
}

main()
  .catch((error) => debug(`unexpected: ${error?.message || error}`))
  .finally(() => {
    // Undici keeps sockets open briefly; hooks must return immediately.
    process.exit(0)
  })
