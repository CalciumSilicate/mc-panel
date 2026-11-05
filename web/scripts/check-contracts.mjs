import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const root = path.resolve(process.env.FRONTEND_ROOT || path.resolve(import.meta.dirname, '..'))
const errors = []
const report = (file, message) => errors.push(path.relative(root, file) + ': ' + message)
const opacity = require('tailwindcss/defaultTheme').opacity
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) { walk(file); continue }
    if (!/\.(tsx?|css)$/.test(file) || /\.test\.ts$/.test(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const m of source.matchAll(/(?:bg|text|border|ring|shadow)-[\w-]+\/(\d+)(?![\d.])/g)) if (!(m[1] in opacity)) report(file, 'Unsupported opacity /' + m[1] + '; use /[0.xx]')
    if (/(?:Dashboard|Shell)\.tsx$/.test(file) && /AnimatePresence\s+mode=['"]wait/.test(source)) report(file, 'Navigation must not wait for exit animation')
    if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    function visit(node) {
      if (ts.isStringLiteral(node) && node.text.startsWith('app:')) report(file, 'Use nsKey() for local namespaces')
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === 'select') report(file, 'Use Select/Combobox instead of native select')
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === 'input' && node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'type' && attribute.initializer && ts.isStringLiteral(attribute.initializer) && ['checkbox', 'radio'].includes(attribute.initializer.text))) report(file, 'Use Checkbox/RadioGroup instead of native selection inputs')
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(ast)
        if (name === 'window.confirm' || name === 'confirm' && !source.includes('useConfirm')) report(file, 'Use useConfirm()')
        if (name === 'fetch' && !file.includes(path.sep + 'api' + path.sep)) report(file, 'Keep HTTP transport in api/')
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
}
walk(path.join(root, 'src'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
if (!pkg.dependencies['tailwind-merge']?.startsWith('2.')) errors.push('Tailwind 3 requires the compatible tailwind-merge 2.x baseline')
const config = JSON.parse(fs.readFileSync(path.join(root, 'app.config.json'), 'utf8'))
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.appId)) errors.push('appId must be a stable lowercase kebab-case identifier')
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
else console.log('Frontend contracts passed')
