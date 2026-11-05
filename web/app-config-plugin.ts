import { baselineChunk } from './build-chunks'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'
export function appConfigPlugin(): Plugin { return { name: 'app-config-html', config() { return { build: { rollupOptions: { output: { manualChunks: baselineChunk } } } } }, transformIndexHtml(html) { const config = JSON.parse(readFileSync(new URL('./app.config.json', import.meta.url), 'utf8')); const title = String(config.brandName).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]!)); return html.replace(/<title>[\s\S]*?<\/title>/i, '<title>' + title + '</title>').replace(/localStorage\.getItem\(['"][^'"]*:theme['"]\)/, 'localStorage.getItem(' + JSON.stringify(config.appId + ':theme') + ')') } } }
