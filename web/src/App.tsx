import { Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { BootScreen, TokenGate } from './components/ConnectionScreens'
import { useLive } from './lib/live'
import { BoardPage } from './pages/BoardPage'
import { CommandPage } from './pages/CommandPage'
import { CoordinationPage } from './pages/CoordinationPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { SessionPage } from './pages/SessionPage'
import { SettingsPage } from './pages/SettingsPage'

export function App() {
  const { ready, unauthorized, bootError } = useLive()

  if (unauthorized) return <TokenGate />
  if (!ready) return <BootScreen error={bootError} />

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<CommandPage />} />
        <Route path="sessions" element={<BoardPage />} />
        <Route path="sessions/:id" element={<SessionPage />} />
        <Route path="coordination" element={<CoordinationPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
