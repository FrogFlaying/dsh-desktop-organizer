/**
 * Desktop Organizer — create desktop shortcuts for installed apps that have none.
 *
 * Why this shells out to PowerShell: a Store/MSIX app has no real `.exe` path.
 * It is identified only by an AppsFolder id such as `WorkBuddy.WorkBuddy`, and
 * the only supported way to make a launchable shortcut for one is
 * `explorer.exe shell:AppsFolder\<id>`. Verified working on Windows 10 22H2.
 *
 * Safety rules:
 *   - Never overwrite: an existing file at the destination gets a suffixed name.
 *   - Only writes inside the desktop root (or a category folder under it).
 *   - Every created shortcut is recorded so the batch can be undone.
 *
 * @module shortcuts.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { powershellJson } from './scan.js'

/** Characters Windows forbids in a file name. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g

/** Turn an app display name into a safe `.lnk` file name. */
export function safeLinkName(name) {
  const cleaned = String(name ?? '')
    .replace(ILLEGAL, '_')
    .replace(/[. ]+$/, '')
    .trim()
  return `${cleaned === '' ? 'App' : cleaned}.lnk`
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

/**
 * Decide how a shortcut should launch an app.
 *
 * Two kinds of AppsFolder entry exist and they need different treatment:
 *   - a real filesystem path (classic Win32 app) -> point TargetPath at the exe
 *   - a packaged/MSIX id like `WorkBuddy.WorkBuddy` -> explorer.exe plus
 *     `shell:AppsFolder\<id>`, because the app has no TargetPath of its own
 *
 * @returns { kind: 'exe'|'appsFolder', targetPath, args }
 */
export function launchSpec(appId) {
  const id = String(appId ?? '').trim()
  const looksLikePath = /^[a-zA-Z]:[\\/]/.test(id) || id.startsWith('\\\\')
  if (looksLikePath && fs.existsSync(id)) {
    return { kind: 'exe', targetPath: id, args: '' }
  }
  return { kind: 'appsFolder', targetPath: '', args: `shell:AppsFolder\\${id}` }
}

/**
 * Create shortcuts for a list of apps.
 *
 * @param apps    [{ name, appId, categoryLabel }]
 * @param options.desktopDir   desktop root; nothing outside it is written
 * @param options.store        directory for the undo record
 * @returns { created, skipped, failures }
 */
export function createShortcuts(apps, options = {}) {
  const desktopDir = path.resolve(options.desktopDir ?? '')
  const store = options.store
  const created = []
  const skipped = []
  const failures = []

  if (apps.length === 0) return { created, skipped, failures }

  // Work out final destinations first, so the PowerShell batch needs no logic.
  const jobs = []
  for (const app of apps) {
    try {
      if (!app.appId) { skipped.push({ name: app.name, reason: '没有可用的启动标识' }); continue }
      const dir = app.categoryLabel ? path.join(desktopDir, app.categoryLabel) : desktopDir
      // Refuse to write outside the desktop root.
      if (!path.resolve(dir).toLowerCase().startsWith(desktopDir.toLowerCase())) {
        skipped.push({ name: app.name, reason: '目标目录不在桌面内' }); continue
      }
      fs.mkdirSync(dir, { recursive: true })
      const finalName = freeName(dir, safeLinkName(app.name))
      const spec = launchSpec(app.appId)
      jobs.push({ app, dir, finalName, to: path.join(dir, finalName), spec })
    } catch (error) {
      failures.push({ name: app.name, reason: String(error?.message ?? error) })
    }
  }
  if (jobs.length === 0) return { created, skipped, failures }

  // One PowerShell process for the whole batch.
  const tmp = path.join(os.tmpdir(), `dsh-do-mklnk-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(tmp, JSON.stringify(jobs.map(j => ({
    to: j.to,
    appId: j.app.appId,
    name: j.app.name,
    kind: j.spec.kind,
    targetPath: j.spec.targetPath,
    args: j.spec.args,
  }))), 'utf8')
  const script = `
$jobs = Get-Content -Raw -LiteralPath '${tmp.replace(/'/g, "''")}' -Encoding UTF8 | ConvertFrom-Json
$sh = New-Object -ComObject WScript.Shell
$shell = New-Object -ComObject Shell.Application
$appsFolder = $shell.NameSpace('shell:AppsFolder')
$rows = @()
foreach ($j in @($jobs)) {
  try {
    $lnk = $sh.CreateShortcut([string]$j.to)
    if ([string]$j.kind -eq 'exe') {
      # A classic Win32 app: point straight at the executable.
      $lnk.TargetPath = [string]$j.targetPath
      $lnk.Arguments = ''
      $lnk.IconLocation = [string]$j.targetPath + ',0'
    } else {
      # A packaged/MSIX app has no TargetPath, so it is launched through the
      # shell namespace: explorer.exe + shell:AppsFolder\\<id>.
      $lnk.TargetPath = "$env:windir\\explorer.exe"
      $lnk.Arguments = [string]$j.args
      $lnk.IconLocation = "$env:windir\\explorer.exe,0"
    }
    $lnk.Description = [string]$j.name
    $lnk.Save()
    $rows += [pscustomobject]@{ to = [string]$j.to; ok = $true }
  } catch {
    $rows += [pscustomobject]@{ to = [string]$j.to; ok = $false; err = $_.Exception.Message }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 3
`
  let results
  try {
    results = powershellJson(script)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* best effort */ }
    for (const j of jobs) failures.push({ name: j.app.name, reason: `快捷方式创建失败：${error.message}` })
    return { created, skipped, failures }
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* best effort */ }
  }

  const byPath = new Map((Array.isArray(results) ? results : []).map(r => [r.to, r]))
  for (const j of jobs) {
    const r = byPath.get(j.to)
    if (r?.ok === true && fs.existsSync(j.to)) {
      created.push({
        name: j.app.name,
        to: j.to,
        appId: j.app.appId,
        category: j.app.category,
        categoryLabel: j.app.categoryLabel ?? '',
      })
    } else {
      failures.push({ name: j.app.name, reason: r?.err ?? '创建后文件不存在' })
    }
  }

  if (store && created.length > 0) {
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(
      path.join(store, 'undo-shortcuts.json'),
      JSON.stringify({ at: new Date().toISOString(), items: created.map(c => ({ to: c.to, name: c.name })) }, null, 2),
      'utf8',
    )
  }

  return { created, skipped, failures }
}

/** Delete the shortcuts created by the most recent `createShortcuts` batch. */
export function undoShortcuts(options = {}) {
  const store = options.store
  const removed = []
  const failures = []
  if (!store) return { removed, failures }
  const record = path.join(store, 'undo-shortcuts.json')
  if (!fs.existsSync(record)) return { removed, failures: [{ name: '(none)', reason: '没有可撤销的快捷方式记录' }] }

  let snapshot
  try { snapshot = JSON.parse(fs.readFileSync(record, 'utf8')) }
  catch (error) { return { removed, failures: [{ name: record, reason: `记录损坏：${error.message}` }] } }

  for (const item of snapshot.items ?? []) {
    try {
      if (!fs.existsSync(item.to)) { failures.push({ name: item.name, reason: '文件已不存在' }); continue }
      fs.unlinkSync(item.to)
      removed.push({ name: item.name, to: item.to })
    } catch (error) {
      failures.push({ name: item.name, reason: String(error?.message ?? error) })
    }
  }
  if (failures.length === 0) {
    try { fs.unlinkSync(record) } catch { /* best effort */ }
  }
  return { removed, failures }
}
