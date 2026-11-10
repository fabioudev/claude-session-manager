import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TMUX_BIN = process.env.CSM_TMUX_BIN || 'tmux'

export interface PaneInfo {
  id: string
  pid: number | null
  command: string | null
}

/**
 * The registry stores values like `dev1:@0.%0`; hooks store the bare `%0`.
 * Pane ids are unique within a tmux server either way.
 */
export function paneTarget(tmux: string | null): string | null {
  if (!tmux) return null
  const match = tmux.trim().match(/(?:^|[.:])(%\d+)$/)
  return match?.[1] ?? null
}

async function query(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(TMUX_BIN, args, {
      timeout: 4_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

async function run(args: string[]): Promise<boolean> {
  try {
    await execFileAsync(TMUX_BIN, args, {
      timeout: 4_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

export async function paneInfo(pane: string): Promise<PaneInfo | null> {
  const output = await query([
    'display-message',
    '-p',
    '-t',
    pane,
    '#{pane_id}|#{pane_pid}|#{pane_current_command}',
  ])
  if (!output) return null
  const [id, pid, ...command] = output.split('|')
  if (!id?.startsWith('%')) return null
  return {
    id,
    pid: Number(pid) || null,
    command: command.join('|') || null,
  }
}

/** Types text without tmux interpreting it as a key name. */
export async function sendText(pane: string, text: string): Promise<boolean> {
  return run(['send-keys', '-t', pane, '-l', '--', text])
}

let pasteCounter = 0

/**
 * Types a prompt as one bracketed paste, so newlines stay inside the message
 * instead of submitting it line by line. `-d` drops the buffer afterwards; the
 * name is unique per call so two sends cannot interleave.
 */
export async function pasteText(pane: string, text: string): Promise<boolean> {
  pasteCounter += 1
  const buffer = `csm-${process.pid}-${pasteCounter}`
  if (!(await run(['set-buffer', '-b', buffer, '--', text]))) return false
  return run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', pane])
}

export async function sendEnter(pane: string): Promise<boolean> {
  return run(['send-keys', '-t', pane, '--', 'Enter'])
}

/** `=` makes tmux match the name exactly instead of as a prefix. */
function exactTarget(name: string): string {
  return `=${name}`
}

export async function sessionExists(name: string): Promise<boolean> {
  return run(['has-session', '-t', exactTarget(name)])
}

/**
 * Starts a detached tmux session with an interactive shell. The restart and
 * resume paths type into the pane afterwards, so the pane must keep a shell
 * when Claude Code exits.
 */
export async function newSession(name: string, cwd: string | null): Promise<string | null> {
  const args = ['new-session', '-d', '-s', name, '-P', '-F', '#{pane_id}']
  if (cwd) args.push('-c', cwd)
  const pane = await query(args)
  return pane?.startsWith('%') ? pane : null
}

export async function killSession(name: string): Promise<boolean> {
  return run(['kill-session', '-t', exactTarget(name)])
}

/** The tail of a pane's output, used to explain why a start failed. */
export async function capturePane(pane: string, lines = 40): Promise<string | null> {
  return query(['capture-pane', '-p', '-t', pane, '-S', `-${Math.max(1, lines)}`])
}

/**
 * A stable, readable name for a resumed session. `attempt` grows when an older
 * pane with the same name is still around (for example left at a shell).
 */
export function resumeSessionName(shortId: string, attempt = 1): string {
  const base = `csm-${shortId.replace(/[^0-9a-zA-Z_-]/g, '') || 'session'}`
  return attempt <= 1 ? base : `${base}-${attempt}`
}
