/**
 * Regression tests for the three bugs reported after the first real run.
 * Run: node test-regress.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { compileRules, classify, isCategoryFolderName, DEFAULT_RULES } from './scan.js'
import { planOrganization } from './organize.js'
import { safeLinkName } from './shortcuts.js'

const compiled = compileRules(DEFAULT_RULES)
let failed = 0
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!pass) failed++
}

console.log('=== BUG 1: category folders must not be classified as "other" ===')
for (const label of ['AI 与大模型', '开发工具', '数据库', '办公与文档', '影音与图像', '浏览器与网络', '通讯与社交']) {
  const id = classify(label, compiled)
  check(`"${label}" classifies to its own id (not other)`, id !== 'other', `-> ${id}`)
}
check('isCategoryFolderName("AI 与大模型")', isCategoryFolderName('AI 与大模型', compiled))
check('isCategoryFolderName("我的资料") is false', !isCategoryFolderName('我的资料', compiled))

console.log('\n=== BUG 1b: planOrganization must never move a category folder ===')
const fakeDesktop = path.join(os.tmpdir(), `dsh-regress-${Date.now()}`)
fs.mkdirSync(fakeDesktop, { recursive: true })
const mk = n => { const p = path.join(fakeDesktop, n); fs.mkdirSync(p, { recursive: true }); return p }

const report = {
  _compiled: compiled,
  folders: { desktop: fakeDesktop },
  categories: [
    { id: 'other', label: 'other', items: [
      // A category folder that a previous run left at the root, misclassified.
      { name: 'AI 与大模型', path: mk('AI 与大模型'), isDir: true },
      { name: '我的资料', path: mk('我的资料'), isDir: true },
      { name: 'CC Switch.lnk', path: path.join(fakeDesktop, 'CC Switch.lnk'), isDir: false },
    ] },
  ],
}
fs.writeFileSync(path.join(fakeDesktop, 'CC Switch.lnk'), 'x')

const planWithFiles = planOrganization(report, { desktopDir: fakeDesktop, includeFiles: true })
const plannedNames = planWithFiles.map(p => p.name)
check('category folder NOT in plan', !plannedNames.includes('AI 与大模型'), `plan=[${plannedNames.join(', ')}]`)
check('user folder NOT moved by includeFiles alone', !plannedNames.includes('我的资料'), `plan=[${plannedNames.join(', ')}]`)
check('loose .lnk IS in plan', plannedNames.includes('CC Switch.lnk'))

// Folders move only when explicitly opted in — the guard that prevents the
// "user's own folder gets buried in a category bucket" failure.
const planWithFolders = planOrganization(report, {
  desktopDir: fakeDesktop, includeFiles: true, includeFolders: true,
})
const folderNames = planWithFolders.map(p => p.name)
check('user folder moves with includeFolders', folderNames.includes('我的资料'))
check('category folder STILL not moved even with includeFolders', !folderNames.includes('AI 与大模型'), `plan=[${folderNames.join(', ')}]`)

const planNoFiles = planOrganization(report, { desktopDir: fakeDesktop, includeFiles: false })
check('nothing planned when includeFiles=false (other bucket)', planNoFiles.length === 0)

console.log('\n=== BUG 2: WorkBuddy and friends classify as AI ===')
for (const n of ['WorkBuddy', 'CodeBuddy', 'JobsterAI', 'CodeArts', 'Qoder', 'MiniMax', 'ChatGPT', 'Cursor']) {
  const id = classify(n, compiled)
  check(`${n} -> ai`, id === 'ai', `-> ${id}`)
}

console.log('\n=== BUG 3: shortcut file names are Windows-safe ===')
check('strips illegal chars', safeLinkName('a/b:c*d?e') === 'a_b_c_d_e.lnk', `-> ${safeLinkName('a/b:c*d?e')}`)
check('keeps CJK', safeLinkName('豆包') === '豆包.lnk')
check('appends .lnk', safeLinkName('WorkBuddy') === 'WorkBuddy.lnk')
check('empty name falls back', safeLinkName('') === 'App.lnk', `-> ${safeLinkName('')}`)
check('trailing dot stripped', safeLinkName('Name.') === 'Name.lnk', `-> ${safeLinkName('Name.')}`)

fs.rmSync(fakeDesktop, { recursive: true, force: true })
console.log(`\n=== REGRESSION: ${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} ===`)
process.exit(failed === 0 ? 0 : 1)
