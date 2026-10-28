import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHome } from './util.js'

export interface AppConfig {
  mode: 'serve' | 'doctor' | 'version' | 'help'
  host: string
  port: number
  dataDir: string
  claudeDir: string
  projectsDir: string
  sessionsDir: string
  jobsDir: string
  webDir: string
  token: string | null
  allowInsecure: boolean
  readOnly: boolean
  openBrowser: boolean
  logLevel: string
  localUrl: string
}

export class ConfigError extends Error {}

/** IPv6 literals need brackets inside a URL. */
function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

const DEFAULT_PORT = 4747

function takeValue(args: string[], index: number, name: string): [string, number] {
  const arg = args[index]
  if (!arg) throw new ConfigError(`Missing value for ${name}`)
  const eq = arg.indexOf('=')
  if (eq >= 0) return [arg.slice(eq + 1), index]
  const next = args[index + 1]
  if (!next || next.startsWith('--')) throw new ConfigError(`Missing value for ${name}`)
  return [next, index + 1]
}

export function parseConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  let mode: AppConfig['mode'] = 'serve'
  let host = env.CSM_HOST ?? '127.0.0.1'
  let port = Number(env.CSM_PORT ?? DEFAULT_PORT)
  let dataDir = expandHome(env.CSM_DATA_DIR ?? '~/.claude-session-manager')
  let claudeDir = expandHome(env.CSM_CLAUDE_DIR ?? '~/.claude')
  let token = env.CSM_TOKEN?.trim() || null
  let allowInsecure = env.CSM_ALLOW_INSECURE === '1' || env.CSM_ALLOW_INSECURE === 'true'
  let readOnly = env.CSM_READ_ONLY === '1' || env.CSM_READ_ONLY === 'true'
  let openBrowser = false
  let logLevel = env.CSM_LOG_LEVEL ?? 'info'

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === 'doctor') {
      mode = 'doctor'
    } else if (arg === '--help' || arg === '-h') {
      mode = 'help'
    } else if (arg === '--version' || arg === '-v') {
      mode = 'version'
    } else if (arg === '--read-only') {
      readOnly = true
    } else if (arg === '--open') {
      openBrowser = true
    } else if (arg === '--allow-insecure') {
      allowInsecure = true
    } else if (arg === '--host' || arg.startsWith('--host=')) {
      ;[host, i] = takeValue(argv, i, '--host')
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const [value, next] = takeValue(argv, i, '--port')
      i = next
      port = Number(value)
    } else if (arg === '--data-dir' || arg.startsWith('--data-dir=')) {
      const [value, next] = takeValue(argv, i, '--data-dir')
      i = next
      dataDir = expandHome(value)
    } else if (arg === '--claude-dir' || arg.startsWith('--claude-dir=')) {
      const [value, next] = takeValue(argv, i, '--claude-dir')
      i = next
      claudeDir = expandHome(value)
    } else if (arg === '--token' || arg.startsWith('--token=')) {
      const [value, next] = takeValue(argv, i, '--token')
      i = next
      token = value.trim() || null
    } else if (arg === '--log-level' || arg.startsWith('--log-level=')) {
      const [value, next] = takeValue(argv, i, '--log-level')
      i = next
      logLevel = value
    } else {
      throw new ConfigError(`Unknown argument: ${arg}`)
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Invalid port: ${port}`)
  }
  if (!host.trim()) throw new ConfigError('Host must not be empty')

  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
  const wildcardHosts = new Set(['0.0.0.0', '::', '[::]'])
  const isLoopback = loopbackHosts.has(host)
  const isWildcard = wildcardHosts.has(host)
  if (!isLoopback && !token && !allowInsecure) {
    throw new ConfigError(
      'Refusing to bind a non-loopback address without an API token. Pass --token <secret> or --allow-insecure if a trusted reverse proxy protects the app.',
    )
  }

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  // In a compiled install the web bundle sits beside the server bundle (dist/web).
  // In development it is built into <repo>/dist/web and Vite serves its own copy.
  const webDir =
    path.basename(projectRoot) === 'dist'
      ? path.join(projectRoot, 'web')
      : path.join(projectRoot, 'dist', 'web')

  return {
    mode,
    host,
    port,
    dataDir,
    claudeDir,
    projectsDir: path.join(claudeDir, 'projects'),
    sessionsDir: path.join(claudeDir, 'sessions'),
    jobsDir: path.join(claudeDir, 'jobs'),
    webDir,
    token,
    allowInsecure,
    readOnly,
    openBrowser,
    logLevel,
    localUrl: `http://${isLoopback || isWildcard ? 'localhost' : urlHost(host)}:${port}`,
  }
}

export const HELP = `claude-session-manager ${'0.1.0'}

A self-hosted web control plane for local Claude Code sessions.

Usage:
  csm [options]
  csm doctor
  csm --version

Options:
  --host <host>         Bind address (default 127.0.0.1)
  --port <port>         HTTP port (default 4747)
  --data-dir <path>     State directory (default ~/.claude-session-manager)
  --claude-dir <path>   Claude Code data directory (default ~/.claude)
  --token <secret>      Require a bearer token for the API and UI
  --read-only           Disable answering questions, messaging and launching
  --open                Open the UI in the default browser
  --log-level <level>   fatal | error | warn | info | debug | trace
  --allow-insecure      Allow a non-loopback bind without a token (not recommended)

Environment:
  CSM_HOST, CSM_PORT, CSM_DATA_DIR, CSM_CLAUDE_DIR, CSM_TOKEN,
  CSM_READ_ONLY, CSM_ALLOW_INSECURE, CSM_LOG_LEVEL

The plugin talks to http://127.0.0.1:<port> and reads
<data-dir>/client.json for the URL and optional token.
`
