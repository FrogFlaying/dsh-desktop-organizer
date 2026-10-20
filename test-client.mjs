/**
 * Contract test for the browser half.
 *
 * Loads client.js with a stub `window.__ModuleLoader__`, a stub React, and a
 * stub slot registry, then asserts the factory registers the settings section.
 * This catches syntax errors, bad export shapes, and slot misuse without a
 * browser.
 *
 * Run: node test-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// ── stub React ──────────────────────────────────────────────────────────────
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
}

// ── stub module loader ──────────────────────────────────────────────────────
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => { loaded = spec },
  },
  confirm: () => false,
}
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

const code = fs.readFileSync(path.join(here, 'client.js'), 'utf8')
// The shell provides `react` through the module table; emulate that.
new Function('window', code)(globalThis.window)

if (!loaded) { console.error('FAIL: module loader was never called'); process.exit(1) }
console.log('module id   :', loaded.id)
console.log('has factory :', typeof loaded.factory === 'function')

const module_ = { exports: {} }
const api = loaded.factory(name => {
  if (name === 'react') return React
  throw new Error(`unexpected require("${name}") — a plain-JS plugin may only take react from the shell`)
})
console.log('api.inject  :', JSON.stringify(api.inject))
console.log('api.apply   :', typeof api.apply)

// ── stub slot registry ──────────────────────────────────────────────────────
const registrations = []
const ctx = {
  slots: {
    inject: (owner, cb) => { registrations.push({ owner }); cb() },
    register: (options, component) => {
      registrations[registrations.length - 1].options = options
      registrations[registrations.length - 1].component = component
      return () => {}
    },
  },
  get: () => undefined,
}

api.apply(ctx)

console.log('\nregistrations:')
for (const r of registrations) {
  console.log(`  owner=${r.owner} id=${r.options?.id} order=${r.options?.order} label=${r.options?.label?.()}`)
}

const section = registrations.find(r => r.owner === 'settings.section')
const checks = [
  ['registers into settings.section', !!section],
  ['slot name matches owner', section?.options?.name === 'settings.section'],
  ['has a stable id', section?.options?.id === 'desktop-organizer'],
  ['has a label thunk', typeof section?.options?.label === 'function'],
  ['label renders (zh)', typeof section?.options?.label?.() === 'string'],
  ['component is a function', typeof section?.component === 'function'],
]

console.log('\n=== ASSERTIONS ===')
let failed = 0
for (const [label, pass] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) failed++
}

// Render the component once with the stub React to prove it does not throw.
console.log('\n--- render smoke test ---')
try {
  const element = section.component({ ctx })
  console.log('rendered root type:', element?.type?.name ?? element?.type ?? '(unknown)')
  console.log('PASS  component rendered without throwing')
} catch (e) {
  console.log('FAIL  component threw:', e.message)
  failed++
}

console.log(`\n=== CLIENT CONTRACT: ${failed === 0 ? 'PASS' : `FAIL (${failed})`} ===`)
process.exit(failed === 0 ? 0 : 1)
