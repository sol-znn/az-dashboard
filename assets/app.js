// AZ dashboard: one owner's Accelerator-Z projects, grouped by where they stand
// in the vote. Phase payouts first, then project votes, then funded work; anything
// completed or closed is hidden behind one button.
//
// Chain data is read live (chain.js). What the chain cannot know, the work's state,
// its links and what shipped, is in projects.json, keyed by project id. A project
// with no entry there is still listed, from the chain alone.

import * as chain from './chain.js'
import { nodeUrl } from './rpc.js'
import * as wallet from './wallet.js'

const $ = (sel) => document.querySelector(sel)
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const icon = (name, cls = '') => `<svg class="i ${cls}"><use href="#i-${name}"/></svg>`

const state = {
  meta: { projects: {} },
  owner: '',
  ids: new Set(), // projects to read; projects.json's, plus any getAll turns up
  discovered: false,
  pillars: [],
  items: [],
  now: Math.floor(Date.now() / 1000),
  open: new Set(),
  openSections: new Set(), // vote ids whose folded section is expanded; survives re-render
  refreshing: false,
  justOpened: null, // the project whose body plays its slide-in on this render
  votes: new Map(), // project id -> Map(vote id -> voters)
  loadingVotes: new Set(),
  account: null, // { address, chainId, pillar, byName }
  sending: false,
  showDone: readPref('showDone') === '1',
}

function readPref(key) {
  try {
    return localStorage.getItem('az.' + key)
  } catch {
    return null
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem('az.' + key, value)
  } catch {
    /* private window: the toggle just is not remembered */
  }
}

// ---------- formatting ----------

/** Base units to a whole amount, without trailing zeros and without rounding. */
function amount(base) {
  const v = BigInt(base)
  const whole = (v / 100000000n).toLocaleString('en-US')
  const frac = (v % 100000000n).toString().padStart(8, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

function ask(znn, qsr) {
  return `<span class="num">${amount(znn)}</span> ZNN · <span class="num">${amount(qsr)}</span> QSR`
}

function when(t) {
  if (!t) return ''
  const d = new Date(t * 1000)
  const opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric'
  return d.toLocaleString(undefined, opts)
}

function left(seconds) {
  if (seconds <= 0) return 'closing'
  const d = Math.floor(seconds / 86400)
  if (d >= 1) return `${d} d left`
  const h = Math.floor(seconds / 3600)
  return h >= 1 ? `${h} h left` : `${Math.ceil(seconds / 60)} min left`
}

function short(addr) {
  return addr ? `${addr.slice(0, 7)}…${addr.slice(-5)}` : ''
}

// One word per state, app-wide, each with its icon and tone.
const WORK = {
  delivered: ['Delivered', 'circle-check', 'green'],
  'in development': ['In development', 'code', 'blue'],
  'waiting for zip': ['Waiting for ZIP', 'file-text', 'amber'],
  'waiting for merge': ['Waiting for merge', 'git-pull-request', 'amber'],
  'waiting for spork': ['Waiting for spork', 'hourglass', 'amber'],
  planned: ['Planned', 'clock', ''],
}
const VOTE = [
  ['Yes', 'thumbs-up', 'green'],
  ['No', 'thumbs-down', 'crimson'],
  ['Abstain', 'minus', ''],
]
const LINK_ICON = {
  forum: 'message-square',
  repo: 'github',
  release: 'github',
  branch: 'code',
  pr: 'git-pull-request',
  live: 'globe',
  demo: 'play',
  docs: 'file-text',
  az: 'coins',
}

const chip = (label, ic, tone) => `<span class="chip ${tone ? 'tone-' + tone : ''}">${icon(ic)}${esc(label)}</span>`

// ---------- loading ----------

async function loadIcons() {
  try {
    const res = await fetch('assets/icons.svg')
    $('#icons').innerHTML = await res.text()
  } catch {
    /* labels still carry every state */
  }
}

async function loadChain() {
  const [momentum, pillars, projects] = await Promise.all([
    chain.frontier(),
    chain.pillars(),
    chain.projectsById([...state.ids]),
  ])
  state.now = momentum.timestamp
  state.pillars = pillars
  state.items = projects
    .filter((p) => p.owner === state.owner)
    .map((p) => chain.classify(p, state.now, pillars.length))
  showNode(momentum.height)
  matchPillar()
}

function showNode(height) {
  const n = $('#node')
  n.classList.remove('down')
  n.classList.add('live')
  $('#height').textContent = height.toLocaleString('en-US')
  n.title = `Mainnet momentum ${height} from ${nodeUrl()}`
  $('#foot-node').textContent = nodeUrl().replace(/^https:\/\//, '')
}

function nodeDown() {
  const n = $('#node')
  n.classList.remove('live')
  n.classList.add('down')
  $('#height').textContent = 'offline'
}

async function loadVotes(item, fresh = false) {
  const p = item.project
  if (state.loadingVotes.has(p.id)) return
  state.loadingVotes.add(p.id)
  render()
  try {
    const ids = [p.id, ...item.phases.map((ph) => ph.id)]
    const byId = await chain.votesFor(ids, p.creationTimestamp, state.pillars, fresh)
    state.votes.set(p.id, byId)
  } catch (err) {
    toast('err', 'Votes could not be read. Try again.')
    console.warn('[az] votes', err)
  } finally {
    state.loadingVotes.delete(p.id)
    render()
  }
}

// ---------- ordering ----------

const GROUPS = [
  ['payout', 'Phase payouts'],
  ['open', 'Open votes'],
  ['funded', 'In progress'],
  ['done', 'Completed'],
]

// Alphabetical within a group, numbers compared as numbers, so a project filed
// as "(1/3)", "(2/3)", "(3/3)" reads in order and "(10/19)" follows "(9/19)".
const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function ordered(group) {
  return state.items
    .filter((it) => it.group === group)
    .sort((a, b) => byName.compare(a.project.name, b.project.name))
}

// ---------- rendering ----------

// The page refreshes every few seconds and most refreshes change nothing; leaving
// the DOM alone then keeps hover, focus and a text selection where they were.
const rendered = new Map()
function setHtml(sel, html) {
  if (rendered.get(sel) === html) return
  rendered.set(sel, html)
  $(sel).innerHTML = html
}

function render() {
  const needed = chain.quorum(state.pillars.length)
  const count = (g) => state.items.filter((it) => it.group === g).length
  setHtml('#strip', [
    ['Phase votes', count('payout')],
    ['Project votes', count('open')],
    ['In progress', count('funded')],
    ['Pillars', state.pillars.length],
    ['Quorum', needed],
  ]
    .map(([k, v]) => `<div class="stat"><div class="label">${k}</div><div class="v">${v}</div></div>`)
    .join(''))

  const html = []
  for (const [key, title] of GROUPS) {
    if (key === 'done' && !state.showDone) continue
    const list = ordered(key)
    if (list.length === 0) continue
    const target = key === 'payout' || key === 'open'
    let total = ''
    if (target) {
      const z = list.reduce((t, it) => t + BigInt(it.target.znnFundsNeeded), 0n)
      const q = list.reduce((t, it) => t + BigInt(it.target.qsrFundsNeeded), 0n)
      total = `<span class="dim">· ${ask(z, q)} asked</span>`
    }
    html.push(
      `<section class="group"><div class="group-h"><h2>${title}</h2><span class="dim num">${list.length}</span>${total}</div>
       <div class="list">${list.map(itemHtml).join('')}</div></section>`,
    )
  }
  setHtml(
    '#groups',
    html.join('') ||
      (state.discovered ? '<p class="dim">None yet</p>' : '<p class="dim loading">Loading projects<span class="ell"></span></p>'),
  )

  const done = count('done')
  const toggle = $('#toggle-done')
  toggle.hidden = done === 0
  $('#toggle-done-label').textContent = state.showDone ? `Hide completed (${done})` : `Show completed (${done})`
  toggle.querySelector('use').setAttribute('href', state.showDone ? '#i-eye-off' : '#i-eye')
}

function tallyHtml(item) {
  const v = item.votes
  if (!v) return ''
  const abs = v.total - v.yes - v.no
  const scale = Math.max(item.needed, v.total)
  const pct = (n) => `${((n / scale) * 100).toFixed(2)}%`
  const pass = chain.passing(item)
  const verdict = item.group === 'payout' || item.group === 'open'
    ? pass
      ? chip('Passing', 'check', 'green')
      : `<span><b class="num">${Math.max(0, item.needed - v.total)}</b> more to quorum</span>`
    : ''
  return `<div class="tally">
    <div class="bar-track" role="img" aria-label="${v.total} of ${item.needed} votes">
      <span class="seg yes" style="width:${pct(v.yes)}"></span>
      <span class="seg no" style="width:${pct(v.no)}"></span>
      <span class="seg abs" style="width:${pct(abs)}"></span>
    </div>
    <div class="tally-text">
      <span><b class="num">${v.total}</b> / <span class="num">${item.needed}</span> votes</span>
      <span><b class="num">${v.yes}</b> yes</span>
      <span><b class="num">${v.no}</b> no</span>
      <span><b class="num">${abs}</b> abstain</span>
      ${verdict}
    </div>
  </div>`
}

function itemHtml(item) {
  const p = item.project
  const meta = state.meta.projects[p.id] ?? {}
  const open = state.open.has(p.id)
  const work = WORK[meta.status]
  const stageTone = item.group === 'payout' || item.group === 'open' ? 'blue' : ''
  const stageLabel = item.group === 'payout' ? `Phase vote: ${item.target.name}` : item.stage
  const stageIcon = item.group === 'payout' ? 'coins' : item.group === 'open' ? 'hourglass' : item.group === 'done' ? 'circle-check' : 'circle-dot'
  const asked = item.target
    ? ask(item.target.znnFundsNeeded, item.target.qsrFundsNeeded)
    : ask(p.znnFundsNeeded, p.qsrFundsNeeded)
  const closes = item.closes ? `<span>${icon('clock')} ${left(item.closes - state.now)}</span>` : ''

  return `<article class="item ${open ? 'open' : ''}" data-id="${p.id}">
    <button class="head" type="button" aria-expanded="${open}">
      <div class="title-row"><span class="title">${esc(p.name)}</span>${work ? chip(...work) : ''}</div>
      <div class="meta">${chip(stageLabel, stageIcon, stageTone)}<span>${asked}</span>${closes}</div>
      ${tallyHtml(item)}
      ${icon('chevron-down', 'chev')}
    </button>
    ${open ? bodyHtml(item, meta) : ''}
  </article>`
}

function linksHtml(item, meta) {
  const p = item.project
  const links = [{ kind: 'forum', label: 'Forum', url: p.url }]
  const phaseUrl = item.target?.url
  if (phaseUrl && phaseUrl !== p.url) links.push({ kind: 'forum', label: `${item.target.name} post`, url: phaseUrl })
  links.push(...(meta.links ?? []))
  links.push({ kind: 'az', label: 'zenonhub', url: `https://zenonhub.io/accelerator-z/project/${p.id}` })
  return `<div class="links">${links
    .filter((l) => /^https:\/\//.test(l.url ?? ''))
    .map((l) => `<a class="link" href="${esc(l.url)}" target="_blank" rel="noopener">${icon(LINK_ICON[l.kind] ?? 'external-link')}${esc(l.label)}</a>`)
    .join('')}</div>`
}

function phasesHtml(item) {
  if (item.phases.length === 0) return ''
  const label = ['Voting', 'Accepted', 'Paid', 'Closed']
  const tone = ['blue', 'green', 'green', '']
  const ic = ['hourglass', 'check', 'circle-check', 'circle-x']
  const remainingZ = BigInt(item.project.znnFundsNeeded) - item.paidZnn
  const remainingQ = BigInt(item.project.qsrFundsNeeded) - item.paidQsr
  return `<div><div class="label sub-h">Phases · ${ask(remainingZ, remainingQ)} left</div><div class="rows">${item.phases
    .map(
      (ph) => `<div class="row phase-row"><span class="name">${esc(ph.name)}<span class="dim"> · ${esc(ph.description)}</span></span>
        <span class="dim">${ask(ph.znnFundsNeeded, ph.qsrFundsNeeded)}</span>
        ${chip(label[ph.status] ?? 'Unknown', ic[ph.status] ?? 'circle-dot', tone[ph.status] ?? '')}</div>`,
    )
    .join('')}</div></div>`
}

function voteRow(name, v) {
  const [label, ic, tone] = VOTE[v.vote] ?? ['Unknown', 'circle-dot', '']
  const time = v.time
    ? v.hash
      ? `<a class="num" href="https://zenonhub.io/explorer/block/${v.hash}" target="_blank" rel="noopener" title="${new Date(v.time * 1000).toISOString()}">${when(v.time)}</a>`
      : `<span class="num">${when(v.time)}</span>`
    : ''
  return `<div class="row"><span class="name">${name}</span>${chip(label, ic, tone)}<span class="when">${time}</span></div>`
}

function votersHtml(voters) {
  if (!voters || voters.length === 0) return '<p class="dim">None yet</p>'
  return `<div class="rows">${voters.map((v) => voteRow(esc(v.name), v)).join('')}</div>`
}

// Votes the contract refused: any address can send one, and it is on chain, but
// only a Pillar's owner or producer is counted.
function proxiesHtml(proxies) {
  if (!proxies || proxies.length === 0) return ''
  const rows = proxies.map((v) => {
    const who = `<a class="num" href="https://zenonhub.io/explorer/account/${v.address}" target="_blank" rel="noopener" title="${v.address}">${short(v.address)}</a>`
    const as = v.claimed ? `<span class="dim"> as ${esc(v.claimed)}</span>` : ''
    return voteRow(who + as, v)
  })
  return `<div class="proxies"><div class="label sub-h proxy-h">${icon('triangle-alert')}Proxy votes · <span class="num">${proxies.length}</span><span class="dim">Not counted</span></div>
    <div class="rows">${rows.join('')}</div></div>`
}

function voteSectionHtml(item, byId) {
  const p = item.project
  const loading = state.loadingVotes.has(p.id)
  const sections = [{ id: p.id, title: 'Project vote', votes: p.votes }]
  for (const ph of item.phases) sections.push({ id: ph.id, title: ph.name, votes: ph.votes })
  // The vote being decided now goes first and open; the rest fold away.
  const currentId = item.target?.id ?? p.id
  sections.sort((a, b) => (b.id === currentId) - (a.id === currentId))
  if (!byId) {
    return `<div><div class="label sub-h">Votes</div><p class="dim loading">${loading ? 'Reading votes<span class="ell"></span>' : ''}</p></div>`
  }
  return sections
    .map((s, i) => {
      const { pillars, proxies } = byId.get(s.id) ?? {}
      const list = votersHtml(pillars) + proxiesHtml(proxies)
      const extra = proxies?.length ? ` · <span class="num">${proxies.length}</span> proxy` : ''
      const head = `${esc(s.title)} · <span class="num">${s.votes?.total ?? 0}</span>${extra}`
      return i === 0
        ? `<div><div class="label sub-h">${head}</div>${list}</div>`
        : `<details data-section="${s.id}" ${state.openSections.has(s.id) ? 'open' : ''}><summary class="label sub-h">${head}</summary>${list}</details>`
    })
    .join('')
}

function voteBoxHtml(item, byId) {
  if (!item.target) return ''
  const a = state.account
  let line
  let eligible = false
  const proxy = !!a && !a.pillar
  if (!a) line = `<span class="dim">Connect to vote. Only Pillar votes count.</span>`
  else if (!onMainnet(a))
    line = `${chip('Wrong network', 'triangle-alert', 'amber')}<span class="dim">Switch Syrius to Zenon Mainnet.</span>`
  else if (proxy) {
    eligible = true
    line = `${chip('Proxy vote', 'triangle-alert', 'amber')}<span class="dim">${short(a.address)} runs no Pillar. Shown here, not counted.</span>`
  } else {
    eligible = true
    line = `<span>Voting as <b>${esc(a.pillar.name)}</b></span>`
  }
  const cast = byId?.get(item.target.id)
  const mine = !a
    ? undefined
    : proxy
      ? cast?.proxies.find((v) => v.address === a.address)?.vote
      : cast?.pillars.find((v) => v.name === a.pillar.name)?.vote
  if (mine !== undefined) line += chip(`You voted ${VOTE[mine][0]}`, VOTE[mine][1], VOTE[mine][2])
  const disabled = state.sending || (a && !eligible) ? 'disabled' : ''
  const cls = ['yes', 'no', 'abs']
  return `<div class="vote ${proxy ? 'proxy' : ''}">
    <div class="vote-h"><span class="label">${item.group === 'payout' ? esc(item.target.name) : 'Project'}</span>${line}</div>
    <div class="vote-btns">${VOTE.map(
      ([label, ic], v) => `<button class="btn ${cls[v]} ${mine === v ? 'mine' : ''}" type="button" data-vote="${v}" ${disabled}>${icon(ic)}${label}</button>`,
    ).join('')}</div>
  </div>`
}

function bodyHtml(item, meta) {
  const byId = state.votes.get(item.project.id)
  const changes = meta.changelog?.length
    ? `<div><div class="label sub-h">Changelog</div><ul class="changes">${meta.changelog
        // A line that names work still to do is marked pending, not ticked.
        .map((c) =>
          /^(Next|Open|Not started)\b/.test(c)
            ? `<li class="todo">${icon('circle-dot')}<span>${esc(c)}</span></li>`
            : `<li>${icon('check')}<span>${esc(c)}</span></li>`,
        )
        .join('')}</ul></div>`
    : ''
  // Slides in when opened, not on every re-render after.
  return `<div class="body ${state.justOpened === item.project.id ? 'enter' : ''}">
    ${item.project.description ? `<p class="desc">${esc(item.project.description)}</p>` : ''}
    ${linksHtml(item, meta)}
    ${changes}
    ${phasesHtml(item)}
    ${voteBoxHtml(item, byId)}
    ${voteSectionHtml(item, byId)}
  </div>`
}

// ---------- wallet ----------

const onMainnet = (a) => a.chainId == null || a.chainId === chain.MAINNET_CHAIN_ID

function matchPillar() {
  const a = state.account
  if (!a?.address) return
  const byOwner = state.pillars.find((p) => p.ownerAddress === a.address)
  const byProducer = state.pillars.find((p) => p.producerAddress === a.address)
  a.pillar = byOwner ?? byProducer ?? null
  // VoteByName must come from the owner address; the producer uses VoteByProdAddress.
  a.byName = !!byOwner
}

function showAccount() {
  const btn = $('#connect')
  const a = state.account
  btn.classList.toggle('connected', !!a)
  $('#connect-label').textContent = a ? (a.pillar ? a.pillar.name : short(a.address)) : 'Connect'
  btn.title = a ? `${a.address}. Click to disconnect.` : ''
}

async function setAccount(s) {
  state.account = s?.address ? { address: s.address, chainId: s.chainId, pillar: null, byName: false } : null
  matchPillar()
  showAccount()
  render()
}

async function onConnect() {
  if (state.account) {
    try {
      await wallet.disconnect()
    } catch {
      /* already gone */
    }
    await setAccount(null)
    return
  }
  if (!(await wallet.ready(300))) {
    toast('info', 'Install the Syrius extension', 'https://github.com/sol-znn/syrius-extension/releases/latest', 'Get it')
    return
  }
  try {
    const s = await wallet.connect((secs) => secs && ($('#connect-label').textContent = `Wait ${secs} s`))
    await setAccount(s)
    if (s.address && !state.account.pillar) toast('info', 'No Pillar here. Your votes are proxy votes, not counted.')
  } catch (err) {
    showAccount()
    toast(err.declined ? 'info' : 'err', err.message)
  }
}

async function onVote(item, vote) {
  if (!state.account) return onConnect()
  const a = state.account
  if (!onMainnet(a) || state.sending) return
  state.sending = true
  render()
  try {
    // Without a Pillar the block goes by producer address and claims no name.
    const template = chain.voteTemplate(item.target.id, vote, a.pillar && a.byName ? a.pillar.name : null)
    const sent = await wallet.send(template, (secs) => secs && toast('info', `Syrius is busy. Asking again in ${secs} s`, null, null, 1000))
    const done = a.pillar ? `Voted ${VOTE[vote][0]}` : `Proxy vote ${VOTE[vote][0]} sent. Not counted.`
    toast('ok', done, `https://zenonhub.io/explorer/block/${sent.hash}`, 'View')
    // Confirmed in a momentum or two, received by the contract after that.
    setTimeout(() => refresh(true), 25000)
  } catch (err) {
    toast(err.declined ? 'info' : 'err', err.message)
  } finally {
    state.sending = false
    render()
  }
}

// ---------- toasts ----------

function toast(kind, text, href, linkText, life = 5000) {
  const box = $('#toasts')
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.style.setProperty('--life', `${life}ms`)
  const ic = { ok: 'circle-check', err: 'circle-x', info: 'circle-dot' }[kind]
  el.innerHTML = `${icon(ic)}<span>${esc(text)}</span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(linkText)}</a>` : ''}`
  box.append(el)
  while (box.children.length > 3) box.firstElementChild.remove()
  setTimeout(() => el.remove(), life)
}

// ---------- events ----------

$('#groups').addEventListener('click', (e) => {
  const art = e.target.closest('.item')
  if (!art) return
  const item = state.items.find((it) => it.project.id === art.dataset.id)
  if (!item) return
  const voteBtn = e.target.closest('[data-vote]')
  if (voteBtn) return onVote(item, Number(voteBtn.dataset.vote))
  if (!e.target.closest('.head')) return
  const id = item.project.id
  if (state.open.has(id)) state.open.delete(id)
  else {
    state.open.add(id)
    state.justOpened = id
    if (!state.votes.has(id)) loadVotes(item)
  }
  render()
  state.justOpened = null
})

// `toggle` does not bubble, so it is caught on the way down.
$('#groups').addEventListener(
  'toggle',
  (e) => {
    const id = e.target.dataset?.section
    if (!id) return
    if (e.target.open) state.openSections.add(id)
    else state.openSections.delete(id)
  },
  true,
)

$('#connect').addEventListener('click', onConnect)
$('#toggle-done').addEventListener('click', () => {
  state.showDone = !state.showDone
  writePref('showDone', state.showDone ? '1' : '0')
  render()
})

// A slow node can take longer than the interval; a tick that finds the last one
// still running is skipped rather than stacked behind it.
async function refresh(votesToo = false) {
  if (state.refreshing) return
  state.refreshing = true
  try {
    await loadChain()
    render()
    const loads = []
    for (const id of state.open) {
      const item = state.items.find((it) => it.project.id === id)
      if (item && (votesToo || state.votes.has(id))) loads.push(loadVotes(item, true))
    }
    await Promise.all(loads)
  } catch (err) {
    console.warn('[az] refresh', err)
    nodeDown()
  } finally {
    state.refreshing = false
  }
}

const REFRESH_MS = 10000

// A hidden tab does not poll; it catches up the moment it is shown again.
function autoRefresh() {
  setInterval(() => document.hidden || refresh(false), REFRESH_MS)
  document.addEventListener('visibilitychange', () => document.hidden || refresh(false))
}

/** The slow, complete list. Anything new is read by id from then on. */
async function discover() {
  try {
    const ids = await chain.ownerProjects(state.owner)
    const fresh = ids.filter((id) => !state.ids.has(id))
    for (const id of ids) state.ids.add(id)
    state.discovered = true
    if (fresh.length) await refresh(false)
    else render()
  } catch (err) {
    console.warn('[az] discovery', err)
    state.discovered = true
  }
}

async function start() {
  await loadIcons()
  try {
    state.meta = await (await fetch('projects.json', { cache: 'no-cache' })).json()
  } catch {
    /* chain data alone */
  }
  state.owner = new URLSearchParams(location.search).get('owner') || state.meta.owner
  const ownerLink = $('#owner')
  ownerLink.textContent = short(state.owner)
  ownerLink.title = state.owner
  ownerLink.href = `https://zenonhub.io/explorer/account/${state.owner}`
  if (state.owner === state.meta.owner) for (const id of Object.keys(state.meta.projects ?? {})) state.ids.add(id)
  discover()
  try {
    await loadChain()
  } catch (err) {
    nodeDown()
    setHtml('#groups', '<p class="dim">No node answered. Reload to try again.</p>')
    return
  }
  render()

  if (await wallet.ready()) {
    const s = await wallet.state()
    if (s.address) await setAccount(s)
    wallet.onChange(async () => setAccount(await wallet.state()))
  }
  autoRefresh()
}

start()
