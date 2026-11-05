import fs from 'node:fs'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(root, 'node_modules/@fontsource-variable/noto-sans-sc/wght.css'), 'utf8')
let count = 0
for (const match of css.matchAll(/url\((?:['"])?(\.\/files\/[^)'"]+)/g)) {
  if (!fs.existsSync(path.join(root, 'node_modules/@fontsource-variable/noto-sans-sc', match[1]))) throw new Error('Missing font: ' + match[1])
  count++
}
if (!count) throw new Error('No self-hosted CJK faces found')
const latin = fs.readFileSync(path.join(root, 'src/fonts.css'), 'utf8')
for (const match of latin.matchAll(/url\(["'](\/fonts\/[^"']+)/g)) {
  if (!fs.existsSync(path.join(root, 'public', match[1]))) throw new Error('Missing local font: ' + match[1])
}
console.log('Fonts verified: ' + count + ' self-hosted CJK subsets, local Latin and mono faces')
