import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { Providers } from './app/providers.tsx'
import './styles/index.css'

const root = document.getElementById('root')
if (!root) throw new Error('index.html has no #root')
createRoot(root).render(
  <Providers>
    <App />
  </Providers>,
)
