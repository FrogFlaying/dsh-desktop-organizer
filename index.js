/**
 * Desktop Organizer — Host half.
 *
 * Contributes one agent tool (`desktop_organize`) and a small same-origin JSON
 * API the settings page reads. The scan itself lives in `scan.js`, which uses
 * only Node builtins plus two PowerShell probes (AppsFolder enumeration and
 * .lnk target resolution) that have no reliable pure-Node equivalent.
 *
 * Wiring notes for whoever reads this next:
 *   - `ctx.inject(['webServer'], ...)` rather than `ctx.get('webServer')` at
 *     apply time: plugins load before the browser half publishes the server, so
 *     a one-shot read answers `undefined` and the routes never register.
 *   - Nothing here touches the profile's package.json or cordis.patch.yml; the
 *     Plugin Manager owns those.
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReport, knownFolders, DEFAULT_RULES, compileRules, planRepair, applyRepair } from './scan.js'
import { planOrganization, applyPlan, undoBatch } from './organize.js'
import { createShortcuts, undoShortcuts } from './shortcuts.js'

export const name = 'desktop-organizer'

/** Only `tools` is required; the HTTP surface degrades away without a server. */
export const inject = ['tools']

const PKG_DIR = fileURLToPath(new URL('./', import.meta.url))
const API_PREFIX = '/api/desktop-organizer'

/** Where undo snapshots and the last report live. */
function dataDir(ctx) {
  const home = ctx.get('homePaths')?.home ?? process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '.', '.dsh')
  return path.join(home, 'desktop-organizer')
}

/**
 * Serialize scans: the shell probes are the expensive part, and a settings page
 * left open should not re-run them on every render.
 */
function createCache(ttlMs = 30_000) {
  let value = null
  let at = 0
  return {
    get(force = false) {
      const now = Date.now()
      if (!force && value && now - at < ttlMs) return value
      value = buildReport()
      at = now
      return value
    },
    peek() { return value },
  }
}

/** Read the plugin's own tunable config, falling back to the built-in rules. */
function resolveConfig(config) {
  const rules = Array.isArray(config?.rules) && config.rules.length > 0 ? config.rules : DEFAULT_RULES
  return {
    rules,
    desktopDir: config?.desktopDir ?? knownFolders().desktop,
    categoryFolderPrefix: config?.categoryFolderPrefix ?? '',
  }
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const cache = createCache(Number(config?.cacheTtlMs) > 0 ? Number(config.cacheTtlMs) : 30_000)
  const log = ctx.logger?.('desktop-organizer') ?? ctx.logger ?? console

  const report = (force = false) => cache.get(force)

  /* ─────────────────────────── agent tool ─────────────────────────── */

  ctx.tools.register({
    name: 'desktop_organize',
    description:
      'Inspect and tidy the Windows desktop. action "report" lists desktop items grouped by category, ' +
      'installed apps that have no desktop shortcut, and broken shortcuts. action "plan" computes a move ' +
      'plan without touching anything. action "apply" performs the moves and records an undo snapshot. ' +
      'action "undo" reverses the most recent apply. action "shortcuts" creates desktop shortcuts for ' +
      'installed apps that have none, filing each into its category folder. action "repair" pulls category ' +
      'folders back out of "other" if an earlier run misfiled them. Always run "report" or "plan" before "apply".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['report', 'plan', 'apply', 'undo', 'shortcuts', 'repair'],
          description:
            'report = read-only inventory; plan = dry run; apply = move files; undo = revert last apply; ' +
            'shortcuts = create missing shortcuts (filed by category); repair = recover misfiled category folders.',
        },
        dryRun: {
          type: 'boolean',
          description: 'For apply/shortcuts/repair: compute what would happen and return it without changing anything.',
        },
        includeFiles: {
          type: 'boolean',
          description: 'Also file non-shortcut desktop files (documents, images) into category folders. Default false.',
        },
        only: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to these category ids (e.g. ["ai","dev"]). Omit for every category.',
        },
        apps: {
          type: 'array',
          items: { type: 'string' },
          description: 'For shortcuts: only these app names (as shown in the report). Omit for every missing app.',
        },
        force: {
          type: 'boolean',
          description: 'For report: bypass the 30-second scan cache.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'text'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          text: { type: 'string' },
          summary: { type: 'object', additionalProperties: true, properties: {} },
          plan: {
            type: 'array',
            items: { type: 'object', additionalProperties: true, properties: {} },
          },
          apps: {
            type: 'array',
            items: { type: 'object', additionalProperties: true, properties: {} },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const action = String(args.action ?? 'report')
      const store = dataDir(ctx)

      if (action === 'report') {
        const r = report(args.force === true)
        return { ok: true, action, text: renderReport(r), summary: r.summary }
      }

      if (action === 'plan') {
        const r = report(false)
        const plan = planOrganization(r, {
          includeFiles: args.includeFiles === true,
          only: args.only,
          desktopDir: cfg.desktopDir,
        })
        return { ok: true, action, text: renderPlan(plan), summary: r.summary, plan }
      }

      if (action === 'apply') {
        const r = report(false)
        const plan = planOrganization(r, {
          includeFiles: args.includeFiles === true,
          only: args.only,
          desktopDir: cfg.desktopDir,
        })
        if (plan.length === 0) return { ok: true, action, text: '没有需要整理的项目。', plan: [] }
        if (args.dryRun === true) return { ok: true, action, text: `[dry run]\n${renderPlan(plan)}`, plan }
        const result = applyPlan(plan, { store })
        cache.get(true)
        return {
          ok: result.failures.length === 0,
          action,
          text: renderApply(result),
          plan,
        }
      }

      if (action === 'undo') {
        const result = undoBatch({ store })
        cache.get(true)
        return { ok: result.failures.length === 0, action, text: renderUndo(result) }
      }

      if (action === 'shortcuts') {
        const r = report(false)
        const wanted = Array.isArray(args.apps) && args.apps.length > 0
          ? new Set(args.apps.map(a => String(a).toLowerCase()))
          : null
        const only = Array.isArray(args.only) && args.only.length > 0 ? new Set(args.only) : null
        const targets = (r.missingFromDesktop ?? [])
          .filter(m => (wanted ? wanted.has(m.name.toLowerCase()) : true))
          .filter(m => (only ? only.has(m.category) : true))
          .map(m => ({
            name: m.name,
            appId: m.appId,
            category: m.category,
            categoryLabel: labelOfCategory(r, m.category),
          }))

        if (targets.length === 0) return { ok: true, action, text: '没有需要创建快捷方式的程序。', apps: [] }

        // Creating a shortcut for every installed app would bury the desktop
        // again — the very problem this plugin exists to solve. An unfiltered
        // run that would create a lot of shortcuts is refused, and the caller is
        // told how to narrow it. `dryRun` stays available for an overview.
        const cap = Number(config?.maxUnfilteredShortcuts) > 0 ? Number(config.maxUnfilteredShortcuts) : 40
        if (!wanted && !only && targets.length > cap && args.dryRun !== true) {
          return {
            ok: false,
            action,
            text: [
              `拒绝执行：未加筛选会一次创建 ${targets.length} 个快捷方式，这会让桌面重新变乱。`,
              `请改用下面任一方式收窄范围（上限 ${cap} 个）：`,
              '  - desktop_organize action="shortcuts" apps=["WorkBuddy","ChatGPT"]',
              '  - desktop_organize action="shortcuts" only=["ai"]',
              `  - 或先在 Web UI 的「未在桌面」页勾选要的程序`,
            ].join('\n'),
            apps: [],
          }
        }

        if (args.dryRun === true) {
          return { ok: true, action, text: `[dry run] 将创建 ${targets.length} 个快捷方式：\n${renderShortcutPlan(targets)}`, apps: targets }
        }
        const result = createShortcuts(targets, { desktopDir: cfg.desktopDir, store })
        cache.get(true)
        return {
          ok: result.failures.length === 0,
          action,
          text: renderShortcuts(result),
          apps: result.created,
        }
      }

      if (action === 'repair') {
        const r = report(false)
        const moves = planRepair(r, { desktopDir: cfg.desktopDir })
        if (moves.length === 0) return { ok: true, action, text: '没有需要恢复的分类文件夹。' }
        if (args.dryRun === true) {
          const lines = [`[dry run] 将恢复 ${moves.length} 个文件夹：`]
          for (const m of moves) lines.push(`  ${m.name}  (other/ → 桌面根目录)`)
          return { ok: true, action, text: lines.join('\n') }
        }
        const result = applyRepair(moves, { store })
        cache.get(true)
        const lines = [`已恢复 ${result.repaired.length} 个分类文件夹，失败 ${result.failures.length} 个。`]
        for (const f of result.failures) lines.push(`  失败：${f.name} — ${f.reason}`)
        return { ok: result.failures.length === 0, action, text: lines.join('\n') }
      }

      throw new Error(`unknown action "${action}"`)
    },
  })

  /* ─────────────────────────── HTTP surface ─────────────────────────── */

  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.replace(/^\/api\/desktop-organizer/, '').replace(/\/+$/, '') || '/'
      const method = String(req.method ?? 'GET').toUpperCase()
      const send = (status, payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      }
      try {
        if (method === 'GET' && route === '/report') return send(200, report(url.searchParams.get('force') === '1'))
        if (method === 'GET' && route === '/repair-plan') {
          const r = report(false)
          return send(200, { moves: planRepair(r, { desktopDir: cfg.desktopDir }) })
        }
        if (method === 'GET' && route === '/plan') {
          const only = url.searchParams.getAll('only').filter(Boolean)
          const r = report(false)
          return send(200, {
            report: r,
            plan: planOrganization(r, {
              includeFiles: url.searchParams.get('files') === '1',
              only: only.length > 0 ? only : undefined,
              desktopDir: cfg.desktopDir,
            }),
          })
        }
        if (method === 'POST' && route === '/apply') {
          const body = await readJson(req)
          const r = report(false)
          const plan = planOrganization(r, {
            includeFiles: body.includeFiles === true,
            only: Array.isArray(body.only) ? body.only : undefined,
            desktopDir: cfg.desktopDir,
          })
          if (body.dryRun === true) return send(200, { ok: true, dryRun: true, plan })
          const result = applyPlan(plan, { store: dataDir(ctx) })
          cache.get(true)
          return send(200, { ok: result.failures.length === 0, ...result })
        }
        if (method === 'POST' && route === '/undo') {
          // Undo whichever batch exists: a move run, or a shortcut run.
          const moveResult = undoBatch({ store: dataDir(ctx) })
          const linkResult = undoShortcuts({ store: dataDir(ctx) })
          cache.get(true)
          return send(200, {
            ok: moveResult.failures.length === 0 && linkResult.failures.length === 0,
            restored: moveResult.restored,
            removed: linkResult.removed,
            failures: [...moveResult.failures, ...linkResult.failures],
          })
        }
        if (method === 'POST' && route === '/shortcuts') {
          const body = await readJson(req)
          const r = report(false)
          const only = Array.isArray(body.only) && body.only.length > 0 ? new Set(body.only) : null
          const wanted = Array.isArray(body.apps) && body.apps.length > 0
            ? new Set(body.apps.map(a => String(a).toLowerCase()))
            : null
          const targets = (r.missingFromDesktop ?? [])
            .filter(m => (wanted ? wanted.has(m.name.toLowerCase()) : true))
            .filter(m => (only ? only.has(m.category) : true))
            .map(m => ({
              name: m.name, appId: m.appId, category: m.category,
              categoryLabel: labelOfCategory(r, m.category),
            }))
          if (body.dryRun === true) return send(200, { ok: true, dryRun: true, apps: targets })
          const result = createShortcuts(targets, { desktopDir: cfg.desktopDir, store: dataDir(ctx) })
          cache.get(true)
          return send(200, { ok: result.failures.length === 0, ...result })
        }
        if (method === 'POST' && route === '/repair') {
          const body = await readJson(req)
          const r = report(false)
          const moves = planRepair(r, { desktopDir: cfg.desktopDir })
          if (body.dryRun === true) return send(200, { ok: true, dryRun: true, moves })
          const result = applyRepair(moves, { store: dataDir(ctx) })
          cache.get(true)
          return send(200, { ok: result.failures.length === 0, ...result })
        }
        if (method === 'GET' && route === '/config') {
          return send(200, { rules: cfg.rules, folders: knownFolders(), desktopDir: cfg.desktopDir })
        }
        return send(404, { error: `no route ${method} ${route}` })
      } catch (error) {
        log.warn?.(`desktop-organizer: ${error?.message ?? error}`)
        return send(500, { error: String(error?.message ?? error) })
      }
    }
    scoped.effect(
      () => server.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'desktop-organizer: api routes',
    )
    log.info?.(`desktop-organizer: API mounted at ${API_PREFIX}`)
  })

  ctx.effect(() => () => { /* nothing persistent to release */ }, 'desktop-organizer: lifetime')
}

/* ──────────────────────────── helpers ──────────────────────────── */

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try { resolve(JSON.parse(text)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function renderReport(r) {
  const lines = []
  lines.push(`桌面整理报告 · ${r.generatedAt}`)
  lines.push('')
  lines.push(`桌面项目 ${r.summary.desktopItems}（快捷方式 ${r.summary.desktopShortcuts}）`)
  lines.push(`开始菜单快捷方式 ${r.summary.startMenuShortcuts}`)
  lines.push(`系统可启动程序 ${r.summary.launchableApps}`)
  lines.push(`未在桌面建快捷方式 ${r.summary.missingFromDesktop}`)
  lines.push(`失效快捷方式 ${r.summary.brokenShortcuts}`)
  lines.push('')
  lines.push('桌面分类：')
  for (const c of r.categories) lines.push(`  ${c.label} (${c.id}) — ${c.count} 项`)
  lines.push('')
  lines.push('未在桌面的程序（前 40）：')
  for (const m of r.missingFromDesktop.slice(0, 40)) lines.push(`  [${m.category}] ${m.name}`)
  if (r.missingFromDesktop.length > 40) lines.push(`  … 另有 ${r.missingFromDesktop.length - 40} 项`)
  if (r.brokenShortcuts.length > 0) {
    lines.push('')
    lines.push('失效快捷方式：')
    for (const b of r.brokenShortcuts) lines.push(`  ${b.name} -> ${b.target}`)
  }
  return lines.join('\n')
}

function renderPlan(plan) {
  if (plan.length === 0) return '没有需要整理的项目。'
  const lines = [`整理方案（共 ${plan.length} 项）`]
  const byCat = new Map()
  for (const p of plan) {
    if (!byCat.has(p.categoryLabel)) byCat.set(p.categoryLabel, [])
    byCat.get(p.categoryLabel).push(p)
  }
  for (const [label, items] of byCat) {
    lines.push('')
    lines.push(`→ ${label}/  (${items.length})`)
    for (const i of items) lines.push(`    ${i.name}`)
  }
  return lines.join('\n')
}

function renderApply(result) {
  const lines = [`已整理 ${result.moved.length} 项，失败 ${result.failures.length} 项。`]
  if (result.batchId) lines.push(`撤销批次：${result.batchId}`)
  for (const f of result.failures) lines.push(`  失败：${f.name} — ${f.reason}`)
  lines.push('')
  lines.push('如需还原，运行 desktop_organize action="undo"。')
  return lines.join('\n')
}

function renderUndo(result) {
  const lines = [`已还原 ${result.restored.length} 项，失败 ${result.failures.length} 项。`]
  for (const f of result.failures) lines.push(`  失败：${f.from} — ${f.reason}`)
  return lines.join('\n')
}

/** The display label for a category id, as the scan reported it. */
function labelOfCategory(report, id) {
  const hit = (report.categories ?? []).find(c => c.id === id)
    ?? (report.filed ?? []).find(c => c.id === id)
  if (hit) return hit.label
  return id === 'other' ? '' : id
}

function renderShortcutPlan(targets) {
  const lines = []
  const byCat = new Map()
  for (const t of targets) {
    const key = t.categoryLabel || '(桌面根目录)'
    if (!byCat.has(key)) byCat.set(key, [])
    byCat.get(key).push(t.name)
  }
  for (const [label, names] of byCat) {
    lines.push(`  → ${label}/  (${names.length})`)
    for (const n of names.slice(0, 30)) lines.push(`      ${n}`)
    if (names.length > 30) lines.push(`      … 另有 ${names.length - 30} 个`)
  }
  return lines.join('\n')
}

function renderShortcuts(result) {
  const lines = [`已创建 ${result.created.length} 个快捷方式，跳过 ${result.skipped.length} 个，失败 ${result.failures.length} 个。`]
  const byCat = new Map()
  for (const c of result.created) {
    const key = c.categoryLabel || '(桌面根目录)'
    if (!byCat.has(key)) byCat.set(key, [])
    byCat.get(key).push(c.name)
  }
  for (const [label, names] of byCat) lines.push(`  ${label}/ ← ${names.join('、')}`)
  for (const s of result.skipped) lines.push(`  跳过：${s.name} — ${s.reason}`)
  for (const f of result.failures) lines.push(`  失败：${f.name} — ${f.reason}`)
  lines.push('')
  lines.push('如需删除这些新快捷方式，运行 desktop_organize action="undo"。')
  return lines.join('\n')
}

export { buildReport, planOrganization, applyPlan, undoBatch, knownFolders }
export default { name, inject, apply }
