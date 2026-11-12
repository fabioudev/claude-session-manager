import type { Epic } from '@shared/types'
import {
  ArrowUpRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  GitBranch,
  MessageCircle,
} from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  type EpicRollup,
  epicRollups,
  epicStatusLabel,
  epicsNeedingHuman,
  epicTone,
  standaloneTasks,
} from '../lib/epics'
import { relativeTime, sessionLabel } from '../lib/format'
import { useLive } from '../lib/live'

function repositoryNames(epic: Epic): string[] {
  return epic.repositories.map((repo) => repo.split('/').filter(Boolean).pop() || repo)
}

function needsReason(rollup: EpicRollup): string {
  const parts: string[] = []
  if (rollup.unanswered > 0) {
    parts.push(
      `${rollup.unanswered} ${rollup.unanswered === 1 ? 'Frage' : 'Fragen'} im Epic-Thread`,
    )
  }
  if (rollup.epic.status === 'blocked') parts.push('Epic ist blockiert')
  return parts.join(' · ')
}

function EpicCard({ rollup }: { rollup: EpicRollup }) {
  const { epic } = rollup
  const repos = repositoryNames(epic)
  return (
    <Link className="epic-card" to={`/epics/${encodeURIComponent(epic.id)}`}>
      <div className="epic-card-head">
        <span className={`epic-status ${rollup.needsHuman ? 'needs' : epicTone(rollup)}`}>
          {rollup.needsHuman ? 'Braucht dich' : epicStatusLabel(rollup)}
        </span>
        <span className="epic-card-age">
          <Clock3 size={13} aria-hidden="true" />
          {relativeTime(rollup.lastActivityAt)}
        </span>
      </div>
      <h3>{epic.title}</h3>
      <p className="epic-card-line">{epic.statusLine || 'Noch keine Statuszeile.'}</p>
      <div className="epic-card-repos">
        {repos.length ? (
          repos.map((repo) => (
            <span key={repo} className="epic-repo">
              <GitBranch size={12} aria-hidden="true" />
              {repo}
            </span>
          ))
        ) : (
          <span className="epic-repo">Kein Repo angegeben</span>
        )}
        {epic.previewUrl ? (
          <span className="epic-preview">
            <ExternalLink size={12} aria-hidden="true" />
            Vorschau
          </span>
        ) : null}
      </div>
      <div className="epic-card-roll">
        <div className="epic-progress" aria-hidden="true">
          <span style={{ width: `${rollup.progress}%` }} />
        </div>
        <span>
          {rollup.done}/{rollup.total} fertig · Ø {rollup.progress}%
        </span>
      </div>
      <div className="epic-card-foot">
        <span>
          {rollup.owner ? sessionLabel(rollup.owner) : 'Kein Epic-Commander'}
          {rollup.openTasks.length ? ` · ${rollup.openTasks.length} offen` : ''}
        </span>
        <span className="epic-card-open">
          Öffnen <ArrowUpRight size={13} aria-hidden="true" />
        </span>
      </div>
    </Link>
  )
}

export function EpicsPage() {
  const { sessions, commandCenter } = useLive()
  const rollups = useMemo(() => epicRollups(commandCenter, sessions), [commandCenter, sessions])
  const open = rollups.filter(
    (rollup) => rollup.epic.status !== 'done' && rollup.epic.status !== 'cancelled',
  )
  const closed = rollups.filter(
    (rollup) => rollup.epic.status === 'done' || rollup.epic.status === 'cancelled',
  )
  const needs = epicsNeedingHuman(open)
  const standalone = standaloneTasks(commandCenter)

  return (
    <div className="epics-page">
      <section className="epics-hero">
        <div>
          <h1>Epics</h1>
          <p>
            Jede größere Aufgabe an einem Ort: Stand, Repos, Vorschau und der eigene Thread mit dem
            Epic-Commander.
          </p>
        </div>
        <div className="epics-hero-figure">
          <strong>{open.length}</strong>
          <span>{open.length === 1 ? 'offenes Epic' : 'offene Epics'}</span>
          <small>{needs.length ? `${needs.length} brauchen dich` : 'Nichts wartet auf dich'}</small>
        </div>
      </section>

      {needs.length ? (
        <section className="epics-needs" aria-labelledby="epics-needs-title">
          <div className="command-section-head">
            <div>
              <h2 id="epics-needs-title">Braucht dich</h2>
              <p>Fragen aus den Threads, Ergebnisse zur Abnahme und Blockaden.</p>
            </div>
            <span className="attention-count">{needs.length}</span>
          </div>
          <div className="epic-needs-list">
            {needs.map((rollup) => (
              <Link
                key={rollup.epic.id}
                className="epic-need-row"
                to={`/epics/${encodeURIComponent(rollup.epic.id)}`}
              >
                <span className="epic-need-icon">
                  {rollup.unanswered > 0 ? (
                    <MessageCircle size={16} aria-hidden="true" />
                  ) : (
                    <CircleAlert size={16} aria-hidden="true" />
                  )}
                </span>
                <span className="epic-need-body">
                  <strong>{rollup.epic.title}</strong>
                  <small>{needsReason(rollup)}</small>
                </span>
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="epics-open" aria-labelledby="epics-open-title">
        <div className="command-section-head">
          <div>
            <h2 id="epics-open-title">Offene Epics</h2>
            <p>Der Fortschritt kommt aus den zugeordneten Aufgaben, nicht aus Schätzungen.</p>
          </div>
        </div>
        {open.length ? (
          <div className="epic-grid">
            {open.map((rollup) => (
              <EpicCard key={rollup.epic.id} rollup={rollup} />
            ))}
          </div>
        ) : (
          <div className="epic-empty">
            Noch kein Epic. Schreibe eine größere Aufgabe in den Commander-Chat; er legt das Epic an
            und hängt die Teiltasks hinein.
          </div>
        )}
      </section>

      {standalone.length ? (
        <section className="epics-standalone" aria-labelledby="epics-standalone-title">
          <div className="command-section-head">
            <div>
              <h2 id="epics-standalone-title">Ohne Epic</h2>
              <p>Offene Aufgaben, die noch keinem Epic zugeordnet sind.</p>
            </div>
            <span className="nav-count">{standalone.length}</span>
          </div>
          <ul className="epic-standalone-list">
            {standalone.map((task) => (
              <li key={task.id}>
                <span className={`task-state ${task.status}`}>{task.status.replace('_', ' ')}</span>
                <span className="epic-standalone-title">{task.title}</span>
                <small>{task.projectPath?.split('/').pop() || 'ohne Projekt'}</small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {closed.length ? (
        <section className="epics-closed" aria-labelledby="epics-closed-title">
          <div className="command-section-head">
            <div>
              <h2 id="epics-closed-title">Abgeschlossen</h2>
              <p>Fertige und eingestellte Epics, zuletzt zuerst.</p>
            </div>
          </div>
          <ul className="epic-closed-list">
            {closed.slice(0, 8).map((rollup) => (
              <li key={rollup.epic.id}>
                <Link to={`/epics/${encodeURIComponent(rollup.epic.id)}`}>{rollup.epic.title}</Link>
                <span>{rollup.epic.status === 'done' ? 'fertig' : 'eingestellt'}</span>
                <small>{relativeTime(rollup.lastActivityAt)}</small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
