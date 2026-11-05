/** Keep frequently shared libraries separately cacheable and transforms bounded. */
export function baselineChunk(id: string): string | undefined {
  const module = id.replaceAll('\\', '/')
  if (!module.includes('/node_modules/')) return
  if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(module)) return 'vendor-react'
  if (module.includes('/node_modules/@radix-ui/') || module.includes('/node_modules/@floating-ui/')) return 'vendor-primitives'
  if (/\/node_modules\/(?:motion|motion-dom|motion-utils|framer-motion)\//.test(module)) return 'vendor-motion'
  if (module.includes('/node_modules/recharts/')) return 'vendor-charts'
  if (/\/node_modules\/(?:d3-[^/]+|victory-vendor|lodash|lodash-es)\//.test(module)) return 'vendor-chart-utils'
}
