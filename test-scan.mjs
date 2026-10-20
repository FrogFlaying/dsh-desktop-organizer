/**
 * Standalone smoke test for the desktop-organizer scan core.
 * Run: node test-scan.mjs
 */
import { buildReport } from './scan.js'

const t0 = Date.now()
const report = buildReport()
const ms = Date.now() - t0

console.log('=== SUMMARY ===')
console.log(JSON.stringify(report.summary, null, 2))
console.log(`\nscan took ${ms} ms`)

console.log('\n=== DESKTOP CATEGORIES ===')
for (const c of report.categories) {
  console.log(`\n[${c.id}] ${c.label}  (${c.count})`)
  for (const i of c.items) console.log(`   - ${i.name}${i.broken ? '  <BROKEN>' : ''}`)
}

console.log('\n=== NOT ON DESKTOP (first 60) ===')
for (const m of report.missingFromDesktop.slice(0, 60)) {
  console.log(`   [${m.category}] ${m.name}   :: ${m.appId}`)
}

console.log('\n=== BROKEN SHORTCUTS ===')
if (report.brokenShortcuts.length === 0) console.log('   (none)')
for (const b of report.brokenShortcuts) console.log(`   ${b.name} -> ${b.target}`)
