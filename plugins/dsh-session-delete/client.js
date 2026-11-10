/**
 * dsh-session-delete — Client 半边。
 *
 * 往官方会话右键菜单（会话行 ⋮ 菜单）里加一条「删除会话」，位置在「归档会话」之后，
 * 走的是与内置「重命名 / 归档」完全相同的菜单贡献 API（ctx.contextMenus.register），
 * 因此外观、关闭行为、键盘可访问性都与内置项一致。
 *
 * 真正删文件在 Host 半边：POST /api-ext/session.delete。
 * 会话正在跑一轮、或该对话正在主视图打开时，菜单项为禁用（带原因文案）。
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-delete',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const h = react.createElement

		const NS = 'sessionDelete'
		const ROUTE = '/api-ext/session.delete'
		const ICON_KEY = 'session-delete.trash'

		/**
		 * 菜单里的垃圾桶图标：16×16、currentColor 描边，
		 * 跟内置菜单图标同一套视觉权重（归档/重命名也是线性图标）。
		 */
		function TrashIcon() {
			return h('svg', {
				viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true,
				fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
				strokeLinecap: 'round', strokeLinejoin: 'round',
			},
			h('path', { d: 'M2.6 4.3h10.8' }),
			h('path', { d: 'M6.4 4.3V2.9a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.4' }),
			h('path', { d: 'M4.1 4.3l.7 8.4a1.2 1.2 0 0 0 1.2 1.1h4a1.2 1.2 0 0 0 1.2-1.1l.7-8.4' }),
			h('path', { d: 'M6.7 6.9v4.2M9.3 6.9v4.2' }))
		}

		const dicts = {
			zh: {
				'menu.delete': '删除会话',
				'menu.running': '删除会话（正在运行）',
				'menu.open': '删除会话（对话已打开）',
				'confirm': '永久删除「{title}」？\n\n会话日志、工作区成员关系与内存条目都会被移除，且无法恢复。',
				'failed': '删除会话失败：',
				'offline': '宿主拒绝删除：',
			},
			en: {
				'menu.delete': 'Delete session',
				'menu.running': 'Delete session (running)',
				'menu.open': 'Delete session (open in main view)',
				'confirm': 'Delete "{title}" permanently?\n\nIts log, workspace membership, and in-memory entry are removed. This cannot be undone.',
				'failed': 'Deleting the session failed: ',
				'offline': 'The host refused the delete: ',
			},
		}

		/** POST the Host route; resolves with the host's value or throws with its reason. */
		async function requestDelete(sessionId) {
			const response = await fetch(ROUTE, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ sessionId }),
			})
			const body = await response.json().catch(() => ({}))
			if (body?.ok !== true) {
				throw new Error(body?.error?.message ?? ('HTTP ' + response.status))
			}
			return body.value
		}

		/** Ask, delete, refresh the sidebar. Never throws: every failure is shown in place. */
		async function runDelete(ctx, t, sessionId, title) {
			if (typeof window.confirm !== 'function') return
			if (!window.confirm(t('confirm', { title: title || sessionId }))) return
			try {
				await requestDelete(sessionId)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (typeof window.alert === 'function') window.alert(t('failed') + message)
				return
			}
			try {
				await ctx.sessions?.refresh?.()
			} catch {
				// 刷新失败不影响删除结果；下一次列表事件会同步。
			}
		}

		exports.inject = ['contextMenus', 'locale', 'sessions', 'slots']

		exports.apply = (ctx) => {
			const t = ctx.locale.bind(NS)

			ctx.effect(() => ctx.locale.register(NS, dicts), 'session-delete: locale')

			ctx.effect(() => ctx.slots.inject('contextMenu.icon', () =>
				ctx.slots.register({ name: 'contextMenu.icon', key: ICON_KEY }, TrashIcon),
			), 'session-delete: 垃圾桶图标')

			ctx.effect(() => ctx.contextMenus.register({
				id: 'session.delete',
				target: 'session',
				order: 700,
				observe: () => [ctx.sessions.list],
				resolve: (target) => {
					const row = ctx.sessions.list.getSnapshot()?.byId?.[target.sessionId]
					// 运行中的回合绝不打断；已打开在主视图里的会话先让用户关掉，
					// 否则视图会停在一条刚被删掉的会话上。
					const running = row?.running === true
					const retained = (row?.retainedBy?.mainView ?? 0) > 0
					const key = running ? 'menu.running' : retained ? 'menu.open' : 'menu.delete'
					return [{
						id: 'delete',
						label: t(key),
						icon: { key: ICON_KEY },
						danger: true,
						separatorBefore: true,
						afterContent: true,
						disabled: running || retained,
						failureLabel: t('failed'),
						run: () => runDelete(ctx, t, target.sessionId, target.displayTitle),
					}]
				},
			}), 'session-delete: 会话菜单项')
		}

		return module.exports
	},
})
