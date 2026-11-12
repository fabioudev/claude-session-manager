#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { buildServer, clientUrl, EventHub } from './api.js'
import { type AppConfig, ConfigError, HELP, parseConfig } from './config.js'
import { OrchestrationService } from './orchestration.js'
import { type PreviewRouterHandle, startPreviewRouter } from './preview-router.js'
import { SessionManager } from './session-manager.js'
import { StateStore } from './state-store.js'
import { atomicWriteJson, ensureDir, isPidAlive, pathExists } from './util.js'
import { VERSION } from './version.js'

interface ClientFile {
  version: number
  url: string
  token: string | null
  pid: number
  startedAt: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function countTranscripts(config: AppConfig): Promise<{ files: number; bytes: number }> {
  let dirs: string[] = []
  try {
    const entries = await readdir(config.projectsDir, { withFileTypes: true })
    dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return { files: 0, bytes: 0 }
  }
  let files = 0
  let bytes = 0
  for (const dir of dirs) {
    let names: string[] = []
    try {
      names = (await readdir(path.join(config.projectsDir, dir))).filter((name) =>
        name.endsWith('.jsonl'),
      )
    } catch {
      continue
    }
    for (const name of names) {
      files += 1
      try {
        bytes += (await stat(path.join(config.projectsDir, dir, name))).size
      } catch {
        // The transcript may have been removed while we counted.
      }
    }
  }
  return { files, bytes }
}

function clientFile(config: AppConfig): string {
  return path.join(config.dataDir, 'client.json')
}

async function readClientFile(config: AppConfig): Promise<ClientFile | null> {
  try {
    const parsed = JSON.parse(await readFile(clientFile(config), 'utf8')) as Partial<ClientFile>
    if (typeof parsed.url !== 'string' || typeof parsed.pid !== 'number') return null
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 0,
      url: parsed.url,
      token: typeof parsed.token === 'string' ? parsed.token : null,
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
    }
  } catch {
    return null
  }
}

async function doctor(config: AppConfig): Promise<void> {
  const lines: string[] = []
  lines.push(`claude-session-manager ${VERSION}`)
  lines.push('')
  lines.push(`node            ${process.versions.node} (${process.platform}/${process.arch})`)
  lines.push(`claude dir      ${config.claudeDir}`)
  const claudeExists = await pathExists(config.claudeDir)
  lines.push(
    `  readable      ${claudeExists ? 'yes' : 'NO — is Claude Code installed for this user?'}`,
  )

  const transcripts = await countTranscripts(config)
  lines.push(
    `transcripts     ${transcripts.files} files, ${formatBytes(transcripts.bytes)} under ${config.projectsDir}`,
  )
  try {
    const sessionFiles = (await readdir(config.sessionsDir)).filter((name) =>
      name.endsWith('.json'),
    )
    lines.push(`live registry   ${sessionFiles.length} session file(s) in ${config.sessionsDir}`)
  } catch {
    lines.push(`live registry   not found (${config.sessionsDir})`)
  }
  try {
    const jobs = (await readdir(config.jobsDir, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    )
    lines.push(`background jobs ${jobs.length} job folder(s) in ${config.jobsDir}`)
  } catch {
    lines.push(`background jobs not found (${config.jobsDir})`)
  }

  let writable = true
  try {
    await ensureDir(config.dataDir)
    await access(config.dataDir, fsConstants.W_OK)
  } catch {
    writable = false
  }
  lines.push(`data dir        ${config.dataDir} (${writable ? 'writable' : 'NOT WRITABLE'})`)
  lines.push(
    `preview router  ${
      config.previewPort > 0
        ? `${config.previewBind}:${config.previewPort}${config.previewSecret ? ' (secret required)' : ''}${config.previewPassword ? ' (login required)' : ''}`
        : 'off'
    }`,
  )

  const webIndex = path.join(config.webDir, 'index.html')
  lines.push(
    `web bundle      ${(await pathExists(webIndex)) ? webIndex : `missing — run npm run build (${webIndex})`}`,
  )

  const client = await readClientFile(config)
  if (client && isPidAlive(client.pid)) {
    lines.push(`daemon          running at ${client.url} (pid ${client.pid})`)
    try {
      const response = await fetch(`${client.url}/api/health`, {
        signal: AbortSignal.timeout(1500),
      })
      const health = (await response.json()) as { ok?: boolean; version?: string }
      lines.push(
        `  health        ${health.ok ? `ok, version ${health.version}` : 'unexpected response'}`,
      )
    } catch {
      lines.push('  health        unreachable (the process is alive but not answering)')
    }
  } else if (client) {
    lines.push(`daemon          not running (stale client.json, pid ${client.pid})`)
  } else {
    lines.push('daemon          not running (no client.json)')
  }

  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 22) {
    lines.push('')
    lines.push('Node 22 or newer is required.')
  }
  lines.push('')
  lines.push('Plugin: add this repository as a marketplace and install claude-session-manager,')
  lines.push('then start the daemon with `csm`. See README.md for details.')
  process.stdout.write(`${lines.join('\n')}\n`)
}

function openBrowser(url: string): void {
  if (process.env.CSM_NO_BROWSER === '1') return
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // Opening a browser is a convenience, never a failure.
  }
}

async function serve(config: AppConfig): Promise<void> {
  const store = new StateStore(config.dataDir)
  await store.init()
  const hub = new EventHub()
  let manager: SessionManager
  const orchestration = new OrchestrationService({
    dataDir: config.dataDir,
    readOnly: () => config.readOnly,
    getSession: (id) => manager.getSession(id),
    sendPrompt: (id, text, options) => manager.sendPrompt(id, text, options),
    launchCommander: (input) => manager.launchCommanderSession(input),
    launchSession: (input) => manager.launchSession(input),
    listSessions: () => manager.getSessions(),
    // The commander coordinates sessions across every project, so the home
    // directory (with the top-level project map) is a better default than the
    // daemon's own checkout. Override with CSM_COMMANDER_CWD.
    commanderCwd: process.env.CSM_COMMANDER_CWD || homedir(),
    onChange: (commandCenter) => hub.publish({ type: 'command-center', commandCenter }),
  })
  await orchestration.init()
  manager = new SessionManager(config, store, (event) => hub.publish(event), {
    orchestration: {
      contextFor: (sessionId, reason) => orchestration.contextFor(sessionId, reason),
      commanderSessionId: () => orchestration.snapshot().commanderSessionId,
      sessionEnded: (sessionId) => void orchestration.sessionEnded(sessionId),
      sessionReplaced: (from, to) => void orchestration.reassignSession(from, to),
      sessionIdle: (sessionId) => void orchestration.sessionIdle(sessionId),
      sweepEpicMessages: () => orchestration.sweepEpicMessages(),
    },
  })
  await manager.init()
  const app = await buildServer(config, manager, hub, orchestration)
  let previewRouter: PreviewRouterHandle | null = null

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write(`\n[csm] ${signal} — shutting down\n`)
    try {
      // Resolve any hook requests that are waiting on a browser answer before
      // closing the HTTP server, otherwise close() would wait for their timeout.
      await manager.close()
      hub.close()
      await previewRouter?.close()
      await app.close()
      await store.close()
    } catch (error) {
      console.error('[csm] shutdown error:', error)
    } finally {
      const existing = await readClientFile(config)
      if (existing?.pid === process.pid) {
        await rm(clientFile(config), { force: true }).catch(() => undefined)
      }
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  try {
    await app.listen({ host: config.host, port: config.port })
  } catch (error) {
    await manager.close()
    hub.close()
    await store.close()
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      throw new ConfigError(
        `Port ${config.port} is already in use. Stop the other process or pass --port <port>.`,
      )
    }
    throw error
  }

  const url = clientUrl(config)
  await ensureDir(config.dataDir)
  await atomicWriteJson(clientFile(config), {
    version: 1,
    url,
    token: config.token,
    pid: process.pid,
    startedAt: manager.startedAt,
  } satisfies ClientFile)

  if (config.previewPort > 0) {
    try {
      previewRouter = await startPreviewRouter({
        port: config.previewPort,
        bind: config.previewBind,
        secret: config.previewSecret,
        password: config.previewPassword,
        zone: () => store.getSettings().previewZone,
        previews: () => store.activePreviews(),
        log: (message) => process.stderr.write(`[csm] preview router: ${message}\n`),
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      process.stderr.write(
        `[csm] preview router ${
          code === 'EADDRINUSE'
            ? `port ${config.previewPort} is already in use`
            : `could not start: ${(error as Error).message}`
        }\n`,
      )
    }
  }

  const settings = store.getSettings()
  process.stdout.write(
    [
      '',
      `  claude-session-manager ${VERSION}`,
      `  ${url}`,
      '',
      `  claude dir     ${config.claudeDir}`,
      `  data dir       ${config.dataDir}`,
      `  questions      ${settings.questionMode} (timeout ${settings.questionTimeoutSeconds}s)`,
      `  read only      ${config.readOnly ? 'yes' : 'no'}`,
      `  auth           ${config.token ? 'bearer token' : 'none (loopback only)'}`,
      `  preview router ${
        previewRouter
          ? `${config.previewBind}:${previewRouter.port}`
          : config.previewPort > 0
            ? 'not running'
            : 'off'
      }`,
      `  preview zone   ${settings.previewZone || 'not set (registered previews are off)'}`,
      `  preview login  ${config.previewPassword ? 'password required' : 'open'}`,
      '',
      `  Plugin clients read ${clientFile(config)}.`,
      '  Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  )

  if (config.openBrowser) openBrowser(url)
}

async function main(): Promise<void> {
  const config = parseConfig()
  if (config.mode === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (config.mode === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (config.mode === 'doctor') {
    await doctor(config)
    return
  }
  await serve(config)
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`[csm] ${error.message}\n\nRun \`csm --help\` for usage.\n`)
    process.exitCode = 1
    return
  }
  console.error('[csm] failed to start:', error)
  process.exitCode = 1
})
