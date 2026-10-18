// What the dashboard reads from mainnet, and the one call it writes.
//
// The rules mirrored here are go-zenon's (`vm/embedded/implementation/accelerator.go`):
//   - a project or phase passes when more than 33% of active Pillars have voted,
//     abstentions included, and Yes outnumbers No;
//   - a project that has not passed 14 days after creation is closed at the next
//     update; a phase vote has no deadline;
//   - votes are stored by Pillar name, so a dissolved Pillar's vote still counts.
// Votes carry no time in contract state. The time shown for a vote is the momentum
// that confirmed it, read off the Accelerator contract's own chain.

import { call, batch } from './rpc.js'

export const ACCELERATOR = 'z1qxemdeddedxaccelerat0rxxxxxxxxxxp4tk22'
export const ZNN_ZTS = 'zts1znnxxxxxxxxxxxxx9z4ulx'
export const MAINNET_CHAIN_ID = 1
export const VOTING_PERIOD = 14 * 24 * 60 * 60

export const VOTE_YES = 0
export const VOTE_NO = 1
export const VOTE_ABSTAIN = 2

// First four bytes of SHA3-256 over the signature, as go-zenon's abi package
// computes them. Checked against vote blocks on mainnet.
const SEL_VOTE_BY_NAME = '5c6c1064' // VoteByName(hash,string,uint8)
const SEL_VOTE_BY_PROD = '90ed001c' // VoteByProdAddress(hash,uint8)

// Project and phase status codes, `vm/embedded/definition/accelerator.go`.
const VOTING = 0
const ACTIVE = 1
const PAID = 2
const CLOSED = 3
const COMPLETED = 4

export async function frontier() {
  return call('ledger.getFrontierMomentum')
}

export async function pillars() {
  const res = await call('embedded.pillar.getAll', [0, 1024])
  return res.list
}

/** Projects by id, in one request. An id the chain does not know is dropped. */
export async function projectsById(ids) {
  const res = await batch(ids.map((id) => ['embedded.accelerator.getProjectById', [id]]))
  return res.filter(Boolean)
}

/**
 * Every project the owner created. `getAll` has no owner filter, and a public node
 * takes 9 to 13 s to answer it whatever the page size (measured 2026-10-17), so
 * this is the slow path: it finds projects projects.json does not list yet.
 */
export async function ownerProjects(owner) {
  const size = 100
  const first = await call('embedded.accelerator.getAll', [0, size], 60000)
  const pages = Math.ceil(first.count / size)
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) =>
      call('embedded.accelerator.getAll', [i + 1, size], 60000).catch(() => null),
    ),
  )
  const all = [first, ...rest].flatMap((r) => r?.list ?? [])
  return all.filter((p) => p.owner === owner).map((p) => p.id)
}

/** Votes needed to pass: more than 33% of active Pillars. */
export function quorum(numPillars) {
  return Math.floor((numPillars * 33) / 100) + 1
}

/**
 * Where a project stands. `group` decides the section it is listed in:
 * payout (a phase is being voted on), open (the project is), funded (accepted,
 * nothing being voted on), done (completed, closed or past its window).
 */
export function classify(p, now, numPillars) {
  const phases = (p.phases ?? []).map((x) => ({ ...x.phase, votes: x.votes }))
  phases.sort((a, b) => a.creationTimestamp - b.creationTimestamp)
  const paid = phases.filter((ph) => ph.status === PAID)
  const sum = (xs, k) => xs.reduce((t, x) => t + BigInt(x[k]), 0n)
  const base = {
    project: p,
    phases,
    paidZnn: sum(paid, 'znnFundsNeeded'),
    paidQsr: sum(paid, 'qsrFundsNeeded'),
    needed: quorum(numPillars),
  }
  const current = phases[phases.length - 1]

  if (p.status === COMPLETED) return { ...base, group: 'done', stage: 'Completed' }
  if (p.status === CLOSED) return { ...base, group: 'done', stage: 'Closed' }
  if (p.status === VOTING) {
    const closes = p.creationTimestamp + VOTING_PERIOD
    if (now > closes) return { ...base, group: 'done', stage: 'Vote ended' }
    return { ...base, group: 'open', stage: 'Project vote', target: p, votes: p.votes, closes }
  }
  if (p.status === ACTIVE && current?.status === VOTING) {
    return { ...base, group: 'payout', stage: 'Phase vote', target: current, votes: current.votes }
  }
  return { ...base, group: 'funded', stage: 'Funded', votes: p.votes }
}

export function progress(item) {
  const v = item.votes
  if (!v) return 0
  return v.total / item.needed
}

export function passing(item) {
  const v = item.votes
  return !!v && v.total >= item.needed && v.yes > v.no
}

// ---------- vote history ----------

const scanned = new Map() // hash of the send block -> decoded vote
let scannedPages = 0
let scannedOldest = Infinity
let scanDone = false

function fromBase64(s) {
  if (!s) return new Uint8Array(0)
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function decodeVote(send) {
  const d = fromBase64(send.data)
  if (d.length < 68) return null
  const sel = hex(d.subarray(0, 4))
  const id = hex(d.subarray(4, 36))
  if (sel === SEL_VOTE_BY_NAME && d.length >= 132) {
    const offset = Number(BigInt('0x' + hex(d.subarray(36, 68))))
    const vote = d[99]
    const lenAt = 4 + offset
    const len = Number(BigInt('0x' + hex(d.subarray(lenAt, lenAt + 32))))
    const name = new TextDecoder().decode(d.subarray(lenAt + 32, lenAt + 32 + len))
    return { id, vote, name, by: 'name' }
  }
  if (sel === SEL_VOTE_BY_PROD) return { id, vote: d[67], producer: send.address, by: 'producer' }
  return null
}

/** Reads the Accelerator contract's chain, newest first, back to `since` (unix seconds). */
async function scanBack(since) {
  const size = 250
  while (!scanDone && scannedOldest >= since) {
    const res = await call(
      'ledger.getAccountBlocksByPage',
      [ACCELERATOR, scannedPages, size],
      45000,
    )
    scannedPages++
    const list = res?.list ?? []
    if (list.length < size) scanDone = true
    for (const b of list) {
      const t = b.confirmationDetail?.momentumTimestamp ?? 0
      scannedOldest = Math.min(scannedOldest, t)
      const send = b.pairedAccountBlock
      if (!send || scanned.has(send.hash)) continue
      const v = decodeVote(send)
      if (v) scanned.set(send.hash, { ...v, hash: send.hash, from: send.address, time: t })
    }
  }
}

/**
 * Picks up blocks added since the first scan. New blocks push older ones onto
 * later pages, so paging from the top until a known block shows up misses none.
 */
async function scanNew() {
  if (scannedPages === 0) return
  for (let page = 0; page < 20; page++) {
    const res = await call('ledger.getAccountBlocksByPage', [ACCELERATOR, page, 50], 30000)
    const list = res?.list ?? []
    let known = false
    for (const b of list) {
      const send = b.pairedAccountBlock
      if (!send) continue
      if (scanned.has(send.hash)) {
        known = true
        continue
      }
      const v = decodeVote(send)
      const t = b.confirmationDetail?.momentumTimestamp ?? 0
      if (v) scanned.set(send.hash, { ...v, hash: send.hash, from: send.address, time: t })
    }
    if (known || list.length < 50) return
  }
}

/**
 * Who voted on `ids`, and when. Contract state is the authority for each vote;
 * the scan supplies the time and the block, and the names of Pillars that have
 * since dissolved.
 */
export async function votesFor(ids, since, pillarList, fresh = false) {
  if (fresh) await scanNew()
  await scanBack(since)
  const want = new Set(ids)
  const producerName = new Map(pillarList.map((p) => [p.producerAddress, p.name]))
  const latest = new Map() // `${name}|${id}` -> scanned vote, newest kept
  for (const v of scanned.values()) {
    if (!want.has(v.id)) continue
    const name = v.by === 'name' ? v.name : producerName.get(v.producer)
    if (!name) continue
    const key = `${name}|${v.id}`
    const prev = latest.get(key)
    if (!prev || v.time > prev.time) latest.set(key, { ...v, name })
  }
  const names = new Set(pillarList.map((p) => p.name))
  for (const v of latest.values()) names.add(v.name)
  const nameList = [...names]
  const answers = await batch(nameList.map((n) => ['embedded.accelerator.getPillarVotes', [n, ids]]))
  const byId = new Map(ids.map((id) => [id, []]))
  nameList.forEach((name, i) => {
    const row = answers[i]
    if (!row) return
    row.forEach((pv, j) => {
      if (!pv) return
      const seen = latest.get(`${name}|${ids[j]}`)
      byId.get(ids[j]).push({
        name,
        vote: pv.vote,
        time: seen?.time ?? null,
        hash: seen?.hash ?? null,
      })
    })
  })
  for (const list of byId.values()) list.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
  return byId
}

// ---------- the vote ----------

function word(n) {
  const out = new Uint8Array(32)
  let v = BigInt(n)
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function fromHex(h) {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16)
  return out
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function toBase64(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** ABI data for a vote: by name from the owner address, by producer address otherwise. */
export function voteData(id, vote, pillarName) {
  if (pillarName == null) return concat(fromHex(SEL_VOTE_BY_PROD), fromHex(id), word(vote))
  const name = new TextEncoder().encode(pillarName)
  const padded = new Uint8Array(Math.ceil(name.length / 32) * 32)
  padded.set(name)
  return concat(fromHex(SEL_VOTE_BY_NAME), fromHex(id), word(96), word(vote), word(name.length), padded)
}

const ZERO_HASH = '0'.repeat(64)

/**
 * A complete account block with the signer's fields zeroed, which is what the
 * Syrius extension takes: it parses every field, so a missing one is an error
 * inside the wallet. Amount 0 in ZNN, as znn_sdk_dart builds the same call.
 */
export function voteTemplate(id, vote, pillarName) {
  return {
    version: 1,
    chainIdentifier: MAINNET_CHAIN_ID,
    blockType: 2,
    hash: ZERO_HASH,
    previousHash: ZERO_HASH,
    height: 0,
    momentumAcknowledged: { hash: ZERO_HASH, height: 0 },
    address: 'z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f',
    toAddress: ACCELERATOR,
    amount: '0',
    tokenStandard: ZNN_ZTS,
    fromBlockHash: ZERO_HASH,
    descendantBlocks: [],
    data: toBase64(voteData(id, vote, pillarName)),
    fusedPlasma: 0,
    difficulty: 0,
    nonce: '',
    basePlasma: 0,
    usedPlasma: 0,
    changesHash: ZERO_HASH,
    publicKey: '',
    signature: '',
  }
}
