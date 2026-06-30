import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@moritzbrantner/ui/studio/styles.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
