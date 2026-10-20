/**
 * End-to-end test of plan -> apply -> undo on a THROWAWAY sandbox directory.
 * Never touches the real desktop.
 * Run: node test-organize.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { planOrganization, applyPlan, undoBatch } from './organize.js'

const sandbox = path.join(os.tmpdir(), `dsh-do-sandbox-${Date.now()}`)
const desktop = path.join(sandbox, 'Desktop')
const store = path.join(sandbox, 'store')
fs.mkdirSync(desktop, { recursive: true })

// Build a fake desktop that mirrors the real one's shape.
const files = [
  'AnythingLLM.lnk', 'Trae.lnk', '豆包.lnk', 'Visual Studio Code.lnk',
  'Docker Desktop.lnk', 'notepad++.lnk', 'dbeaver.exe.lnk', 'RedisDesktopManager.lnk',
  'Obsidian.lnk', 'XMind 8 Update 8.lnk', 'Clash for Windows.lnk', 'Discord.lnk',
  'EV录屏.lnk', 'desktop.ini', '~$budget.xlsx', 'mystery-tool.lnk',
]
for (const f of files) fs.writeFileSync(path.join(desktop, f), 'x')
// A pre-existing user folder that must be left completely alone.
fs.mkdirSync(path.join(desktop, 'plan'), { recursive: true })
fs.writeFileSync(path.join(desktop, 'plan', 'keep-me.txt'), 'important')

const report = {
  folders: { desktop },
  categories: [
    { id: 'ai', label: 'AI 与大模型', items: [
      { name: 'AnythingLLM.lnk', path: path.join(desktop, 'AnythingLLM.lnk'), isDir: false },
      { name: 'Trae.lnk', path: path.join(desktop, 'Trae.lnk'), isDir: false },
      { name: '豆包.lnk', path: path.join(desktop, '豆包.lnk'), isDir: false },
    ] },
    { id: 'dev', label: '开发工具', items: [
      { name: 'Visual Studio Code.lnk', path: path.join(desktop, 'Visual Studio Code.lnk'), isDir: false },
      { name: 'Docker Desktop.lnk', path: path.join(desktop, 'Docker Desktop.lnk'), isDir: false },
      { name: 'notepad++.lnk', path: path.join(desktop, 'notepad++.lnk'), isDir: false },
    ] },
    { id: 'db', label: '数据库', items: [
      { name: 'dbeaver.exe.lnk', path: path.join(desktop, 'dbeaver.exe.lnk'), isDir: false },
      { name: 'RedisDesktopManager.lnk', path: path.join(desktop, 'RedisDesktopManager.lnk'), isDir: false },
    ] },
    { id: 'other', label: 'other', items: [
      { name: 'desktop.ini', path: path.join(desktop, 'desktop.ini'), isDir: false },
      { name: '~$budget.xlsx', path: path.join(desktop, '~$budget.xlsx'), isDir: false },
      { name: 'mystery-tool.lnk', path: path.join(desktop, 'mystery-tool.lnk'), isDir: false },
      { name: 'plan', path: path.join(desktop, 'plan'), isDir: true },
    ] },
  ],
}

const show = (label) => {
  console.log(`\n--- ${label} ---`)
  for (const e of fs.readdirSync(desktop).sort()) {
    const full = path.join(desktop, e)
    if (fs.statSync(full).isDirectory()) {
      console.log(`  [DIR] ${e}/  ->  ${fs.readdirSync(full).sort().join(', ')}`)
    } else console.log(`  ${e}`)
  }
}

show('BEFORE')

const plan = planOrganization(report, { desktopDir: desktop })
console.log(`\nplan has ${plan.length} moves:`)
for (const p of plan) console.log(`  ${p.name}  ->  ${path.basename(path.dirname(p.to))}/`)

const result = applyPlan(plan, { store })
console.log(`\napply: moved ${result.moved.length}, failed ${result.failures.length}`)
for (const f of result.failures) console.log(`  FAIL ${f.name}: ${f.reason}`)
show('AFTER APPLY')

const undo = undoBatch({ store })
console.log(`\nundo: restored ${undo.restored.length}, failed ${undo.failures.length}`)
show('AFTER UNDO')

// Assertions. `plan/` pre-existed, so it belongs in the baseline too.
const after = fs.readdirSync(desktop).sort()
const before = [...files, 'plan'].sort()
const preserved = fs.readFileSync(path.join(desktop, 'plan', 'keep-me.txt'), 'utf8') === 'important'
const desktopIniStayed = after.includes('desktop.ini')
const tempStayed = after.includes('~$budget.xlsx')
const roundTripped = JSON.stringify(after) === JSON.stringify(before)

console.log('\n=== ASSERTIONS ===')
console.log('  desktop.ini never moved      :', desktopIniStayed ? 'PASS' : 'FAIL')
console.log('  ~$ temp file never moved     :', tempStayed ? 'PASS' : 'FAIL')
console.log('  user folder contents intact  :', preserved ? 'PASS' : 'FAIL')
console.log('  undo restored exact set      :', roundTripped ? 'PASS' : 'FAIL')
if (!roundTripped) { console.log('    before:', before); console.log('    after :', after) }

fs.rmSync(sandbox, { recursive: true, force: true })
console.log('\nsandbox cleaned:', !fs.existsSync(sandbox))
