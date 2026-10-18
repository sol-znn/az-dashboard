// The Syrius browser extension, v0.3.4 and later.
//
// Ported from zenon-ptlc's lab adapter (`lab/web/src/wallet/syrius.ts`), which
// was run against v0.3.4 and v0.4.0. What a page has to allow for:
//   - nothing (address, chain, node) is readable before the site is approved;
//   - a request within 30 s of a declined or closed window is refused with
//     -32005 and no window. Nothing was signed, so it is held and asked again;
//   - at most two approvals wait per origin, so prompting requests go one at a time;
//   - a reactive or exotic object cannot cross postMessage, so templates are
//     sent as plain JSON.

export class WalletError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
  get declined() {
    return this.code === 4001
  }
}

function translate(err) {
  if (err instanceof WalletError) return err
  const code = typeof err?.code === 'number' ? err.code : 0
  const detail = String(err?.message ?? err ?? '').trim()
  switch (code) {
    case 4001:
      return new WalletError(code, 'Declined in wallet')
    case 4100:
      return new WalletError(code, 'Connect Syrius again')
    case -32005:
      return new WalletError(code, 'Syrius is busy. Try again in 30 s')
    default:
      return new WalletError(code, detail || 'Syrius failed without saying why')
  }
}

export function present() {
  return typeof window.zenon?.sendAccountBlock === 'function'
}

/** Resolves when `window.zenon` exists, or after `ms` if it never does. */
export function ready(ms = 1500) {
  if (present()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('zenon#initialized', done)
      clearTimeout(timer)
      resolve(present())
    }
    window.addEventListener('zenon#initialized', done)
    const timer = setTimeout(done, ms)
  })
}

let queue = Promise.resolve()
function exclusive(job) {
  const next = queue.then(job, job)
  queue = next.catch(() => undefined)
  return next
}

const COOLDOWN_MS = 30_000
let lastAskedAt = 0

async function prompting(ask, onHold) {
  for (let attempt = 0; ; attempt++) {
    const previous = lastAskedAt
    lastAskedAt = Date.now()
    try {
      return await ask()
    } catch (err) {
      if (err?.code !== -32005 || attempt >= 2) throw translate(err)
      const since = previous ? Date.now() - previous : 0
      const wait = attempt > 0 ? COOLDOWN_MS + 1500 : Math.max(2500, COOLDOWN_MS - since + 1500)
      const until = Date.now() + wait
      while (Date.now() < until) {
        onHold?.(Math.ceil((until - Date.now()) / 1000))
        await new Promise((r) => setTimeout(r, 1000))
      }
      onHold?.(0)
    }
  }
}

/** Reads the wallet without prompting. Empty until this origin is approved. */
export async function state() {
  const p = window.zenon
  const s = { present: present(), address: null, chainId: null }
  if (!p) return s
  const ask = async (job, fallback) => {
    try {
      return await job()
    } catch {
      return fallback
    }
  }
  const [accounts, chainId] = await Promise.all([
    ask(() => p.getAccounts(), []),
    ask(() => p.getChainId(), null),
  ])
  s.address = accounts?.[0] ?? null
  s.chainId = chainId == null ? null : Number(chainId)
  return s
}

export function connect(onHold) {
  return exclusive(async () => {
    if (!present()) throw new WalletError(-1, 'Install the Syrius extension')
    await prompting(() => window.zenon.connect(), onHold)
    return state()
  })
}

export async function disconnect() {
  try {
    await window.zenon?.disconnect()
  } catch (err) {
    throw translate(err)
  }
}

/** Hands the template to Syrius to fill in, show, sign and publish. Resolves with the hash. */
export function send(template, onHold) {
  return exclusive(async () => {
    if (!present()) throw new WalletError(-1, 'Install the Syrius extension')
    const plain = JSON.parse(JSON.stringify(template))
    const res = await prompting(() => window.zenon.sendAccountBlock(plain), onHold)
    const block = res?.block ?? res?.signedTransaction ?? null
    const hash = res?.hash ?? block?.hash
    if (!hash) throw new WalletError(-32603, 'Syrius sent the vote but gave no hash')
    return { hash: String(hash), block }
  })
}

export function onChange(handler) {
  const p = window.zenon
  if (!p?.on) return
  for (const e of ['accountsChanged', 'chainChanged', 'disconnect']) p.on(e, () => handler(e))
}
