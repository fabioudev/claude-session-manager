import { Check, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useToast } from '../components/Toast'
import { dateTime } from '../lib/format'
import { useLive } from '../lib/live'
import { useTheme } from '../lib/theme'

type QuestionMode = 'board' | 'terminal'

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
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const configMode = config ? boardMode(config.questionMode) : null
  const configTimeout = config?.questionTimeoutSeconds ?? null
  const configLaunch = config?.launchEnabled ?? null

  useEffect(() => {
    if (configMode === null || configTimeout === null || configLaunch === null) return
    setMode(configMode)
    setQuestionTimeout(configTimeout)
    setLaunchEnabled(configLaunch)
  }, [configMode, configTimeout, configLaunch])

  const readOnly = Boolean(config?.readOnly)
  const dirty = Boolean(
    config &&
      !readOnly &&
      (mode !== boardMode(config.questionMode) ||
        questionTimeout !== config.questionTimeoutSeconds ||
        launchEnabled !== config.launchEnabled),
  )

  function editMode(next: QuestionMode) {
    setMode(next)
    setSavedAt(null)
  }

  async function save() {
    if (!config || saving || readOnly) return
    setSaving(true)
    setError(null)
    try {
      await api.updateSettings({
        questionMode: mode === 'board' ? 'auto' : 'terminal',
        questionTimeoutSeconds: questionTimeout,
        launchEnabled,
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
