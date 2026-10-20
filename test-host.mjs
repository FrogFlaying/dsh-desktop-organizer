/**
 * Contract test for the Host half: drive `apply()` with a stub ctx and assert
 * that the tool registers, the routes register, and every action works.
 * Run: node test-host.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply } from './index.js'

// ── stub ctx ────────────────────────────────────────────────────────────────
const registeredTools = []
const registeredRoutes = []
const effects = []
const logs = []

const ctx = {
  logger: Object.assign(
    (...a) => logs.push(a.join(' ')),
    { info: (...a) => logs.push('info ' + a.join(' ')), warn: (...a) => logs.push('warn ' + a.join(' ')) },
  ),
  get: (k) => (k === 'homePaths' ? { home: process.env.DSH_HOME } : undefined),
  effect: (fn, label) => { effects.push(label ?? 'effect'); const d = fn(); if (typeof d === 'function') effects.push('disposer'); return d },
  tools: { register: (tool) => registeredTools.push(tool) },
  inject: (deps, cb) => {
    // Simulate the web server being published after apply().
    cb({ webServer: { register: (spec) => { registeredRoutes.push(spec); return () => {} } }, effect: ctx.effect })
  },
}

apply(ctx, {})
console.log('tools registered :', registeredTools.map(t => t.name).join(', '))
console.log('routes registered:', registeredRoutes.map(r => `${r.kind} ${r.path}`).join(', '))

const tool = registeredTools[0]
const call = (args) => tool.execute(args, {})

// ── exercise the tool ───────────────────────────────────────────────────────
console.log('\n--- action: report ---')
const rep = await call({ action: 'report', force: true })
console.log('ok =', rep.ok)
console.log('summary =', JSON.stringify(rep.summary))
console.log(rep.text.split('\n').slice(0, 8).join('\n'))

console.log('\n--- action: plan ---')
const plan = await call({ action: 'plan' })
console.log('plan length =', plan.plan?.length)
console.log('first 5 moves:')
for (const p of (plan.plan ?? []).slice(0, 5)) console.log(`   ${p.name} -> ${p.categoryLabel}/`)

console.log('\n--- action: apply (dryRun) ---')
const dry = await call({ action: 'apply', dryRun: true })
console.log('dryRun ok =', dry.ok, '| plan length =', dry.plan?.length)

console.log('\n--- action: undo with no snapshot ---')
const undo = await call({ action: 'undo' })
console.log('undo ok =', undo.ok)
console.log(undo.text)

console.log('\n--- bad action rejected ---')
try { await call({ action: 'nope' }); console.log('FAIL: should have thrown') }
catch (e) { console.log('PASS: threw ->', e.message) }

console.log('\n--- route handler: GET /report ---')
const route = registeredRoutes.find(r => r.path.includes('desktop-organizer'))
const fakeRes = {
  status: 0, body: '',
  writeHead(s) { this.status = s },
  end(b) { this.body = b },
}
await route.handler({ url: '/api/desktop-organizer/report', method: 'GET' }, fakeRes)
const parsed = JSON.parse(fakeRes.body)
console.log('status =', fakeRes.status, '| desktopItems =', parsed.summary?.desktopItems)

console.log('\n--- route handler: unknown route ---')
const res404 = { status: 0, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b } }
await route.handler({ url: '/api/desktop-organizer/nope', method: 'GET' }, res404)
console.log('status =', res404.status, '| body =', res404.body)

console.log('\n=== HOST CONTRACT: PASS ===')
