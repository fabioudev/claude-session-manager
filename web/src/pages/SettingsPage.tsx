import type { PreviewRule } from '@shared/types'
import { Check, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useToast } from '../components/Toast'
import { dateTime } from '../lib/format'
import { useLive } from '../lib/live'
import { useTheme } from '../lib/theme'

type QuestionMode = 'board' | 'terminal'

/** One rule per line: `pattern = https://…`. Invalid lines make the whole draft invalid. */
function parseRules(text: string): PreviewRule[] | null {
  const rules: PreviewRule[] = []
  for (const line of text.split('\n')) {
    const entry = line.trim()
    if (!entry) continue
    const separator = entry.indexOf('=')
    if (separator <= 0) return null
    const pattern = entry.slice(0, separator).trim()
    const url = entry.slice(separator + 1).trim()
    if (!pattern || !url) return null
    if (!rules.some((rule) => rule.pattern === pattern)) rules.push({ pattern, url })
  }
  return rules
}

function parseHosts(text: string): string[] {
  const hosts: string[] = []
  for (const line of text.split('\n')) {
    const host = line
      .trim()
      .toLowerCase()
      .replace(/^\*\.?/, '')
    if (host && !hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

function rulesToText(rules: PreviewRule[]): string {
  return rules.map((rule) => `${rule.pattern} = ${rule.url}`).join('\n')
}

function sameRules(a: PreviewRule[], b: PreviewRule[]): boolean {
  return (
    a.length === b.length &&
    a.every((rule, index) => rule.pattern === b[index]?.pattern && rule.url === b[index]?.url)
  )
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function boardMode(mode: 'auto' | 'web' | 'terminal'): QuestionMode {
  return mode === 'terminal' ? 'terminal' : 'board'
}

export function SettingsPage() {
  const { config, refresh, reconnect, connection } = useLive()
  const { theme, setTheme } = useTheme()
  const { notify } = useToast()
  const [mode, setMode] = useState<QuestionMode>('board')
  const [questionTimeout, setQuestionTimeout] = useState(90)
  const [launchEnabled, setLaunchEnabled] = useState(true)
  const [launcher, setLauncher] = useState('')
  const [autoRestart, setAutoRestart] = useState(false)
  const [previewRules, setPreviewRules] = useState('')
  const [previewHosts, setPreviewHosts] = useState('')
  const [previewZone, setPreviewZone] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const configMode = config ? boardMode(config.questionMode) : null
  const configTimeout = config?.questionTimeoutSeconds ?? null
  const configLaunch = config?.launchEnabled ?? null
  const configLauncher = config?.sessionLauncher ?? null
  const configAutoRestart = config?.autoRestartSessions ?? null
  const configRules = config ? rulesToText(config.previewRules) : null
  const configHosts = config?.previewHosts.join('\n') ?? null
  const configZone = config?.previewZone ?? null

  useEffect(() => {
    if (configMode === null || configTimeout === null || configLaunch === null) return
    setMode(configMode)
    setQuestionTimeout(configTimeout)
    setLaunchEnabled(configLaunch)
  }, [configMode, configTimeout, configLaunch])

  useEffect(() => {
    if (configLauncher !== null) setLauncher(configLauncher)
  }, [configLauncher])

  useEffect(() => {
    if (configAutoRestart !== null) setAutoRestart(configAutoRestart)
  }, [configAutoRestart])

  useEffect(() => {
    if (configRules !== null) setPreviewRules(configRules)
  }, [configRules])

  useEffect(() => {
    if (configHosts !== null) setPreviewHosts(configHosts)
  }, [configHosts])

  useEffect(() => {
    if (configZone !== null) setPreviewZone(configZone)
  }, [configZone])

  const readOnly = Boolean(config?.readOnly)
  const draftRules = parseRules(previewRules)
  const previewDirty = Boolean(
    config &&
      (draftRules === null ||
        !sameRules(draftRules, config.previewRules) ||
        !sameList(parseHosts(previewHosts), config.previewHosts)),
  )
  const dirty = Boolean(
    config &&
      !readOnly &&
      (mode !== boardMode(config.questionMode) ||
        questionTimeout !== config.questionTimeoutSeconds ||
        launchEnabled !== config.launchEnabled ||
        launcher.trim() !== config.sessionLauncher ||
        autoRestart !== config.autoRestartSessions ||
        previewZone.trim() !== config.previewZone ||
        previewDirty),
  )

  function editMode(next: QuestionMode) {
    setMode(next)
    setSavedAt(null)
  }

  async function save() {
    if (!config || saving || readOnly) return
    const rules = parseRules(previewRules)
    if (!rules) {
      setError('Each preview rule needs one line in the form pattern = https://address.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.updateSettings({
        questionMode: mode === 'board' ? 'auto' : 'terminal',
        questionTimeoutSeconds: questionTimeout,
        launchEnabled,
        sessionLauncher: launcher.trim(),
        autoRestartSessions: autoRestart,
        previewZone: previewZone.trim(),
        previewRules: rules,
        previewHosts: parseHosts(previewHosts),
      })
      await refresh()
      setSavedAt(Date.now())
      notify('Settings saved.', 'success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the settings.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            How questions reach this board, how long they wait, and what the daemon is reading.
            Settings are stored on the machine that runs the daemon.
          </p>
        </div>
        <div className="page-head-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => (connection === 'offline' ? reconnect() : void refresh())}
          >
            <RefreshCw size={12} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {!config ? (
        <div className="detail-loading" aria-busy="true">
          <span className="skeleton" style={{ width: '58%', height: 16 }} />
          <span className="skeleton" style={{ width: '74%', height: 12 }} />
          <span className="skeleton" style={{ width: '46%', height: 12 }} />
        </div>
      ) : (
        <div className="settings-wrap">
          {readOnly ? (
            <div className="banner banner-readonly" role="status" style={{ marginBottom: 20 }}>
              <span>
                <strong>Read-only mode is on.</strong> Change settings on the daemon's command line
                or restart it without <code>--read-only</code>.
              </span>
            </div>
          ) : null}

          <section className="setting-block" aria-labelledby="question-mode-title">
            <div className="setting-head">
              <div>
                <h2 className="setting-title" id="question-mode-title">
                  Where sessions ask questions
                </h2>
                <p className="setting-desc">
                  <strong>Ask here</strong> lets a plugin hook hold the question open while this
                  board waits for an answer. <strong>Terminal only</strong> never routes questions
                  to the browser; pending web questions are dismissed.
                </p>
              </div>
              <div className="setting-control">
                <fieldset className="segmented" aria-label="Question answering">
                  <button
                    type="button"
                    className="segment"
                    aria-pressed={mode === 'board'}
                    disabled={readOnly}
                    onClick={() => editMode('board')}
                  >
                    Ask here
                  </button>
                  <button
                    type="button"
                    className="segment"
                    aria-pressed={mode === 'terminal'}
                    disabled={readOnly}
                    onClick={() => editMode('terminal')}
                  >
                    Terminal only
                  </button>
                </fieldset>
              </div>
            </div>
          </section>

          <section className="setting-block" aria-labelledby="timeout-title">
            <div className="setting-head">
              <div>
                <h2 className="setting-title" id="timeout-title">
                  Wait for a web answer
                </h2>
                <p className="setting-desc">
                  How long a tool call waits before the question falls back to the terminal. A
                  longer window gives you time to notice a session that stopped for input.
                </p>
              </div>
              <div className="setting-control">
                <span className="range-value">
                  {mode === 'terminal' ? 'not used' : `${questionTimeout}s`}
                </span>
              </div>
            </div>
            <div className="range-row">
              <input
                type="range"
                min={5}
                max={600}
                step={5}
                value={questionTimeout}
                disabled={readOnly || mode === 'terminal'}
                aria-label="Question timeout in seconds"
                onChange={(event) => {
                  setQuestionTimeout(Number(event.target.value))
                  setSavedAt(null)
                }}
              />
            </div>
            <div className="range-limits" aria-hidden="true">
              <span>5s</span>
              <span>10 min</span>
            </div>
          </section>

          <section className="setting-block" aria-labelledby="launch-title">
            <div className="setting-head">
              <div>
                <h2 className="setting-title" id="launch-title">
                  Launch background sessions
                </h2>
                <p className="setting-desc">
                  Allow the board to start <code>claude --bg</code> in a working directory you
                  choose. The daemon must run as the same user as Claude Code.
                </p>
              </div>
              <div className="setting-control">
                <button
                  type="button"
                  role="switch"
                  aria-checked={launchEnabled}
                  aria-label="Allow launching background sessions"
                  className="switch"
                  disabled={readOnly}
                  onClick={() => {
                    setLaunchEnabled((value) => !value)
                    setSavedAt(null)
                  }}
                />
              </div>
            </div>
          </section>

          <section className="setting-block" aria-labelledby="launcher-title">
            <div className="setting-head">
              <div>
                <h2 className="setting-title" id="launcher-title">
                  Session launcher
                </h2>
                <p className="setting-desc">
                  The command that starts Claude Code on this machine. <em>Resume</em> replays it
                  with <code>--resume &lt;session-id&gt;</code> for a session whose own launch
                  command the daemon never saw. Include a wrapper here when your sessions start
                  through one, for example{' '}
                  <code>ollama launch claude --model &lt;model&gt; --</code>. Leave empty to use{' '}
                  <code>claude</code>.
                </p>
              </div>
              <div className="setting-control">
                <input
                  className="input launcher-input"
                  type="text"
                  value={launcher}
                  placeholder="claude"
                  spellCheck={false}
                  aria-label="Session launcher command"
                  disabled={readOnly}
                  onChange={(event) => {
                    setLauncher(event.target.value)
                    setSavedAt(null)
                  }}
                />
              </div>
            </div>
          </section>

          <section className="setting-block" aria-labelledby="restart-title">
            <div className="setting-head">
              <div>
                <h2 className="setting-title" id="restart-title">
                  Restart sessions after updates
                </h2>
                <p className="setting-desc">
                  When a newer Claude Code or plugin version is installed, restart idle interactive
                  sessions in their tmux pane. The session continues the same conversation with{' '}
                  <code>--resume</code> once it has been quiet for three minutes. Sessions that are
                  working, waiting for an answer, or not running in tmux are left alone.
                </p>
              </div>
              <div className="setting-control">
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoRestart}
                  aria-label="Restart idle sessions after updates"
                  className="switch"
                  disabled={readOnly || !config.restartSupported}
                  onClick={() => {
                    setAutoRestart((value) => !value)
                    setSavedAt(null)
                  }}
                />
              </div>
            </div>
            <dl className="info-list">
              <div className="info-row">
                <dt>Claude Code</dt>
                <dd>
                  {config.installedClaudeVersion
                    ? `${config.installedClaudeVersion} installed`
                    : 'version not detected'}
                </dd>
              </div>
              <div className="info-row">
                <dt>Plugin</dt>
                <dd>
                  {config.installedPluginVersion
                    ? `${config.installedPluginVersion} installed`
                    : 'version not detected'}
                </dd>
              </div>
            </dl>
            {!config.restartSupported ? (
              <p className="setting-desc">
                Restarting in place needs Linux and tmux. Elsewhere, restart the session in its
                terminal.
              </p>
            ) : null}
          </section>

          <section className="setting-block" aria-labelledby="preview-title">
            <div className="setting-head">
              <div>
                <h2 className="setting-title" id="preview-title">
                  Preview links
                </h2>
                <p className="setting-desc">
                  Sessions that serve a preview get a link to it on the board and on their page. A
                  session can announce its dev server itself; it then appears as{' '}
                  <code>https://&lt;name&gt;.&lt;zone&gt;</code> and the preview router forwards to
                  it. Without a registration, map a project to its address with one rule per line,
                  for example{' '}
                  <code>fixplay-diagnoseTool = https://dev-diagnosetool.example.com</code>. The
                  pattern is matched against the project path and repository names, and{' '}
                  <code>*</code> is a wildcard. A registration wins over a rule, and a rule wins
                  over a URL found in output.
                </p>
              </div>
            </div>
            <label className="setting-field">
              <span className="setting-field-label">Preview zone</span>
              <input
                className="input"
                value={previewZone}
                placeholder="dev-fixplay.de"
                spellCheck={false}
                aria-label="Preview zone"
                disabled={readOnly}
                onChange={(event) => {
                  setPreviewZone(event.target.value)
                  setSavedAt(null)
                }}
              />
            </label>
            <p className="setting-desc">
              Registered previews live under this zone, for example <code>dev4.dev-fixplay.de</code>{' '}
              where the TLS terminator must reach this router. Leave empty to disable registered
              previews.
            </p>
            <label className="setting-field">
              <span className="setting-field-label">Project rules</span>
              <textarea
                className="input preview-input"
                rows={3}
                value={previewRules}
                placeholder={'fixplay-diagnoseTool = https://dev-diagnosetool.example.com'}
                spellCheck={false}
                aria-label="Project preview rules"
                disabled={readOnly}
                onChange={(event) => {
                  setPreviewRules(event.target.value)
                  setSavedAt(null)
                }}
              />
            </label>
            <label className="setting-field">
              <span className="setting-field-label">Hosts recognised in session output</span>
              <textarea
                className="input preview-input"
                rows={4}
                value={previewHosts}
                placeholder={'trycloudflare.com\nngrok-free.app\nfixplay.dev'}
                spellCheck={false}
                aria-label="Preview hosts"
                disabled={readOnly}
                onChange={(event) => {
                  setPreviewHosts(event.target.value)
                  setSavedAt(null)
                }}
              />
            </label>
            <p className="setting-desc">
              When a session prints an <code>http(s)</code> URL on one of these hosts, the board
              links the newest one as the preview. One host per line; subdomains match too. Empty
              means no URL is recognised in output.
            </p>
          </section>

          <section className="setting-block" aria-labelledby="theme-title">
            <div className="setting-head">
              <div>
                <h2 className="setting-title" id="theme-title">
                  Appearance
                </h2>
                <p className="setting-desc">
                  The board is dark by default. The choice is kept in this browser, not on the
                  daemon.
                </p>
              </div>
              <div className="setting-control">
                <fieldset className="segmented" aria-label="Theme">
                  <button
                    type="button"
                    className="segment"
                    aria-pressed={theme === 'dark'}
                    onClick={() => setTheme('dark')}
                  >
                    Dark
                  </button>
                  <button
                    type="button"
                    className="segment"
                    aria-pressed={theme === 'light'}
                    onClick={() => setTheme('light')}
                  >
                    Light
                  </button>
                </fieldset>
              </div>
            </div>
          </section>

          <section className="setting-block" aria-labelledby="daemon-title">
            <div className="setting-head">
              <div>
                <h2 className="setting-title" id="daemon-title">
                  Daemon
                </h2>
                <p className="setting-desc">
                  Read-only facts about this process. No transcript content or credentials are sent
                  to the browser.
                </p>
              </div>
            </div>
            <dl className="info-list">
              <div className="info-row">
                <dt>Version</dt>
                <dd>{config.version}</dd>
              </div>
              <div className="info-row">
                <dt>Address</dt>
                <dd>{config.serverUrl}</dd>
              </div>
              <div className="info-row">
                <dt>Started</dt>
                <dd>{dateTime(config.serverStartedAt)}</dd>
              </div>
              <div className="info-row">
                <dt>Claude directory</dt>
                <dd>{config.claudeDir}</dd>
              </div>
              <div className="info-row">
                <dt>Data directory</dt>
                <dd>{config.dataDir}</dd>
              </div>
              <div className="info-row">
                <dt>Authentication</dt>
                <dd>{config.authRequired ? 'access token required' : 'loopback only'}</dd>
              </div>
              <div className="info-row">
                <dt>Writing</dt>
                <dd>{config.readOnly ? 'read-only' : 'answers, messages and claims enabled'}</dd>
              </div>
              <div className="info-row">
                <dt>Plugin signal</dt>
                <dd>
                  {config.pluginConnected
                    ? 'seen within the last hour'
                    : 'no hook has reported yet'}
                </dd>
              </div>
            </dl>
          </section>

          {error ? <p className="form-error settings-error">{error}</p> : null}

          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={!dirty || saving || readOnly}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {savedAt && !dirty ? (
              <span className="settings-saved" role="status">
                <Check size={12} aria-hidden="true" />
                Saved to the daemon
              </span>
            ) : (
              <span className="settings-hint">
                {readOnly
                  ? 'Settings are locked while the daemon runs read-only.'
                  : dirty
                    ? 'Unsaved changes.'
                    : 'No changes to save.'}
              </span>
            )}
          </div>
        </div>
      )}
    </>
  )
}
