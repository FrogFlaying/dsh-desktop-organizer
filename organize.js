/**
 * Desktop Organizer — move planning, execution, and undo.
 *
 * Safety rules this module enforces, because a desktop organizer that gets this
 * wrong destroys user data:
 *   - Only ever MOVE items that are directly inside the desktop directory.
 *     Nothing is deleted, and no file is touched outside the desktop.
 *   - `desktop.ini` and other shell-owned files are never candidates.
 *   - The desktop root's own subdirectories are not descended into; only
 *     top-level entries are reorganized, so a user's existing folders keep
 *     their contents.
 *   - Every apply writes a full undo snapshot BEFORE the first move, so a
 *     crash mid-way is still reversible.
 *   - A name collision is resolved by suffixing, never by overwriting.
 *
 * @module organize.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { isCategoryFolderName } from './scan.js'

/** Shell-owned or transient files that must never be moved. */
const NEVER_MOVE = new Set([
  'desktop.ini', 'thumbs.db', '.ds_store', 'iconcache.db',
])

/** Files an office suite leaves behind while a document is open. */
const TEMP_PREFIXES = ['~$']

function isProtected(name) {
  const lower = name.toLowerCase()
  if (NEVER_MOVE.has(lower)) return true
  return TEMP_PREFIXES.some(p => name.startsWith(p))
}

/**
 * Compute the move plan for a report.
 *
 * @param report      output of `buildReport()`
 * @param options.includeFiles   also file non-shortcut items (default false)
 * @param options.includeFolders also move user folders (default FALSE)
 * @param options.only           restrict to these category ids
 * @param options.desktopDir     the desktop root; nothing outside it is touched
 * @returns array of { name, from, to, category, categoryLabel }
 */
export function planOrganization(report, options = {}) {
  const desktopDir = path.resolve(options.desktopDir ?? report.folders?.desktop ?? '')
  const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only) : null
  const includeFiles = options.includeFiles === true
  // Directories are never moved unless explicitly requested. Filing a user's own
  // folder into a category bucket is how the previous release buried data.
  const includeFolders = options.includeFolders === true
  const plan = []

  for (const category of report.categories ?? []) {
    if (only && !only.has(category.id)) continue
    // `other` is the catch-all: filing it would create a junk drawer, which is
    // exactly what the user is trying to escape. Only file it on request.
    if (category.id === 'other' && !includeFiles) continue

    for (const item of category.items ?? []) {
      if (isProtected(item.name)) continue
      // Never move a folder this organizer itself created. Without this guard
      // the category folders migrate into themselves, which is how a previous
      // run ended up burying every category under `other/`.
      const isOwnFolder = item.isDir && (
        isCategoryFolderName(item.name, report._compiled ?? []) ||
        item.name.trim().toLowerCase() === 'other'
      )
      if (isOwnFolder) continue
      // User folders stay put unless explicitly opted in.
      if (item.isDir && !includeFolders) continue
      if (!item.isDir && item.name.toLowerCase().endsWith('.lnk') === false && !includeFiles) continue

      const from = path.resolve(item.path)
      // Refuse anything that is not a direct child of the desktop root.
      if (path.dirname(from).toLowerCase() !== desktopDir.toLowerCase()) continue
      const to = path.join(desktopDir, category.label, item.name)
      // Refuse a move that would nest an item inside itself.
      if (path.resolve(to).toLowerCase().startsWith(from.toLowerCase() + path.sep)) continue
      if (path.resolve(to).toLowerCase() === from.toLowerCase()) continue

      plan.push({
        name: item.name,
        from,
        to,
        category: category.id,
        categoryLabel: category.label,
      })
    }
  }
  return plan
}

/** Pick a destination name that does not collide with an existing entry. */
function freeName(dir, name) {
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  let candidate = name
  let n = 1
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${n})${ext}`
    n++
    if (n > 999) throw new Error(`cannot find a free name for ${name}`)
  }
  return candidate
}

function batchId() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `batch-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * Execute a plan. Writes the undo snapshot first, then moves each item.
 *
 * A per-item failure is recorded and the remaining items still run: one locked
 * file should not abort a 30-item tidy-up.
 */
export function applyPlan(plan, options = {}) {
  const store = options.store
  const moved = []
  const failures = []
  const id = batchId()

  if (plan.length === 0) return { batchId: id, moved, failures }

  if (store) {
    fs.mkdirSync(store, { recursive: true })
    // Snapshot BEFORE the first move, so a crash is still recoverable.
    fs.writeFileSync(
      path.join(store, 'undo-latest.json'),
      JSON.stringify({ batchId: id, at: new Date().toISOString(), items: plan.map(p => ({ from: p.from, to: p.to })) }, null, 2),
      'utf8',
    )
  }

  for (const item of plan) {
    try {
      if (!fs.existsSync(item.from)) { failures.push({ name: item.name, reason: '源文件已不存在' }); continue }
      const dir = path.dirname(item.to)
      fs.mkdirSync(dir, { recursive: true })
      const finalName = freeName(dir, path.basename(item.to))
      const finalTo = path.join(dir, finalName)
      fs.renameSync(item.from, finalTo)
      moved.push({ name: item.name, from: item.from, to: finalTo, category: item.category })
    } catch (error) {
      failures.push({ name: item.name, reason: String(error?.message ?? error) })
    }
  }

  if (store && moved.length > 0) {
    fs.writeFileSync(
      path.join(store, 'undo-latest.json'),
      JSON.stringify({ batchId: id, at: new Date().toISOString(), items: moved.map(m => ({ from: m.from, to: m.to })) }, null, 2),
      'utf8',
    )
  }

  return { batchId: id, moved, failures }
}

/** Reverse the most recent apply, then prune the category folders it created. */
export function undoBatch(options = {}) {
  const store = options.store
  const restored = []
  const failures = []
  if (!store) return { restored, failures }

  const snapshotPath = path.join(store, 'undo-latest.json')
  if (!fs.existsSync(snapshotPath)) return { restored, failures: [{ from: '(none)', reason: '没有可撤销的记录' }] }

  let snapshot
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  } catch (error) {
    return { restored, failures: [{ from: snapshotPath, reason: `快照损坏：${error.message}` }] }
  }

  // Reverse order so nested names unwind cleanly.
  for (const item of [...(snapshot.items ?? [])].reverse()) {
    try {
      if (!fs.existsSync(item.to)) { failures.push({ from: item.to, reason: '已被移动或删除' }); continue }
      const dir = path.dirname(item.from)
      fs.mkdirSync(dir, { recursive: true })
      const finalName = freeName(dir, path.basename(item.from))
      fs.renameSync(item.to, path.join(dir, finalName))
      restored.push({ from: item.to, to: path.join(dir, finalName) })
    } catch (error) {
      failures.push({ from: item.to, reason: String(error?.message ?? error) })
    }
  }

  // Remove category folders the apply created, but only while they are empty —
  // a folder the user has since put something into is left alone.
  const pruned = []
  const created = new Set((snapshot.items ?? []).map(i => path.dirname(i.to)))
  for (const dir of created) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir)
        pruned.push(dir)
      }
    } catch { /* a folder in use stays */ }
  }

  if (failures.length === 0) {
    try { fs.unlinkSync(snapshotPath) } catch { /* best effort */ }
  }
  return { restored, failures, pruned }
}
