import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { takeTokenFromUrl } from './api'
import { QuestionDialogProvider } from './components/QuestionDialog'
import { ToastProvider } from './components/Toast'
import { LiveProvider } from './lib/live'
import { ThemeProvider } from './lib/theme'

takeTokenFromUrl()

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <LiveProvider>
        <ToastProvider>
          <QuestionDialogProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </QuestionDialogProvider>
        </ToastProvider>
      </LiveProvider>
    </ThemeProvider>
  </StrictMode>,
)
