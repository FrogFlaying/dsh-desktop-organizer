/**
 * Sandbox test for shortcut creation. Never touches the real desktop.
 * Run: node test-shortcuts.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createShortcuts, undoShortcuts, safeLinkName } from './shortcuts.js'
import { resolveShortcutTargets } from './scan.js'

const sandbox = path.join(os.tmpdir(), `dsh-sc-${Date.now()}`)
const desktop = path.join(sandbox, 'Desktop')
const store = path.join(sandbox, 'store')
fs.mkdirSync(desktop, { recursive: true })

let failed = 0
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!pass) failed++
}

// Real apps verified present on this machine.
const apps = [
  { name: 'WorkBuddy', appId: 'WorkBuddy.WorkBuddy', category: 'ai', categoryLabel: 'AI 与大模型' },
  { name: 'ChatGPT', appId: 'OpenAI.Codex_2p2nqsd0c76g0!App', category: 'ai', categoryLabel: 'AI 与大模型' },
  { name: 'Ollama', appId: 'C:\\Users\\xuzq\\AppData\\Local\\Programs\\Ollama\\ollama app.exe', category: 'ai', categoryLabel: 'AI 与大模型' },
]

console.log('=== create 3 shortcuts into a category folder ===')
const r1 = createShortcuts(apps, { desktopDir: desktop, store })
console.log(`  created=${r1.created.length} skipped=${r1.skipped.length} failures=${r1.failures.length}`)
for (const f of r1.failures) console.log(`    FAIL ${f.name}: ${f.reason}`)
check('created all 3', r1.created.length === 3)
check('no failures', r1.failures.length === 0)

const catDir = path.join(desktop, 'AI 与大模型')
check('category folder created', fs.existsSync(catDir))
const files = fs.existsSync(catDir) ? fs.readdirSync(catDir).sort() : []
console.log('  files in category folder:', files.join(', '))
check('3 .lnk files present', files.length === 3)
check('CJK-safe name for Ollama kept', files.includes('Ollama.lnk'))

console.log('\n=== the created shortcuts are structurally valid ===')
const made = files.map(f => path.join(catDir, f))
const resolved = resolveShortcutTargets(made)
for (const [p, v] of resolved) {
  console.log(`  ${path.basename(p).padEnd(16)} target=${path.basename(v.target)} args=${v.args}`)
}
const wb = resolved.get(path.join(catDir, 'WorkBuddy.lnk'))
check('WorkBuddy targets explorer.exe', /explorer\.exe$/i.test(wb?.target ?? ''), wb?.target)
check('WorkBuddy args carry the AppsFolder id', (wb?.args ?? '').includes('shell:AppsFolder\\WorkBuddy.WorkBuddy'), wb?.args)
const ol = resolved.get(path.join(catDir, 'Ollama.lnk'))
check('Ollama targets the real exe', /ollama app\.exe$/i.test(ol?.target ?? ''), ol?.target)

console.log('\n=== collision: an existing file is never overwritten ===')
const before = fs.readFileSync(path.join(catDir, 'WorkBuddy.lnk'), 'utf8')
const r2 = createShortcuts([apps[0]], { desktopDir: desktop, store })
const after = fs.readdirSync(catDir).sort()
console.log('  files now:', after.join(', '))
check('a suffixed copy was made', after.includes('WorkBuddy (1).lnk'))
check('original untouched', fs.readFileSync(path.join(catDir, 'WorkBuddy.lnk'), 'utf8') === before)

console.log('\n=== undo removes exactly what the last batch created ===')
const u = undoShortcuts({ store })
console.log(`  removed=${u.removed.length} failures=${u.failures.length}`)
check('removed the 1 file from batch 2', u.removed.length === 1)
check('batch-1 files still present', fs.readdirSync(catDir).filter(f => f !== 'WorkBuddy (1).lnk').length === 3)

console.log('\n=== missing appId is skipped, not failed ===')
const r3 = createShortcuts([{ name: 'NoId', appId: '', category: 'ai', categoryLabel: 'AI 与大模型' }],
  { desktopDir: desktop, store })
check('skipped', r3.skipped.length === 1 && r3.failures.length === 0)

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(`\n=== SHORTCUTS: ${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} ===`)
process.exit(failed === 0 ? 0 : 1)
