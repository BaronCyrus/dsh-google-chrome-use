/**
 * The plugin's page under Settings, loaded into DSH's web client. There is no
 * build step: this file is already in the form DSH expects of a `dsh.client`
 * bundle, and it uses React without JSX.
 */

window.__ModuleLoader__.load({
  id: 'dsh-google-chrome-use',
  factory: (require) => {
    const { createElement: h, useEffect, useMemo, useRef, useState } = require('react')

    const CHANNEL = '/chrome-use'
    const NS = 'settings.chromeUse'

    const zh = {
      nav: 'Chrome Use',
      versionTitle: '插件版本',
      check: '检查更新',
      checking: '正在检查更新…',
      readFailed: '无法读取插件版本，请重新打开设置页。',
      latestUnknown: '暂时查不到最新版本，请检查网络后重试',
      upToDate: '已是最新版本',
      available: '发现新版本 v{version}',
      running: '正在运行的版本',
      restart: '已安装 v{version}。完全退出并重新打开 DSH 后生效，只刷新页面不会重新加载插件。',
      linked: '当前是本地开发安装，代码直接来自本地目录，不能在这里更新。',
      manual: '无法在这里更新。请到插件页卸载，再带上版本号重新安装 dsh-google-chrome-use。',
      update: '更新插件',
      updating: '正在更新…',
      updateFailed: '更新失败，请重试，或到插件页卸载后重新安装。',
      syncing: 'v{version} 刚发布不久，安装源还没有同步到这个版本。请过几分钟再更新；国内镜像可能要等更久。',
      syncingFrom: 'v{version} 刚发布不久，安装源 {registry} 还没有同步到这个版本。请过几分钟再更新；国内镜像可能要等更久。',
      unreachable: '连不上安装源，没能下载 v{version}。请检查网络或代理后重试。',
      unreachableFrom: '连不上安装源 {registry}，没能下载 v{version}。请检查网络或代理后重试。',
      cooling: 'v{version} 发布不久，DSH 的 pnpm 要等新版本过了发布冷却期才会安装，请稍后再更新。',
      coolingUntil: 'v{version} 发布不久，DSH 的 pnpm 要等新版本过了发布冷却期才会安装，{time} 之后可以更新。',
    }

    const en = {
      nav: 'Chrome Use',
      versionTitle: 'Plugin version',
      check: 'Check for updates',
      checking: 'Checking for updates…',
      readFailed: 'Could not read the plugin version. Reopen this page.',
      latestUnknown: 'Could not find the latest version. Check your network and try again',
      upToDate: 'Up to date',
      available: 'v{version} is available',
      running: 'Running now',
      restart: 'v{version} is installed. Quit and reopen DSH to use it; reloading the page does not reload the plugin.',
      linked: 'Installed from a local checkout, so the code comes straight from that directory and cannot be updated here.',
      manual: 'This install cannot be updated here. Remove it on the Plugins page, then install dsh-google-chrome-use again with a version number.',
      update: 'Update plugin',
      updating: 'Updating…',
      updateFailed: 'The update failed. Try again, or remove the plugin on the Plugins page and install it again.',
      syncing: 'v{version} was just released, and the install source does not have it yet. Update again in a few minutes; mirrors can take longer.',
      syncingFrom: 'v{version} was just released, and the install source {registry} does not have it yet. Update again in a few minutes; mirrors can take longer.',
      unreachable: 'Could not reach the install source to download v{version}. Check your network or proxy and try again.',
      unreachableFrom: 'Could not reach the install source {registry} to download v{version}. Check your network or proxy and try again.',
      cooling: 'v{version} is new, and DSH\'s pnpm holds new versions back until their release cooldown ends. Update again later.',
      coolingUntil: 'v{version} is new, and DSH\'s pnpm holds new versions back until their release cooldown ends. You can update after {time}.',
    }

    // Only DSH's design tokens, so the page follows the theme and matches the host's own settings pages.
    const STYLE = `
.cu{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.cu-card{display:flex;flex-direction:column;gap:14px;padding:16px 18px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4,rgba(127,127,127,.3)));border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2))}
.cu-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px}
.cu-title{margin:0;font-size:15px;font-weight:600;line-height:22px}
.cu-actions{display:flex;flex-wrap:wrap;gap:4px}
.cu-status{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;font-size:13px}
.cu-status>b{font-weight:600;font-variant-numeric:tabular-nums}
.cu-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cu-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.cu-dot[data-tone=success]{background:var(--dsw-alias-state-success-primary)}
.cu-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}
.cu-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cu-error{margin:0;color:var(--dsw-alias-state-error-primary,#ec1313);font-size:12px;line-height:18px}
.cu-callout{margin:0;padding:12px 14px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-state-business-tertiary);font-size:13px;line-height:20px}
.cu-btn{box-sizing:border-box;display:inline-flex;flex:none;align-items:center;justify-content:center;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.cu-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cu-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.cu-btn:disabled{opacity:.4;cursor:not-allowed}
.cu-btn[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.cu-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
`

    const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (_match, name) => String(values[name]))

    const channelCaller = rpc => (endpoint, payload = {}) => rpc.call(CHANNEL, endpoint, payload).then((response) => {
      if (!response?.ok) throw new Error(response?.error?.message ?? 'Chrome Use request failed')
      return response.value
    })

    /** What to say about an update that installed nothing: a wait, or a failure. */
    function describeOutcome(outcome, t) {
      const values = { ...outcome, time: new Date(outcome.availableAt ?? 0).toLocaleString() }
      if (outcome.pending === true) {
        return { tone: 'note', text: fill(t(typeof outcome.availableAt === 'number' ? 'coolingUntil' : 'cooling'), values) }
      }
      const key = typeof outcome.registry === 'string' ? `${outcome.failed}From` : outcome.failed
      return { tone: outcome.failed === 'syncing' ? 'note' : 'error', text: fill(t(key), values) }
    }

    function Button({ variant, ...rest }) {
      return h('button', { type: 'button', className: 'cu-btn', 'data-variant': variant, ...rest })
    }

    function VersionCard({ call, t }) {
      const [info, setInfo] = useState()
      const [loading, setLoading] = useState(true)
      const [readFailed, setReadFailed] = useState(false)
      const [updating, setUpdating] = useState(false)
      const [notice, setNotice] = useState()
      const generation = useRef(0)

      const load = () => {
        const current = ++generation.current
        setLoading(true)
        setReadFailed(false)
        call('plugin/version').then((value) => {
          if (generation.current === current) setInfo(value)
        }).catch(() => {
          if (generation.current === current) setReadFailed(true)
        }).finally(() => {
          if (generation.current === current) setLoading(false)
        })
      }

      useEffect(() => {
        load()
        return () => { generation.current += 1 }
      }, [])

      const update = () => {
        setUpdating(true)
        setNotice(undefined)
        call('plugin/update').then((outcome) => {
          if (outcome.pending === true || outcome.failed !== undefined) setNotice(describeOutcome(outcome, t))
          else load()
        }).catch(() => {
          setNotice({ tone: 'error', text: t('updateFailed') })
        }).finally(() => setUpdating(false))
      }

      const kind = info?.install?.kind
      const canUpdate = info?.updateAvailable === true && kind === 'npm'
      const describeStatus = () => {
        if (info.updateAvailable) return fill(t('available'), { version: info.latest })
        if (info.restartNeeded) return t('running')
        return info.latest === undefined ? t('latestUnknown') : t('upToDate')
      }
      return h('section', { className: 'cu-card' },
        h('header', { className: 'cu-head' },
          h('h3', { className: 'cu-title' }, t('versionTitle')),
          h('span', { className: 'cu-actions' },
            canUpdate && h(Button, { variant: 'primary', disabled: updating, onClick: update }, t(updating ? 'updating' : 'update')),
            h(Button, { disabled: loading || updating, onClick: load }, t(loading ? 'checking' : 'check')))),
        loading && info === undefined && h('p', { className: 'cu-note', role: 'status' }, t('checking')),
        readFailed && h('p', { className: 'cu-error', role: 'alert' }, t('readFailed')),
        info !== undefined && h('div', { className: 'cu-status', role: 'status' },
          h('span', { className: 'cu-dot', 'data-tone': describeStatus() === t('upToDate') ? 'success' : 'warn' }),
          h('b', null, `v${info.current}`),
          h('span', { className: 'cu-meta' }, describeStatus())),
        info?.restartNeeded === true && h('p', { className: 'cu-callout', role: 'status' }, fill(t('restart'), { version: info.installed })),
        kind === 'link' && h('p', { className: 'cu-note' }, t('linked')),
        kind === 'unknown' && info.updateAvailable && h('p', { className: 'cu-note' }, t('manual')),
        notice !== undefined && h('p', {
          className: notice.tone === 'error' ? 'cu-error' : 'cu-note',
          role: notice.tone === 'error' ? 'alert' : 'status',
        }, notice.text))
    }

    function ChromeUseSection({ rpc, t }) {
      const call = useMemo(() => channelCaller(rpc), [rpc])
      return h('div', { className: 'cu' }, h(VersionCard, { call, t }))
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'chrome-use: copy')
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-google-chrome-use'
          tag.textContent = STYLE
          document.head.append(tag)
          return () => tag.remove()
        }, 'chrome-use: style')
        const connection = ctx.get('connection')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'chrome-use',
          order: 18,
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ rpc: connection.rpc, t }),
        }, ChromeUseSection))
      },
    }
  },
})
