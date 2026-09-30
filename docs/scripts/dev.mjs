// `vocs dev`, plus Mermaid in Vite's dependency pre-bundling. The vocs CLI
// starts Vite with `configFile: false` and excludes vocs from pre-bundling, so
// the diagram component's `import('mermaid')` is served unbundled and fails on
// mermaid's CommonJS dependency dayjs ("does not provide an export named
// 'default'"). Production builds are unaffected.
//
//   node scripts/dev.mjs [--port 5173]
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

// The vocs CLI's own plugin set; the package does not export this path.
const { vocs } = await import(new URL('../node_modules/vocs/dist/waku/vite.js', import.meta.url).href)
const at = process.argv.indexOf('--port')
const port = at === -1 ? 5173 : Number(process.argv[at + 1])

const server = await createServer({
  configFile: false,
  plugins: [react(), vocs(), { name: 'referee-docs:mermaid', config: () => ({ optimizeDeps: { include: ['mermaid'] } }) }],
  server: { port },
})
await server.listen()
server.printUrls()
