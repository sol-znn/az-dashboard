// JSON-RPC to public mainnet nodes over HTTPS.
//
// Both nodes answer on 35997 with `Access-Control-Allow-Origin: *`, so a page on
// GitHub Pages can POST to them directly. A WebSocket would also get past CORS,
// but it buys nothing here and adds a connection to keep alive. A node that
// fails is skipped for the rest of the session; `?node=https://host:port`
// puts another one first.

const DEFAULT_NODES = ['https://node.zenonhub.io:35997', 'https://my.hc1node.com:35997']

function nodeList() {
  const asked = new URLSearchParams(location.search).get('node')
  return asked ? [asked, ...DEFAULT_NODES.filter((n) => n !== asked)] : [...DEFAULT_NODES]
}

const nodes = nodeList()
let current = 0
let nextId = 1

export function nodeUrl() {
  return nodes[current]
}

async function post(body, timeoutMs) {
  for (let tries = 0; tries < nodes.length; tries++) {
    const url = nodes[current]
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      console.warn(`[az] ${url} failed: ${err.message}`)
      current = (current + 1) % nodes.length
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error('No node answered')
}

export async function call(method, params = [], timeoutMs = 20000) {
  const body = await post({ jsonrpc: '2.0', id: nextId++, method, params }, timeoutMs)
  if (body.error) throw new Error(body.error.message)
  return body.result
}

/** Several calls in one request. Results come back in the order asked; a failed call is null. */
export async function batch(calls, timeoutMs = 30000) {
  if (calls.length === 0) return []
  const first = nextId
  const body = await post(
    calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: first + i, method, params })),
    timeoutMs,
  )
  nextId += calls.length
  const byId = new Map((Array.isArray(body) ? body : [body]).map((r) => [r.id, r]))
  return calls.map((_, i) => byId.get(first + i)?.result ?? null)
}
