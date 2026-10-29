import type { PendingQuestion, PublicConfig, ServerEvent, SessionSummary } from '@shared/types'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ApiError, api, eventSourceUrl } from '../api'

export type ConnectionState = 'connecting' | 'live' | 'polling' | 'offline'

interface LiveContextValue {
  sessions: SessionSummary[]
  questions: PendingQuestion[]
  config: PublicConfig | null
  ready: boolean
  unauthorized: boolean
  bootError: string | null
  connection: ConnectionState
  error: string | null
  lastEventAt: number
  messageTick: number
  refresh: () => Promise<void>
  connect: () => Promise<boolean>
  reconnect: () => void
}

const LiveContext = createContext<LiveContextValue | null>(null)

function upsertSession(list: SessionSummary[], next: SessionSummary): SessionSummary[] {
  const index = list.findIndex((session) => session.id === next.id)
  if (index === -1) return [next, ...list]
  const copy = list.slice()
  copy[index] = next
  return copy
}

function upsertQuestion(list: PendingQuestion[], next: PendingQuestion): PendingQuestion[] {
  const filtered = list.filter((question) => question.id !== next.id)
  return [...filtered, next].sort((a, b) => a.createdAt - b.createdAt)
}

function withSessionQuestion(list: PendingQuestion[], session: SessionSummary): PendingQuestion[] {
  const others = list.filter((question) => question.sessionId !== session.id)
  if (!session.question) return others
  return [...others, session.question].sort((a, b) => a.createdAt - b.createdAt)
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [questions, setQuestions] = useState<PendingQuestion[]>([])
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [ready, setReady] = useState(false)
  const [unauthorized, setUnauthorized] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [lastEventAt, setLastEventAt] = useState(0)
  const [messageTick, setMessageTick] = useState(0)
  const [nonce, setNonce] = useState(0)
  const [fastPoll, setFastPoll] = useState(false)
  const fallbackRef = useRef(false)

  const connect = useCallback(async (): Promise<boolean> => {
    setBootError(null)
    try {
      const nextConfig = await api.config()
      const [sessionsResult, questionsResult] = await Promise.all([api.sessions(), api.questions()])
      setConfig(nextConfig)
      setSessions(sessionsResult.sessions)
      setQuestions(questionsResult.questions)
      setUnauthorized(false)
      setReady(true)
      setConnection('connecting')
      setError(null)
      return true
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : 'The daemon did not answer.'
      if (cause instanceof ApiError && cause.status === 401) {
        setUnauthorized(true)
      } else {
        setBootError(message)
      }
      setReady(false)
      return false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [sessionsResult, questionsResult, nextConfig] = await Promise.all([
        api.sessions(),
        api.questions(),
        api.config(),
      ])
      setSessions(sessionsResult.sessions)
      setQuestions(questionsResult.questions)
      setConfig(nextConfig)
      setUnauthorized(false)
      setError(null)
      if (fallbackRef.current) {
        setLastEventAt(Date.now())
        setConnection((state) => (state === 'offline' ? 'polling' : state))
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setUnauthorized(true)
        setReady(false)
        return
      }
      setError(cause instanceof ApiError ? cause.message : 'The daemon is not reachable.')
      setConnection('offline')
    }
  }, [])

  useEffect(() => {
    void connect()
  }, [connect])

  useEffect(() => {
    const onUnauthorized = () => {
      setUnauthorized(true)
      setReady(false)
    }
    window.addEventListener('csm:unauthorized', onUnauthorized)
    return () => window.removeEventListener('csm:unauthorized', onUnauthorized)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is a deliberate trigger that rebuilds the EventSource.
  useEffect(() => {
    if (!ready || unauthorized) return
    let source: EventSource
    let watchdog: number | undefined
    let degraded = false

    const degrade = () => {
      if (degraded) return
      degraded = true
      fallbackRef.current = true
      setFastPoll(true)
      setConnection('polling')
    }

    const armWatchdog = (delay: number) => {
      window.clearTimeout(watchdog)
      watchdog = window.setTimeout(degrade, delay)
    }

    try {
      source = new EventSource(eventSourceUrl())
    } catch {
      setConnection('offline')
      return
    }

    // Also cover proxies that never complete the stream handshake at all.
    armWatchdog(5_000)

    source.onopen = () => {
      setError(null)
      // Reverse proxies (e.g. a Cloudflare tunnel) can open the stream and
      // then buffer its body. The daemon sends `hello` immediately, so treat
      // a silent connection as degraded and keep the board fresh by polling.
      degraded = false
      fallbackRef.current = false
      setFastPoll(false)
      setConnection('connecting')
      armWatchdog(5_000)
    }
    source.onerror = () => {
      setConnection('offline')
    }

    const handle = (event: MessageEvent<string>, type: string) => {
      if (!event.data) return
      let payload: ServerEvent
      try {
        payload = JSON.parse(event.data) as ServerEvent
      } catch {
        return
      }
      if (!degraded) {
        setLastEventAt(Date.now())
        setConnection('live')
        // The server pings every 20 seconds; longer silence means the stream
        // is no longer delivering and polling has to take over.
        armWatchdog(25_000)
      }
      if (type === 'hello' && payload.type === 'hello') {
        setSessions(payload.sessions)
        setQuestions(payload.questions)
        setConfig(payload.config)
        return
      }
      if (payload.type === 'session') {
        setSessions((current) => upsertSession(current, payload.session))
        setQuestions((current) => withSessionQuestion(current, payload.session))
        return
      }
      if (payload.type === 'session.removed') {
        setSessions((current) => current.filter((session) => session.id !== payload.id))
        setQuestions((current) => current.filter((question) => question.sessionId !== payload.id))
        return
      }
      if (payload.type === 'question') {
        setQuestions((current) => upsertQuestion(current, payload.question))
        return
      }
      if (payload.type === 'question.resolved') {
        setQuestions((current) => current.filter((question) => question.id !== payload.id))
        setSessions((current) =>
          current.map((session) =>
            session.question?.id === payload.id ? { ...session, question: null } : session,
          ),
        )
        return
      }
      if (payload.type === 'message') {
        setMessageTick((value) => value + 1)
        return
      }
      if (payload.type === 'config') {
        setConfig(payload.config)
      }
    }

    const types: ServerEvent['type'][] = [
      'hello',
      'session',
      'session.removed',
      'question',
      'question.resolved',
      'message',
      'config',
      'ping',
    ]
    const listeners = types.map((type) => {
      const listener = (event: Event) => handle(event as MessageEvent<string>, type)
      source.addEventListener(type, listener)
      return [type, listener] as const
    })

    return () => {
      window.clearTimeout(watchdog)
      for (const [type, listener] of listeners) source.removeEventListener(type, listener)
      source.close()
    }
  }, [ready, unauthorized, nonce])

  useEffect(() => {
    if (!ready) return
    const timer = window.setInterval(() => void refresh(), fastPoll ? 5_000 : 30_000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [ready, fastPoll, refresh])

  const reconnect = useCallback(() => {
    setConnection('connecting')
    setNonce((value) => value + 1)
    void refresh()
  }, [refresh])

  const value = useMemo<LiveContextValue>(
    () => ({
      sessions,
      questions,
      config,
      ready,
      unauthorized,
      bootError,
      connection,
      error,
      lastEventAt,
      messageTick,
      refresh,
      connect,
      reconnect,
    }),
    [
      sessions,
      questions,
      config,
      ready,
      unauthorized,
      bootError,
      connection,
      error,
      lastEventAt,
      messageTick,
      refresh,
      connect,
      reconnect,
    ],
  )

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export function useLive(): LiveContextValue {
  const value = useContext(LiveContext)
  if (!value) throw new Error('useLive must be used inside <LiveProvider>')
  return value
}
