/**
 * Desktop Organizer — browser half.
 *
 * Contributes one Settings section ("桌面整理") that shows the scan result,
 * previews the move plan, and applies it. All data comes from the plugin's own
 * same-origin `/api/desktop-organizer/*` routes, which the Host half mounts on
 * the same server that serves this page.
 *
 * Hand-written ModuleLoader bundle: no build step, and the only dependency is
 * the `react` the shell already provides. Every colour is a theme token so the
 * page survives a light/dark switch.
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-desktop-organizer',
  factory: require => {
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useMemo } = React

    const API = '/api/desktop-organizer'

    const T = {
      zh: {
        nav: '桌面整理',
        title: '桌面整理',
        subtitle: '按类别归类桌面快捷方式，并找出没有在桌面建快捷方式的已安装程序。',
        refresh: '重新扫描',
        scanning: '扫描中…',
        scanFailed: '无法读取扫描结果',
        retry: '重试',
        summaryDesktop: '桌面项目',
        summaryShortcuts: '快捷方式',
        summaryMenu: '开始菜单',
        summaryApps: '可启动程序',
        summaryMissing: '未建快捷方式',
        summaryBroken: '失效快捷方式',
        tabDesktop: '桌面分类',
        tabFiled: '已归档',
        tabMissing: '未在桌面',
        tabBroken: '失效链接',
        categories: '分类',
        items: '项',
        noMissing: '所有已安装程序都已在桌面建了快捷方式。',
        noFiled: '还没有归档任何项目。',
        noBroken: '没有发现失效的快捷方式。',
        preview: '预览整理方案',
        apply: '执行整理',
        applying: '整理中…',
        undo: '撤销上次整理',
        undoing: '撤销中…',
        makeShortcuts: '为选中程序建快捷方式',
        makingShortcuts: '创建中…',
        repair: '恢复误归的分类文件夹',
        repairing: '恢复中…',
        selectAll: '全选',
        selectNone: '全不选',
        selected: '已选',
        repairFound: '发现 {n} 个分类文件夹被误归入 other/，建议先恢复。',
        includeFiles: '同时整理非快捷方式文件（文档、图片等）',
        planTitle: '整理方案',
        planEmpty: '没有需要整理的项目。',
        moves: '项移动',
        applied: '已整理',
        undone: '已还原',
        failed: '失败',
        confirm: '确定要移动这些项目吗？移动后可以用「撤销上次整理」还原。',
        loading: '加载中…',
        showAll: '显示全部',
        showLess: '收起',
        otherNote: '「其他」类默认不整理，避免形成新的杂物堆。',
      },
      en: {
        nav: 'Desktop Organizer',
        title: 'Desktop Organizer',
        subtitle: 'Group desktop shortcuts by category and find installed apps with no desktop shortcut.',
        refresh: 'Rescan',
        scanning: 'Scanning…',
        scanFailed: 'Could not read the scan result',
        retry: 'Retry',
        summaryDesktop: 'Desktop items',
        summaryShortcuts: 'Shortcuts',
        summaryMenu: 'Start menu',
        summaryApps: 'Launchable apps',
        summaryMissing: 'No shortcut',
        summaryBroken: 'Broken links',
        tabDesktop: 'By category',
        tabFiled: 'Filed',
        tabMissing: 'Not on desktop',
        tabBroken: 'Broken links',
        categories: 'categories',
        items: 'items',
        noMissing: 'Every installed app already has a desktop shortcut.',
        noFiled: 'Nothing has been filed yet.',
        noBroken: 'No broken shortcuts found.',
        preview: 'Preview plan',
        apply: 'Organize now',
        applying: 'Organizing…',
        undo: 'Undo last run',
        undoing: 'Undoing…',
        makeShortcuts: 'Create shortcuts for selected',
        makingShortcuts: 'Creating…',
        repair: 'Recover misfiled folders',
        repairing: 'Recovering…',
        selectAll: 'Select all',
        selectNone: 'Clear',
        selected: 'selected',
        repairFound: '{n} category folders are misfiled under other/ — recover them first.',
        includeFiles: 'Also file non-shortcut items (documents, images)',
        planTitle: 'Plan',
        planEmpty: 'Nothing to organize.',
        moves: 'moves',
        applied: 'Moved',
        undone: 'Restored',
        failed: 'failed',
        confirm: 'Move these items? You can revert with "Undo last run".',
        loading: 'Loading…',
        showAll: 'Show all',
        showLess: 'Show less',
        otherNote: 'The "other" bucket is left alone by default, so it does not become a new junk drawer.',
      },
    }

    const t = (locale, key) => (T[locale] ?? T.zh)[key] ?? key
    const localeTag = ctx => {
      try {
        const l = ctx?.get?.('locale')?.get?.() ?? ctx?.get?.('locale')?.locale
        return String(l ?? '').startsWith('en') ? 'en' : 'zh'
      } catch { return 'zh' }
    }

    /* ─────────────────────────── styles ─────────────────────────── */

    const S = {
      page: { padding: '20px 24px', maxWidth: 980, color: 'var(--dsw-alias-text-primary, inherit)' },
      h1: { fontSize: 18, fontWeight: 600, margin: '0 0 4px' },
      sub: { fontSize: 13, opacity: 0.7, margin: '0 0 18px', lineHeight: 1.6 },
      cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 18 },
      card: {
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))',
        borderRadius: 8, padding: '10px 12px',
      },
      cardNum: { fontSize: 20, fontWeight: 600, lineHeight: 1.2 },
      cardLabel: { fontSize: 12, opacity: 0.65, marginTop: 2 },
      tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))', marginBottom: 14 },
      tab: (on) => ({
        padding: '7px 12px', fontSize: 13, cursor: 'pointer', border: 'none', background: 'none',
        borderBottom: `2px solid ${on ? 'var(--dsw-alias-text-primary, currentColor)' : 'transparent'}`,
        color: 'inherit', opacity: on ? 1 : 0.6, fontWeight: on ? 600 : 400,
      }),
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 },
      btn: (primary) => ({
        padding: '6px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))',
        background: primary ? 'var(--dsw-alias-bg-accent, #247bbf)' : 'transparent',
        color: primary ? '#fff' : 'inherit',
        opacity: 1,
      }),
      group: { marginBottom: 16 },
      groupHead: { fontSize: 13, fontWeight: 600, marginBottom: 6 },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: {
        fontSize: 12, padding: '3px 9px', borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))',
        opacity: 0.9,
      },
      chipBroken: { textDecoration: 'line-through', opacity: 0.55 },
      list: { display: 'flex', flexDirection: 'column', gap: 4 },
      listRow: { fontSize: 13, display: 'flex', gap: 8, alignItems: 'baseline' },
      tag: { fontSize: 11, opacity: 0.55, minWidth: 74 },
      note: { fontSize: 12, opacity: 0.6, marginTop: 10, lineHeight: 1.6 },
      result: { fontSize: 13, padding: '8px 12px', borderRadius: 6, marginBottom: 12, border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 },
      label: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, opacity: 0.85 },
      banner: {
        fontSize: 13, padding: '10px 12px', borderRadius: 6, marginBottom: 14,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.4))',
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      },
      pick: { fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' },
      pickBox: { margin: 0 },
      scroll: { maxHeight: 320, overflowY: 'auto', paddingRight: 4 },
    }

    /* ─────────────────────────── data ─────────────────────────── */

    async function getJson(url) {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return res.json()
    }
    async function postJson(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`)
      return data
    }

    /* ─────────────────────────── page ─────────────────────────── */

    function DesktopOrganizerPage(props) {
      const locale = localeTag(props.ctx)
      const tr = useCallback(k => t(locale, k), [locale])
      const [report, setReport] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState('')
      const [tab, setTab] = useState('desktop')
      const [plan, setPlan] = useState(null)
      const [includeFiles, setIncludeFiles] = useState(false)
      const [outcome, setOutcome] = useState(null)
      const [showAllMissing, setShowAllMissing] = useState(false)
      const [selected, setSelected] = useState(() => new Set())
      const [repairMoves, setRepairMoves] = useState(null)

      const load = useCallback(async (force) => {
        setBusy('scan'); setError(null)
        try {
          const data = await getJson(`${API}/report${force ? '?force=1' : ''}`)
          setReport(data)
          // Surface misfiled category folders so the user can fix them first.
          try {
            const rp = await getJson(`${API}/repair-plan`)
            setRepairMoves((rp.moves ?? []).length > 0 ? rp.moves : null)
          } catch { setRepairMoves(null) }
        } catch (e) {
          setError(String(e.message ?? e))
        } finally { setBusy('') }
      }, [])

      useEffect(() => { load(false) }, [load])

      const doPreview = useCallback(async () => {
        setBusy('plan'); setOutcome(null)
        try {
          const data = await getJson(`${API}/plan${includeFiles ? '?files=1' : ''}`)
          setReport(data.report)
          setPlan(data.plan)
        } catch (e) { setOutcome({ kind: 'error', text: String(e.message ?? e) }) }
        finally { setBusy('') }
      }, [includeFiles])

      const doApply = useCallback(async () => {
        if (!window.confirm(tr('confirm'))) return
        setBusy('apply'); setOutcome(null)
        try {
          const data = await postJson(`${API}/apply`, { includeFiles })
          setOutcome({ kind: 'ok', text: `${tr('applied')} ${data.moved?.length ?? 0}，${tr('failed')} ${data.failures?.length ?? 0}` })
          setPlan(null)
          await load(true)
        } catch (e) { setOutcome({ kind: 'error', text: String(e.message ?? e) }) }
        finally { setBusy('') }
      }, [includeFiles, load, tr])

      const doUndo = useCallback(async () => {
        setBusy('undo'); setOutcome(null)
        try {
          const data = await postJson(`${API}/undo`, {})
          const n = (data.restored?.length ?? 0) + (data.removed?.length ?? 0)
          setOutcome({ kind: 'ok', text: `${tr('undone')} ${n}，${tr('failed')} ${data.failures?.length ?? 0}` })
          setPlan(null)
          await load(true)
        } catch (e) { setOutcome({ kind: 'error', text: String(e.message ?? e) }) }
        finally { setBusy('') }
      }, [load, tr])

      const doRepair = useCallback(async () => {
        setBusy('repair'); setOutcome(null)
        try {
          const data = await postJson(`${API}/repair`, {})
          setOutcome({ kind: 'ok', text: `${tr('repair')} → ${data.repaired?.length ?? 0}` })
          setRepairMoves(null)
          await load(true)
        } catch (e) { setOutcome({ kind: 'error', text: String(e.message ?? e) }) }
        finally { setBusy('') }
      }, [load, tr])

      const doShortcuts = useCallback(async () => {
        const apps = [...selected]
        if (apps.length === 0) return
        setBusy('shortcuts'); setOutcome(null)
        try {
          const data = await postJson(`${API}/shortcuts`, { apps })
          setOutcome({
            kind: 'ok',
            text: `${tr('makeShortcuts')} → ${data.created?.length ?? 0}，${tr('failed')} ${data.failures?.length ?? 0}`,
          })
          setSelected(new Set())
          await load(true)
        } catch (e) { setOutcome({ kind: 'error', text: String(e.message ?? e) }) }
        finally { setBusy('') }
      }, [selected, load, tr])

      const toggle = useCallback((name) => {
        setSelected(prev => {
          const next = new Set(prev)
          if (next.has(name)) next.delete(name); else next.add(name)
          return next
        })
      }, [])

      const s = report?.summary
      const missing = useMemo(() => report?.missingFromDesktop ?? [], [report])
      const shownMissing = showAllMissing ? missing : missing.slice(0, 80)
      const filed = report?.filed ?? []

      if (error) {
        return h('div', { style: S.page },
          h('div', { style: S.h1 }, tr('title')),
          h('div', { style: S.result }, `${tr('scanFailed')}: ${error}`),
          h('button', { style: S.btn(true), onClick: () => load(true) }, tr('retry')))
      }
      if (!report) {
        return h('div', { style: S.page }, h('div', { style: S.sub }, `${tr('loading')}`))
      }

      const cards = [
        [s.desktopItems, tr('summaryDesktop')],
        [s.desktopShortcuts, tr('summaryShortcuts')],
        [s.filedItems ?? 0, tr('tabFiled')],
        [s.launchableApps, tr('summaryApps')],
        [s.missingFromDesktop, tr('summaryMissing')],
        [s.brokenShortcuts, tr('summaryBroken')],
      ]

      return h('div', { style: S.page },
        h('div', { style: S.h1 }, tr('title')),
        h('div', { style: S.sub }, tr('subtitle')),

        h('div', { style: S.cards }, cards.map(([n, l], i) =>
          h('div', { key: i, style: S.card },
            h('div', { style: S.cardNum }, String(n)),
            h('div', { style: S.cardLabel }, l)))),

        repairMoves && h('div', { style: S.banner },
          h('span', null, tr('repairFound').replace('{n}', String(repairMoves.length))),
          h('button', { style: S.btn(true), disabled: busy !== '', onClick: doRepair },
            busy === 'repair' ? tr('repairing') : tr('repair'))),

        h('div', { style: S.row },
          h('button', { style: S.btn(false), disabled: busy !== '', onClick: () => load(true) },
            busy === 'scan' ? tr('scanning') : tr('refresh')),
          h('button', { style: S.btn(false), disabled: busy !== '', onClick: doPreview },
            busy === 'plan' ? tr('scanning') : tr('preview')),
          h('button', { style: S.btn(true), disabled: busy !== '', onClick: doApply },
            busy === 'apply' ? tr('applying') : tr('apply')),
          h('button', { style: S.btn(false), disabled: busy !== '', onClick: doUndo },
            busy === 'undo' ? tr('undoing') : tr('undo'))),

        h('label', { style: S.label },
          h('input', {
            type: 'checkbox', checked: includeFiles,
            onChange: e => setIncludeFiles(e.target.checked),
          }),
          tr('includeFiles')),

        outcome && h('div', { style: { ...S.result, opacity: outcome.kind === 'error' ? 0.9 : 1 } },
          outcome.text),

        plan && h('div', { style: S.group },
          h('div', { style: S.groupHead }, `${tr('planTitle')} — ${plan.length} ${tr('moves')}`),
          plan.length === 0
            ? h('div', { style: S.sub }, tr('planEmpty'))
            : h('div', { style: S.list }, plan.slice(0, 200).map((p, i) =>
                h('div', { key: i, style: S.listRow },
                  h('span', { style: S.tag }, p.categoryLabel),
                  h('span', null, p.name))))),

        h('div', { style: S.tabs },
          [['desktop', tr('tabDesktop')], ['filed', tr('tabFiled')],
           ['missing', tr('tabMissing')], ['broken', tr('tabBroken')]]
            .map(([id, label]) => h('button', {
              key: id, style: S.tab(tab === id), onClick: () => setTab(id),
            }, label))),

        tab === 'desktop' && h('div', null,
          report.categories.length === 0
            ? h('div', { style: S.sub }, tr('planEmpty'))
            : report.categories.map(c => h('div', { key: c.id, style: S.group },
                h('div', { style: S.groupHead }, `${c.label} · ${c.count} ${tr('items')}`),
                h('div', { style: S.chips }, c.items.map((it, i) =>
                  h('span', {
                    key: i,
                    style: it.broken ? { ...S.chip, ...S.chipBroken } : S.chip,
                    title: it.target || it.path,
                  }, it.name))))) ),

        tab === 'filed' && h('div', null,
          filed.length === 0
            ? h('div', { style: S.sub }, tr('noFiled'))
            : filed.map(c => h('div', { key: c.id, style: S.group },
                h('div', { style: S.groupHead }, `${c.label} · ${c.count} ${tr('items')}`),
                h('div', { style: S.chips }, c.items.map((it, i) =>
                  h('span', {
                    key: i,
                    style: it.broken ? { ...S.chip, ...S.chipBroken } : S.chip,
                    title: it.path,
                  }, it.name))))) ),

        tab === 'missing' && h('div', null,
          missing.length === 0
            ? h('div', { style: S.sub }, tr('noMissing'))
            : h('div', null,
                h('div', { style: S.row },
                  h('button', {
                    style: S.btn(false),
                    onClick: () => setSelected(new Set(missing.map(m => m.name))),
                  }, tr('selectAll')),
                  h('button', { style: S.btn(false), onClick: () => setSelected(new Set()) }, tr('selectNone')),
                  h('button', {
                    style: S.btn(true), disabled: busy !== '' || selected.size === 0, onClick: doShortcuts,
                  }, busy === 'shortcuts' ? tr('makingShortcuts') : `${tr('makeShortcuts')} (${selected.size})`)),
                h('div', { style: S.scroll }, shownMissing.map((m, i) =>
                  h('label', { key: i, style: S.pick },
                    h('input', {
                      type: 'checkbox', style: S.pickBox,
                      checked: selected.has(m.name),
                      onChange: () => toggle(m.name),
                    }),
                    h('span', { style: S.tag }, m.category),
                    h('span', null, m.name)))),
                missing.length > shownMissing.length && h('button', {
                  style: { ...S.btn(false), marginTop: 10 }, onClick: () => setShowAllMissing(true),
                }, `${tr('showAll')} (${missing.length})`))),

        tab === 'broken' && h('div', null,
          (report.brokenShortcuts ?? []).length === 0
            ? h('div', { style: S.sub }, tr('noBroken'))
            : h('div', { style: S.list }, report.brokenShortcuts.map((b, i) =>
                h('div', { key: i, style: S.listRow },
                  h('span', null, b.name),
                  h('span', { style: { ...S.tag, minWidth: 0 } }, b.target))))),

        h('div', { style: S.note }, tr('otherNote')))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'desktop-organizer',
          order: 60,
          label: () => t(localeTag(ctx), 'nav'),
        }, props => h(DesktopOrganizerPage, { ...props, ctx })))
      },
    }
  },
})
