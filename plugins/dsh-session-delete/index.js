/**
 * dsh-session-delete — Host 半边。
 *
 * 官方 Web API 只有 `workspace.archiveSession`（隐藏），没有删除会话的入口。
 * 本插件在 webServer 上补一个同源路由：
 *   POST /api-ext/session.delete   body: { "sessionId": "session-..." }
 *
 * 删除顺序（任一步失败即中止并向 UI 回报原因）：
 *   1. 拒绝仍在运行一轮的会话；
 *   2. 卸载仍挂着的 agent fiber —— 让它自己的持久化写入端先有序关闭；
 *   3. 从 live SessionStore 摘除条目（否则侧边栏会留下已无日志的幽灵行）；
 *   4. 从各工作区记录里摘除该会话 id；
 *   5. 删除磁盘上的会话目录。
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'session-delete'

/** `webServer` 必需；sessions / agents / workspaceRegistry / sessionPersistence 按需解析。 */
export const inject = ['webServer']

const ROUTE_PATH = '/api-ext/session.delete'
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const BODY_LIMIT = 1 << 16
/** Same-origin envelope of one relay refusal, kept in the relay's own error shape. */
const rpcFailure = (code, message) => ({ ok: false, error: { code, message, details: {} } })

/** `$DSH_HOME/sessions`，与宿主一致（DSH_HOME 未设置时回退到 ~/.dsh）。 */
function sessionsRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
}

async function readJsonBody(req, limit = BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function fail(res, code, message, status = 200) {
  sendJson(res, { ok: false, error: { code, message } }, status)
}

/**
 * 该路由会改状态，因此拒绝跨站浏览器 POST。
 * 不带 Origin 的调用（curl / 本机 CLI）照常接受。
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** 只在 `$DSH_HOME/sessions/<project>/<sessionId>` 这一层动手。 */
function isSessionDir(root, dir, sessionId) {
  return basename(dir) === sessionId && dirname(dirname(dir)) === root
}

/** 该会话的候选产物目录，精确位置优先。 */
async function artifactDirs(sessionId, persistence) {
  const root = sessionsRoot()
  const dirs = new Set()
  try {
    const snapshot = await persistence?.stat?.(sessionId)
    const file = snapshot?.location?.path
    // 上报的是日志文件；会话拥有它的目录。
    if (typeof file === 'string' && file !== '') {
      const dir = dirname(file)
      if (isSessionDir(root, dir, sessionId)) dirs.add(dir)
    }
  } catch {
    // 持久化服务不可用 —— 回退到目录扫描
  }
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return [...dirs]
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name, sessionId)
    if (isSessionDir(root, dir, sessionId)) dirs.add(dir)
  }
  return [...dirs]
}

/** 删除该会话在各 project 目录下的产物文件夹。 */
async function removeArtifacts(sessionId, persistence) {
  const root = sessionsRoot()
  let removed = 0
  for (const dir of await artifactDirs(sessionId, persistence)) {
    if (!isSessionDir(root, dir, sessionId)) continue
    try {
      await stat(dir)
    } catch {
      continue // 不存在（或已删）—— 不是这个会话的目录
    }
    try {
      await rm(dir, { recursive: true, force: true })
      removed += 1
    } catch {
      // 被占用的产物留在原地，由调用方报告数量
    }
  }
  return removed
}

/**
 * 抹掉该会话的投影缓存行：内存表（若该版本暴露句柄）+ 磁盘上的
 * `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`。
 * 留下这一行不会让会话复活，但会让已删会话的残影留在缓存目录里。
 * @returns 实际清掉的文件数（0 或 1）
 */
async function forgetProjectionCache(sessionId, cache) {
  try {
    await cache?.requireTable?.()?.delete?.(sessionId)
  } catch {
    // 该版本没暴露表句柄 —— 磁盘上的行文件照删即可
  }
  const file = join(
    process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    'storages', 'session_projcache', 'sessions', `${sessionId}.json`,
  )
  if (basename(file) !== `${sessionId}.json`) return 0
  try {
    await stat(file)
  } catch {
    return 0
  }
  try {
    await rm(file, { force: true })
    return 1
  } catch {
    return 0
  }
}
/** 从 live SessionStore 摘除条目，返回是否摘除成功。 */
function detachLiveStore(sessions, sessionId) {
  const store = sessions?.store
  const entry = store?.get?.(sessionId)
  if (entry?.detach === undefined) return false
  try {
    entry.detach()
    return true
  } catch {
    return false
  }
}

/** 从每条列有该会话的工作区记录里摘除它。 */
async function detachWorkspaces(workspaceRegistry, sessionId) {
  if (workspaceRegistry?.list === undefined) return 0
  let removed = 0
  for (const workspace of workspaceRegistry.list()) {
    const ids = workspace?.sessionIds
    if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
    await workspace.detachSession?.(sessionId)
    removed += 1
  }
  return removed
}

/**
 * 卸载空闲 agent 的 fiber：agent 暴露自己的 Context，fiber 的 `_unload()`
 * 逆序执行 agent-loop 的清理，包含 agent、持久化写入端与会话挂载的有序拆除。
 * @returns 卸载成功（或该 agent 没有暴露 fiber）时为 true
 */
async function disposeAgentFiber(agent) {
  const fiber = agent?.ctx?.fiber
  if (fiber?._unload === undefined) return false
  try {
    await fiber._unload()
    return true
  } catch {
    return false
  }
}

/**
 * 删除只接受本机回环调用：即使宿主把 webServer 绑到了 LAN 地址，
 * 或请求经远端通道转发进来，这条路由也不会被外机命中。
 */
function isLoopbackCaller(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string' || address === '') return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Publish the deletion to the DSH Remote relay.
 *
 * The relay tunnels Typert RPCs, not HTTP: a peer deletes through its `session/delete`
 * endpoint, and the relay's bridge asks this process-level hook instead of dispatching to the
 * Gateway, which has no delete endpoint of its own. Publishing on `globalThis` keeps the two
 * plugins independent — neither loads the other's module instance — and a Host without the
 * relay never reads it. The hook forwards to the loopback route above, so both callers share
 * one deletion path (running-session guard, ordered teardown, workspace detach, artifacts,
 * projection cache).
 * @returns the disposer that withdraws the hook.
 */
function installRemoteDeletion(ctx, webServer) {
  if (typeof webServer.getOrigin !== 'function') return () => {}

  const localDelete = async (args) => {
    const sessionId = args?.sessionId
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      return rpcFailure('bad-request', 'missing or invalid sessionId')
    }
    let origin
    try {
      origin = webServer.getOrigin()
    } catch {
      return rpcFailure('unavailable', 'the Host web server is not listening yet')
    }
    try {
      const response = await fetch(`${origin}${ROUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const body = await response.json().catch(() => ({}))
      if (body?.ok === true) return { ok: true, value: body.value }
      return rpcFailure(body?.error?.code ?? 'failed', body?.error?.message ?? `HTTP ${response.status}`)
    } catch (error) {
      return rpcFailure('failed', String(error?.message ?? error))
    }
  }

  globalThis.__dshSessionDeletion = localDelete
  ctx.logger?.info?.('session-delete: 已向 DSH Remote 中继公布 session/delete 与 session/deletion')
  return () => {
    if (globalThis.__dshSessionDeletion === localDelete) delete globalThis.__dshSessionDeletion
  }
}

export function apply(ctx) {
  const webServer = ctx.webServer
  if (webServer === undefined) throw new Error('dsh-session-delete: 缺少 webServer 服务')

  const optional = service => (typeof ctx.get === 'function' ? ctx.get(service) : ctx[service])

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      if (!sameOrigin(req)) {
        fail(res, 'forbidden', 'cross-origin requests are refused', 403)
        return
      }
      if (!isLoopbackCaller(req)) {
        fail(res, 'forbidden', '只能从本机调用这条删除路由', 403)
        return
      }

      let payload
      try {
        payload = await readJsonBody(req)
      } catch (error) {
        fail(res, 'bad-request', String(error?.message ?? error))
        return
      }
      const sessionId = payload?.sessionId
      if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        fail(res, 'bad-request', 'missing or invalid sessionId')
        return
      }

      const sessions = optional('sessions')
      const agents = optional('agents')
      const workspaceRegistry = optional('workspaceRegistry')
      const persistence = optional('sessionPersistence')
      const projectionCache = optional('sessionProjectionCache')

      try {
        const wasLive = sessions?.store?.has?.(sessionId) === true
        const agent = agents?.get?.(sessionId)
        if (agent?.status === 'running') {
          fail(res, 'refused', `会话 ${sessionId} 正在运行，请先停止再删除`)
          return
        }
        if (agent !== undefined) {
          const disposed = await disposeAgentFiber(agent)
          if (!disposed) {
            fail(res, 'refused', `会话 ${sessionId} 的 agent 无法停止，已放弃删除`)
            return
          }
        }

        // agent 先走：store 条目正是删掉文件后侧边栏仍留行的原因。
        const detachCalled = detachLiveStore(sessions, sessionId)
        const detached = detachCalled || (wasLive && sessions?.store?.has?.(sessionId) !== true)

        const workspaces = await detachWorkspaces(workspaceRegistry, sessionId)
        const files = await removeArtifacts(sessionId, persistence)
        const projections = await forgetProjectionCache(sessionId, projectionCache)

        if (!wasLive && workspaces === 0 && files === 0) {
          fail(res, 'not-found', `没有找到会话 ${sessionId}`, 404)
          return
        }

        ctx.logger?.info?.(
          `session-delete: 已删除 ${sessionId} (agent=${agent !== undefined}, workspaces=${workspaces}, files=${files}, projections=${projections})`,
        )
        sendJson(res, { ok: true, value: { detached, agentDisposed: agent !== undefined, workspaces, files, projections } })
      } catch (error) {
        ctx.logger?.warn?.(`session-delete: 删除 ${sessionId} 失败: ${String(error?.message ?? error)}`)
        fail(res, 'internal', String(error?.message ?? error))
      }
    },
  }), 'session-delete: 删除路由')

  ctx.effect(() => installRemoteDeletion(ctx, webServer), 'session-delete: 中继删除端点')

  ctx.logger?.info?.(`session-delete: 已注册 POST ${ROUTE_PATH}`)
}

// 供单元测试使用的内部实现（不属于对外接口）。
export { artifactDirs, detachLiveStore, detachWorkspaces, disposeAgentFiber, removeArtifacts, sameOrigin }
