require("dotenv").config()
const express = require("express")
const path = require("path")
const app = express()

// Cache largo para imágenes y assets estáticos (Supabase CDN)
app.use(express.static(path.join(__dirname, "/public"), {
  maxAge: '7d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/\.(jpg|jpeg|png|webp|gif|svg|ico|woff|woff2|ttf)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400')
    }
  }
}))
app.use(express.json({ limit: '10mb' }))

// Canonical domain redirect — si llegan a una URL de Vercel, redirigir al dominio propio
app.use((req, res, next) => {
  const host = req.headers.host || ''
  if (host.includes('.vercel.app')) {
    return res.redirect(301, 'https://soul-ecommlab.com' + req.url)
  }
  next()
})

// CORS para endpoints públicos llamados desde snippets embebidos en tiendas externas
app.use((req, res, next) => {
  const pub = ['/api/tn/subscribe', '/api/tn/track', '/api/tn/customer-panel', '/api/tn/customer-stats', '/api/tn/exchange-request', '/api/tn/manifest', '/api/tn/wa-otp-send', '/api/tn/wa-otp-verify', '/api/tn/store-analytics', '/api/tn/size-charts', '/api/tn/wishlist', '/api/tn/reviews', '/api/popup/subscribe', '/api/identity/journey', '/api/identity/track', '/api/store/me', '/api/store/capture-contact', '/api/tn/update-profile']
  if (pub.some(p => req.path.startsWith(p))) {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
  }
  next()
})

// Shared constants
const SUPA_URL = "https://vlkxtrqktdcfqmebrtwa.supabase.co"
const SUPA_KEY = () => process.env.SUPA_SERVICE_KEY || ""

// ── Caché de dominios propios → wsId ──────────────────────────
const _domainCache = new Map() // domain → { wsId, expiresAt }
const DOMAIN_CACHE_TTL = 60 * 60 * 1000 // 60 minutos — reducir fetches a Supabase
let _domainFetchPromise = null // dedup concurrent fetches (evita race condition en cold starts)

async function _wsIdByDomain(host) {
  const now = Date.now()
  const cached = _domainCache.get(host)
  if (cached && cached.expiresAt > now) return cached.wsId

  // Dedup: si ya hay un fetch en vuelo, esperar al mismo en vez de disparar otro
  if (_domainFetchPromise) {
    await _domainFetchPromise
    const c2 = _domainCache.get(host)
    if (c2 && c2.expiresAt > Date.now()) return c2.wsId
    return null
  }

  // Solo traer id + customDomain (campo anidado) — evita cargar todo el blob en memoria
  _domainFetchPromise = (async () => {
    try {
      const r = await fetch(
        `${SUPA_URL}/rest/v1/workspaces?select=id,customDomain:data->tienda->settings->>customDomain`,
        { headers: { "apikey": SUPA_KEY(), "Authorization": "Bearer " + SUPA_KEY() } }
      )
      const rows = await r.json()
      if (!Array.isArray(rows)) return
      for (const w of rows) {
        const d = (w.customDomain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase()
        if (d) _domainCache.set(d, { wsId: w.id, expiresAt: Date.now() + DOMAIN_CACHE_TTL })
      }
    } catch(e) { /* silencioso */ } finally {
      _domainFetchPromise = null
    }
  })()
  await _domainFetchPromise

  const c3 = _domainCache.get(host.toLowerCase())
  return c3?.wsId || null
}

// Middleware: detectar dominio propio y servir tienda con wsId inyectado
app.use(async (req, res, next) => {
  const host = req.hostname
  // Ignorar dominios propios del sistema
  if (!host || host === 'localhost' || host.endsWith('.vercel.app') || host === 'soul-ecommlab.com' || host.endsWith('.soul-ecommlab.com')) {
    return next()
  }
  const wsId = await _wsIdByDomain(host)
  if (!wsId) return next()

  // Servir tienda.html con wsId inyectado
  const fs = require('fs')
  const path = require('path')
  try {
    let html = fs.readFileSync(path.join(__dirname, 'views/tienda.html'), 'utf8')
    // Inyectar wsId como variable global antes del script principal
    html = html.replace(
      'const WS = P.get(\'ws\') || \'\'',
      `const WS = (typeof __VELDOS_WS__ !== 'undefined' ? __VELDOS_WS__ : null) || P.get('ws') || ''`
    )
    html = html.replace('<head>', `<head>\n<script>var __VELDOS_WS__='${wsId}';</script>`)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.send(html)
  } catch(e) {
    next()
  }
})

// ── Supabase REST helpers (tablas propias) ─────────────────────────────────────
function _sHdrs (extra = {}) {
  return { 'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(), 'Content-Type': 'application/json', ...extra }
}
async function _sGET (table, q = '') {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}${q ? '?' + q : ''}`, { headers: _sHdrs() })
  if (!r.ok) { const t = await r.text(); throw new Error(`sGET ${table}: ${r.status} ${t}`) }
  return r.json()
}
async function _sPOST (table, body, prefer = 'return=minimal') {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}`, { method: 'POST', headers: _sHdrs({ Prefer: prefer }), body: JSON.stringify(body) })
  if (!r.ok) { const t = await r.text(); throw new Error(`sPOST ${table}: ${r.status} ${t}`) }
  return prefer.includes('representation') ? r.json() : r.ok
}
async function _sPATCH (table, q, body) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${q}`, { method: 'PATCH', headers: _sHdrs({ Prefer: 'return=minimal' }), body: JSON.stringify(body) })
  if (!r.ok) { const t = await r.text(); throw new Error(`sPATCH ${table}: ${r.status} ${t}`) }
  return r.ok
}
async function _sDEL (table, q) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${q}`, { method: 'DELETE', headers: _sHdrs() })
  if (!r.ok) { const t = await r.text(); throw new Error(`sDEL ${table}: ${r.status} ${t}`) }
  return r.ok
}

// ── contacts table ─────────────────────────────────────────────────────────────
function _contactToRow (wsId, c) {
  const { id, nombre, email, tel, estado, etapa, canal, xp, cashback, tn_customer_id, tags, creado, ...rest } = c
  return {
    id: id || ('c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
    ws_id: wsId,
    nombre: nombre || '',
    email: email ? String(email).toLowerCase() : null,
    tel: tel || null,
    estado: estado || 'Lead',
    etapa: etapa || 'lead',
    canal: canal || null,
    xp: Number(xp) || 0,
    cashback: Number(cashback) || 0,
    tn_customer_id: tn_customer_id ? String(tn_customer_id) : null,
    tags: Array.isArray(tags) ? tags : [],
    data: rest,
    updated_at: new Date().toISOString()
  }
}
function _rowToContact (row) {
  if (!row) return null
  return { id: row.id, nombre: row.nombre || '', email: row.email || '', tel: row.tel || '', estado: row.estado || 'Lead', etapa: row.etapa || 'lead', canal: row.canal || '', xp: row.xp || 0, cashback: row.cashback || 0, tn_customer_id: row.tn_customer_id || null, tags: row.tags || [], creado: (row.created_at || '').slice(0, 10), ...(row.data || {}) }
}
async function db_findContact (wsId, { email, tel, tnId }) {
  let q = `ws_id=eq.${encodeURIComponent(wsId)}&limit=1`
  if (email) q += `&email=eq.${encodeURIComponent(String(email).toLowerCase())}`
  else if (tnId) q += `&tn_customer_id=eq.${encodeURIComponent(String(tnId))}`
  else if (tel) q += `&tel=eq.${encodeURIComponent(tel)}`
  else return null
  const rows = await _sGET('contacts', q)
  return rows?.[0] ? _rowToContact(rows[0]) : null
}
async function db_upsertContact (wsId, contact) {
  const row = _contactToRow(wsId, contact)
  return _sPOST('contacts', row, 'return=minimal,resolution=merge-duplicates')
}

// ── Atomically add a contactId to a named broadcast list in workspace ──
async function _addContactToList (wsId, listName, listId, contactId) {
  if (!contactId) return
  const ws = await getWorkspace(wsId)
  const data = ws?.data || {}
  if (!data.difListas) data.difListas = []
  const now = new Date().toISOString().slice(0, 10)
  let lista = data.difListas.find(l => l.id === listId || l.nombre === listName)
  if (!lista) {
    lista = { id: listId, nombre: listName, tipo: 'estatica', canal: 'ambos', filtros: {}, contactIds: [], creado: now, ultimaDifusion: null }
    data.difListas.push(lista)
  }
  if (!lista.contactIds) lista.contactIds = []
  if (!lista.contactIds.includes(contactId)) {
    lista.contactIds.push(contactId)
    await patchWorkspace(wsId, { difListas: data.difListas })
    _invalidateWsCache(wsId)
  }
}
function _genToken () {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) + '-' + Math.random().toString(36).slice(2, 7)
}
async function db_findContactByToken (wsId, token) {
  const q = `ws_id=eq.${encodeURIComponent(wsId)}&data->>vldToken=eq.${encodeURIComponent(token)}&limit=1`
  const rows = await _sGET('contacts', q)
  return rows?.[0] ? _rowToContact(rows[0]) : null
}
async function db_updateContactFields (wsId, id, fields) {
  const TOP_COLS = new Set(['nombre', 'email', 'tel', 'estado', 'etapa', 'canal', 'xp', 'cashback', 'tn_customer_id', 'tags'])
  const direct = { updated_at: new Date().toISOString() }
  const extra = {}
  for (const [k, v] of Object.entries(fields)) {
    if (TOP_COLS.has(k)) direct[k] = v
    else extra[k] = v
  }
  if (Object.keys(extra).length) {
    // Merge extra fields into data JSONB (read current first)
    const rows = await _sGET('contacts', `ws_id=eq.${encodeURIComponent(wsId)}&id=eq.${encodeURIComponent(id)}&select=data`)
    direct.data = { ...(rows?.[0]?.data || {}), ...extra }
  }
  return _sPATCH('contacts', `ws_id=eq.${encodeURIComponent(wsId)}&id=eq.${encodeURIComponent(id)}`, direct)
}
async function db_listContacts (wsId, { search, estado, limit = 500, offset = 0 } = {}) {
  let q = `ws_id=eq.${encodeURIComponent(wsId)}&order=created_at.desc&limit=${limit}&offset=${offset}`
  if (estado) q += `&estado=eq.${encodeURIComponent(estado)}`
  if (search) {
    const s = encodeURIComponent(search)
    q += `&or=(nombre.ilike.*${s}*,email.ilike.*${s}*,tel.ilike.*${s}*)`
  }
  const rows = await _sGET('contacts', q)
  return (rows || []).map(_rowToContact)
}
async function db_deleteContact (wsId, id) {
  return _sDEL('contacts', `ws_id=eq.${encodeURIComponent(wsId)}&id=eq.${encodeURIComponent(id)}`)
}

// ── orders table ────────────────────────────────────────────────────────────────
function _orderToRow (wsId, f) {
  const { id, email, tipo, categoria, concepto, monto, fecha, medioPago, tn_id, ...rest } = f
  return {
    id: id || ('ord_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
    ws_id: wsId,
    email: email ? String(email).toLowerCase() : null,
    tipo: tipo || 'ingreso',
    categoria: categoria || '',
    concepto: concepto || '',
    monto: Number(monto) || 0,
    fecha: fecha || null,
    medio_pago: medioPago || null,
    tn_id: tn_id ? String(tn_id) : null,
    data: rest
  }
}
function _rowToOrder (row) {
  if (!row) return null
  return { id: row.id, email: row.email || '', tipo: row.tipo || 'ingreso', categoria: row.categoria || '', concepto: row.concepto || '', monto: row.monto || 0, fecha: row.fecha || '', medioPago: row.medio_pago || '', tn_id: row.tn_id || null, ...(row.data || {}) }
}
async function db_insertOrder (wsId, order) {
  return _sPOST('orders', _orderToRow(wsId, order), 'return=minimal')
}
async function db_tnOrderExists (wsId, tnId) {
  const rows = await _sGET('orders', `ws_id=eq.${encodeURIComponent(wsId)}&tn_id=eq.${encodeURIComponent(String(tnId))}&limit=1`)
  return (rows?.length || 0) > 0
}
async function db_listOrders (wsId, { from, to, tipo, email, limit = 500, offset = 0 } = {}) {
  let q = `ws_id=eq.${encodeURIComponent(wsId)}&order=fecha.desc&limit=${limit}&offset=${offset}`
  if (from) q += `&fecha=gte.${from}`
  if (to) q += `&fecha=lte.${to}`
  if (tipo) q += `&tipo=eq.${encodeURIComponent(tipo)}`
  if (email) q += `&email=eq.${encodeURIComponent(String(email).toLowerCase())}`
  const rows = await _sGET('orders', q)
  return (rows || []).map(_rowToOrder)
}
async function db_deleteOrder (wsId, id) {
  return _sDEL('orders', `ws_id=eq.${encodeURIComponent(wsId)}&id=eq.${encodeURIComponent(id)}`)
}

// ── reviews table ───────────────────────────────────────────────────────────────
function _reviewToRow (wsId, r) {
  const { id, productId, productName, email, nombre, stars, texto, foto, foto_url, estado } = r
  return {
    id: id || ('rv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
    ws_id: wsId,
    product_id: productId || null,
    product_name: productName || '',
    email: email ? String(email).toLowerCase() : null,
    nombre: nombre || '',
    stars: Number(stars) || 5,
    texto: texto || '',
    foto_url: foto_url || null,  // solo URLs, nunca base64
    estado: estado || 'pending',
    updated_at: new Date().toISOString()
  }
}
function _rowToReview (row) {
  if (!row) return null
  return { id: row.id, productId: row.product_id || '', productName: row.product_name || '', email: row.email || '', nombre: row.nombre || '', stars: row.stars || 5, texto: row.texto || '', foto: row.foto_url || '', foto_url: row.foto_url || '', estado: row.estado || 'pending', createdAt: new Date(row.created_at).getTime() }
}
async function db_insertReview (wsId, review) {
  return _sPOST('reviews', _reviewToRow(wsId, review), 'return=minimal')
}
async function db_listReviews (wsId, { productId, estado, limit = 200, offset = 0 } = {}) {
  let q = `ws_id=eq.${encodeURIComponent(wsId)}&order=created_at.desc&limit=${limit}&offset=${offset}`
  if (productId) q += `&product_id=eq.${encodeURIComponent(productId)}`
  if (estado) q += `&estado=eq.${encodeURIComponent(estado)}`
  const rows = await _sGET('reviews', q)
  return (rows || []).map(_rowToReview)
}
async function db_updateReview (wsId, id, fields) {
  const mapped = { updated_at: new Date().toISOString() }
  if (fields.estado !== undefined) mapped.estado = fields.estado
  if (fields.texto !== undefined) mapped.texto = fields.texto
  if (fields.nombre !== undefined) mapped.nombre = fields.nombre
  if (fields.stars !== undefined) mapped.stars = Number(fields.stars)
  if (fields.foto_url !== undefined) mapped.foto_url = fields.foto_url || null
  if (fields.fecha != null) {
    // fecha viene como timestamp ms desde el frontend
    const d = new Date(Number(fields.fecha))
    if (!isNaN(d)) mapped.created_at = d.toISOString()
  }
  return _sPATCH('reviews', `ws_id=eq.${encodeURIComponent(wsId)}&id=eq.${encodeURIComponent(id)}`, mapped)
}
async function db_deleteReview (wsId, id) {
  return _sDEL('reviews', `ws_id=eq.${encodeURIComponent(wsId)}&id=eq.${encodeURIComponent(id)}`)
}

// ── flow_log table ──────────────────────────────────────────────────────────────
async function db_flowKeyExists (wsId, flowKey) {
  const rows = await _sGET('flow_log', `ws_id=eq.${encodeURIComponent(wsId)}&flow_key=eq.${encodeURIComponent(flowKey)}&limit=1`)
  return (rows?.length || 0) > 0
}
async function db_insertFlowLog (wsId, entry) {
  return _sPOST('flow_log', {
    id: entry.id || ('fl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
    ws_id: wsId,
    flow_id: entry.flowId || null,
    flow_name: entry.flowName || null,
    flow_key: entry.flowKey || null,
    contact_id: entry.contactId || null,
    email: entry.email || null,
    tel: entry.tel || null,
    channel: entry.channel || null,
    status: entry.status || 'sent',
    message: entry.message ? String(entry.message).slice(0, 500) : null,
    data: entry.data || {}
  }, 'return=minimal')
}
async function db_listFlowLog (wsId, { limit = 200, offset = 0 } = {}) {
  const rows = await _sGET('flow_log', `ws_id=eq.${encodeURIComponent(wsId)}&order=created_at.desc&limit=${limit}&offset=${offset}`)
  return rows || []
}
async function db_getFlowDoneKeys (wsId) {
  // Carga todas las flow_keys completadas para un workspace (para el cron)
  const rows = await _sGET('flow_log', `ws_id=eq.${encodeURIComponent(wsId)}&select=flow_key&flow_key=not.is.null&limit=10000`)
  const s = new Set()
  for (const r of (rows || [])) if (r.flow_key) s.add(r.flow_key)
  return s
}

// Mercado Pago
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "TEST-PLACEHOLDER"

// Meta OAuth
const META_APP_ID     = () => (process.env.META_APP_ID     || "").trim()
const META_APP_SECRET = () => (process.env.META_APP_SECRET || "").trim()
const APP_BASE_URL    = () => (process.env.APP_BASE_URL    || "http://localhost:3000").trim()

// Landing page
app.get("/landing", (req, res) => {
  res.sendFile(__dirname + "/views/landing.html")
})

// Crealo — landing pública de generador de videos UGC
app.get("/crealo", serveApp)

// Sistema principal — redirect legacy /sistema to root
app.get("/sistema", (req, res) => {
  res.redirect(301, "/")
})
const NO_CACHE = { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' } }

function serveApp(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
  res.sendFile(__dirname + "/views/index.html")
}

app.get("/", serveApp)


// MP: crear preferencia de pago
app.post("/api/mp/create-preference", async (req, res) => {
  const { email, userId } = req.body
  try {
    const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + MP_ACCESS_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        items: [{
          title: "Soul eCommlab — Suscripción mensual",
          quantity: 1,
          unit_price: 89000,
          currency_id: "ARS"
        }],
        payer: { email: email || "" },
        back_urls: {
          success: process.env.BASE_URL + "/api/mp/success",
          failure: process.env.BASE_URL + "/",
          pending: process.env.BASE_URL + "/"
        },
        auto_return: "approved",
        external_reference: userId || "",
        notification_url: process.env.BASE_URL + "/api/mp/webhook"
      })
    })
    const data = await mpRes.json()
    res.json({ init_point: data.init_point || data.sandbox_init_point })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// MP: webhook
app.post("/api/mp/webhook", async (req, res) => {
  const { type, data } = req.body
  if (type === "payment") {
    try {
      const pmtRes = await fetch("https://api.mercadopago.com/v1/payments/" + data.id, {
        headers: { "Authorization": "Bearer " + MP_ACCESS_TOKEN }
      })
      const pmt = await pmtRes.json()
      if (pmt.status === "approved" && pmt.external_reference) {
        const subEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        await fetch(SUPA_URL + "/rest/v1/user_subscriptions?id=eq." + pmt.external_reference, {
          method: "PATCH",
          headers: {
            "apikey": SUPA_KEY(),
            "Authorization": "Bearer " + SUPA_KEY(),
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ plan: "active", subscription_ends_at: subEnd })
        })
      }
    } catch (e) { console.error("Webhook error:", e) }
  }
  res.sendStatus(200)
})

// MP: success redirect
app.get("/api/mp/success", (req, res) => {
  res.redirect("/?payment=success")
})

// ── Tienda Nube ──────────────────────────────────────────────────────────────
const TN_CLIENT_ID     = process.env.TN_CLIENT_ID     || "31250"
const TN_CLIENT_SECRET = process.env.TN_CLIENT_SECRET || "747a564acf2fad835b6021e2928b5af84743f706b91c5643"

// ── Caché en memoria para getWorkspace ───────────────────────────
// Vercel serverless: cada lambda es una instancia separada, pero dentro de
// la misma instancia caliente pueden llegar múltiples requests. TTL corto
// evita docenas de round-trips a Supabase bajo carga.
const _wsCache = new Map() // wsId → { ws, expiresAt }
const WS_CACHE_TTL = 8000  // 8 segundos

function _invalidateWsCache(wsId) {
  _wsCache.delete(wsId)
}

async function getWorkspace(wsId) {
  const now = Date.now()
  const cached = _wsCache.get(wsId)
  if (cached && cached.expiresAt > now) return cached.ws

  const r = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}&select=id,data`, {
    headers: { "apikey": SUPA_KEY(), "Authorization": "Bearer " + SUPA_KEY() }
  })
  // Proteger contra respuestas no-JSON (ej: HTML de rate-limit de Supabase)
  const text = await r.text()
  let rows
  try { rows = JSON.parse(text) } catch(e) {
    throw new Error(`Supabase respuesta inesperada (${r.status}): ${text.slice(0,120)}`)
  }
  const ws = rows?.[0] || null
  if (ws) _wsCache.set(wsId, { ws, expiresAt: now + WS_CACHE_TTL })
  return ws
}

// Helper: patch workspace data in Supabase — merge-safe para ordenes y CRM
async function patchWorkspace(wsId, data, fullRow = null) {
  _invalidateWsCache(wsId)

  // Leer estado actual del servidor para mergear campos críticos
  try {
    const current = await getWorkspace(wsId)
    const cur = current?.data || {}

    // ── BASE: empezar con el estado COMPLETO del servidor, luego aplicar el patch encima ──
    // Esto garantiza que nunca se pierda ningún campo (finCfg, stock, todos, etc.)
    // aunque el caller solo pase un subset como { crm } o { crm, finanzas }
    data = { ...cur, ...data }

    // ── Merge tienda.ordenes: preservar órdenes del servidor que el cliente no tiene ──
    if (cur.tienda?.ordenes?.length) {
      const clientOrdenes = data.tienda?.ordenes || []
      const clientIds = new Set(clientOrdenes.map(o => o.id))
      const serverOnly = cur.tienda.ordenes.filter(o => !clientIds.has(o.id))
      if (serverOnly.length) {
        if (!data.tienda) data.tienda = {}
        data.tienda.ordenes = [...clientOrdenes, ...serverOnly]
      }
    }

    // CRM, finanzas, flowDone, flowHistory → en tablas propias — no mergear en el blob

    // ── Guard flows: merge por ID — preservar flows del servidor que el cliente no tiene,
    //    excepto los que el cliente marcó como eliminados explícitamente ──
    if (cur.flows?.length) {
      const deletedIds = new Set(data.deletedFlowIds || [])
      const clientFlowIds = new Set((data.flows || []).map(f => f.id).filter(Boolean))
      const serverOnlyFlows = cur.flows.filter(f => f.id && !clientFlowIds.has(f.id) && !deletedIds.has(f.id))
      if (serverOnlyFlows.length) {
        data.flows = [...(data.flows || []), ...serverOnlyFlows]
      }
    }

    // ── Guard emailTemplates: merge por id, nunca perder plantillas ──
    if (cur.emailTemplates?.length) {
      const clientTplIds = new Set((data.emailTemplates || []).map(t => t.id).filter(Boolean))
      const serverOnlyTpls = cur.emailTemplates.filter(t => t.id && !clientTplIds.has(t.id))
      if (serverOnlyTpls.length) {
        data.emailTemplates = [...(data.emailTemplates || []), ...serverOnlyTpls]
      }
    }

    // ── Guard difListas: nunca perder listas de difusión guardadas ──
    if (cur.difListas?.length && !data.difListas?.length) {
      data.difListas = cur.difListas
    } else if (cur.difListas?.length && data.difListas?.length) {
      // Merge por id: preservar listas del servidor que el cliente no tiene
      const clientIds = new Set(data.difListas.map(l => l.id).filter(Boolean))
      const serverOnly = cur.difListas.filter(l => l.id && !clientIds.has(l.id))
      if (serverOnly.length) data.difListas = [...data.difListas, ...serverOnly]
    }

    // ── Guard tokens: nunca perder sesiones activas en un save del admin ──
    if (cur.tokens && typeof cur.tokens === 'object' && Object.keys(cur.tokens).length) {
      if (!data.tokens || typeof data.tokens !== 'object') data.tokens = {}
      // Merge: server tokens que el cliente no tiene
      for (const [tok, entry] of Object.entries(cur.tokens)) {
        if (!(tok in data.tokens)) data.tokens[tok] = entry
      }
    }

    // ── Guard tienda.productos: nunca sobreescribir productos existentes con array vacío/ausente ──
    // Si el save no incluye productos (ej: guardar solo settings/config), preservar los del servidor.
    if (cur.tienda?.productos?.length) {
      if (!data.tienda) data.tienda = {}
      if (!data.tienda.productos?.length) {
        data.tienda.productos = cur.tienda.productos
      } else {
        // Merge por ID: preservar productos del servidor que el cliente no incluyó
        const clientProdIds = new Set(data.tienda.productos.map(p => p.id).filter(Boolean))
        const serverOnlyProds = cur.tienda.productos.filter(p => p.id && !clientProdIds.has(p.id))
        if (serverOnlyProds.length) {
          data.tienda.productos = [...data.tienda.productos, ...serverOnlyProds]
        }
      }
    }

    // ── Guard tienda.secciones: preservar secciones si el save no las incluye ──
    if (cur.tienda?.secciones?.length && !data.tienda?.secciones?.length) {
      if (!data.tienda) data.tienda = {}
      data.tienda.secciones = cur.tienda.secciones
    }

    // ── Guard tienda.settings: deep-merge para no perder configuraciones (ej: payway, popup) ──
    if (cur.tienda?.settings && Object.keys(cur.tienda.settings).length) {
      if (!data.tienda) data.tienda = {}
      if (!data.tienda.settings || !Object.keys(data.tienda.settings).length) {
        data.tienda.settings = cur.tienda.settings
      } else {
        data.tienda.settings = { ...cur.tienda.settings, ...data.tienda.settings }
      }
    }

    // ── Guard pendingPaywayOrders: preservar órdenes pendientes del servidor ──
    if (cur.pendingPaywayOrders && Object.keys(cur.pendingPaywayOrders).length) {
      if (!data.pendingPaywayOrders) data.pendingPaywayOrders = {}
      for (const [k, v] of Object.entries(cur.pendingPaywayOrders)) {
        if (!(k in data.pendingPaywayOrders)) data.pendingPaywayOrders[k] = v
      }
    }
  } catch(e) { /* si falla el merge, continuar con el guardado normal */ }

  // ── Trim server-side — Supabase también tiene límites de tamaño por fila ──
  const _srvByteSize = s => Buffer.byteLength(JSON.stringify(s), 'utf8')
  const SRV_TARGET = 4_000_000 // 4 MB

  // Tokens: purgar expirados (el objeto crece sin límite con sesiones viejas)
  if (data.tokens && typeof data.tokens === 'object') {
    const now = Date.now()
    const cleaned = {}
    for (const [k, v] of Object.entries(data.tokens)) {
      if (v && v.expiresAt && v.expiresAt > now) cleaned[k] = v
    }
    // Si todos expirararon o no tienen expiresAt, guardar a lo sumo los 50 más recientes
    const validEntries = Object.entries(cleaned)
    if (validEntries.length === 0) {
      // fallback: mantener los 50 más recientes sin importar expiración
      const all = Object.entries(data.tokens)
      all.sort((a,b) => (b[1]?.createdAt||0) - (a[1]?.createdAt||0))
      data.tokens = Object.fromEntries(all.slice(0, 50))
    } else {
      data.tokens = cleaned
    }
  }

  // CRM, finanzas, reviews, flowDone, flowHistory → en tablas propias — vaciar del blob
  data.crm = []
  data.finanzas = []
  data.reviews = []
  data.flowDone = {}
  data.flowHistory = []

  if (data.tienda && Array.isArray(data.tienda.ordenes) && data.tienda.ordenes.length > 500)
    data.tienda.ordenes = data.tienda.ordenes.slice(-500)
  if (Array.isArray(data.waLog)  && data.waLog.length  > 200)  data.waLog  = data.waLog.slice(-200)
  if (Array.isArray(data.difLog) && data.difLog.length > 200)  data.difLog = data.difLog.slice(-200)

  // When a full row is available (e.g. new workspace creation), include all columns so the
  // INSERT succeeds. For data-only saves the row already exists so partial body is fine.
  const supaBody = fullRow ? { ...fullRow, data } : { id: wsId, data }

  const saveRes = await fetch(`${SUPA_URL}/rest/v1/workspaces`, {
    method: "POST",
    headers: {
      "apikey": SUPA_KEY(), "Authorization": "Bearer " + SUPA_KEY(),
      "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(supaBody)
  })
  if (!saveRes.ok) {
    const errText = await saveRes.text().catch(() => '')
    console.error(`[patchWorkspace] Save failed for ${wsId}: ${saveRes.status} ${errText.slice(0, 200)}`)
    throw new Error(`Supabase save failed (${saveRes.status}): ${errText.slice(0, 120)}`)
  }
}

// Step 1: Redirect user to TN OAuth page with wsId in state
// The `store` param is the subdomain (e.g. "mitienda" from mitienda.mitiendanube.com)
app.get("/api/tn/connect", (req, res) => {
  const { wsId, store } = req.query
  if (!wsId) return res.status(400).send("<h2>Error: wsId requerido</h2>")
  if (!store) return res.status(400).send("<h2>Error: subdominio de tienda requerido</h2>")
  // Redirect directly to the store's admin authorization page with required scopes
  const scope = "read_orders read_customers write_products"
  const authUrl = `https://${store}.mitiendanube.com/admin/apps/${TN_CLIENT_ID}/authorize?scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(wsId)}`
  res.redirect(authUrl)
})

// Step 2: OAuth callback — exchange code, store credentials in workspace
app.get("/api/tn/callback", async (req, res) => {
  const { code, state: wsId } = req.query
  if (!code) return res.send("<h2>Error: no se recibió código de autorización</h2>")
  try {
    const r = await fetch("https://www.tiendanube.com/apps/authorize/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: TN_CLIENT_ID,
        client_secret: TN_CLIENT_SECRET,
        grant_type: "authorization_code",
        code
      })
    })
    const data = await r.json()
    if (!data.access_token) return res.send(`<h2>Error al obtener token: ${JSON.stringify(data)}</h2>`)

    // If we have a wsId, store credentials in that workspace
    if (wsId) {
      const ws = await getWorkspace(wsId)
      if (ws) {
        // Try to fetch store name from TN API
        let storeName = ""
        try {
          const sRes = await fetch(`https://api.tiendanube.com/v1/${data.user_id}/store`, {
            headers: { "Authentication": `bearer ${data.access_token}`, "User-Agent": "Soul eCommlab (soporte@veldos.app)" }
          })
          if (sRes.ok) {
            const sData = await sRes.json()
            storeName = (sData.name?.es || sData.name?.pt || Object.values(sData.name||{})[0] || "").slice(0,60)
          }
        } catch(e) { /* ignore, storeName stays empty */ }

        const wsData = { ...(ws.data || {}), tnIntegration: {
          storeId: String(data.user_id),
          token: data.access_token,
          storeName,
          connectedAt: new Date().toISOString()
        }}
        await patchWorkspace(wsId, wsData)
        return res.redirect("/?tn_connected=" + encodeURIComponent(wsId))
      }
    }

    // Fallback: show token (shouldn't happen in normal flow)
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:system-ui;max-width:600px;margin:60px auto;padding:0 24px;color:#222}
      .token{background:#f5f5f5;padding:16px;border-radius:8px;word-break:break-all;font-family:monospace;font-size:13px}
      .ok{color:#4db88a;font-size:20px;font-weight:700}
    </style></head><body>
      <div class="ok">✅ Token generado con éxito</div>
      <p>Store ID: <strong>${data.user_id}</strong></p>
      <p>Access token:</p>
      <div class="token">${data.access_token}</div>
      <p style="margin-top:24px"><a href="/">← Volver a Soul eCommlab</a></p>
    </body></html>`)
  } catch(e) {
    res.send(`<h2>Error: ${e.message}</h2>`)
  }
})

app.get("/api/tn/orders", async (req, res) => {
  const { desde, hasta, wsId } = req.query
  try {
    // Get workspace-specific credentials
    if (!wsId) return res.status(400).json({ error: "wsId requerido" })
    const ws = await getWorkspace(wsId)
    const tn = ws?.data?.tnIntegration
    if (!tn?.token) return res.status(400).json({ error: "Tienda Nube no conectada en este proyecto" })
    const { storeId, token } = tn

    const headers = {
      "Authentication": `bearer ${token}`,
      "User-Agent": "Soul eCommlab (soporte@veldos.app)"
    }

    // Fetch ALL pages until TN returns fewer than per_page results
    const PER_PAGE = 200
    let allOrders = []
    let page = 1
    while (true) {
      const params = new URLSearchParams({ per_page: PER_PAGE, page })
      if (desde) params.set("created_at_min", new Date(desde).toISOString())
      if (hasta) params.set("created_at_max", new Date(hasta + "T23:59:59").toISOString())

      const url = `https://api.tiendanube.com/v1/${storeId}/orders?${params}`
      const r = await fetch(url, { headers })

      if (r.status === 404) break // no more orders
      if (r.status === 401) return res.status(401).json({ error: 'TOKEN_INVALIDO', message: 'El token de Tienda Nube es inválido o fue revocado. Desconectá y volvé a conectar la tienda desde Integraciones.' })
      if (!r.ok) {
        const txt = await r.text()
        return res.status(r.status).json({ error: txt })
      }

      const data = await r.json()
      const batch = Array.isArray(data) ? data : []
      allOrders = allOrders.concat(batch)

      if (batch.length < PER_PAGE) break // last page
      page++
      if (page > 50) break // safety cap: 10 000 orders max
    }

    // Filter to paid orders only
    const paid = allOrders.filter(o => {
      const ps = (o.payment_status || "").toLowerCase()
      const fs = (o.financial_status || "").toLowerCase()
      return ps === "paid" || fs === "paid" || ps === "authorized" || fs === "authorized"
    })
    res.json(paid)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Traer todos los productos de TN con sus variantes (incluye cost) — usado para mapear
// COGS al importar órdenes. Pagina hasta agotar.
// Devuelve array compacto: [{ id, name, sku, variants:[{id, sku, cost, price}] }]
app.get("/api/tn/products", async (req, res) => {
  const { wsId } = req.query
  try {
    if (!wsId) return res.status(400).json({ error: "wsId requerido" })
    const ws = await getWorkspace(wsId)
    const tn = ws?.data?.tnIntegration
    if (!tn?.token) return res.status(400).json({ error: "Tienda Nube no conectada en este proyecto" })
    const { storeId, token } = tn

    const headers = {
      "Authentication": `bearer ${token}`,
      "User-Agent": "Soul eCommlab (soporte@veldos.app)"
    }
    const PER_PAGE = 200
    let all = []
    let page = 1
    while (true) {
      const url = `https://api.tiendanube.com/v1/${storeId}/products?per_page=${PER_PAGE}&page=${page}&fields=id,name,variants`
      const r = await fetch(url, { headers })
      if (r.status === 404) break
      if (!r.ok) {
        const txt = await r.text()
        return res.status(r.status).json({ error: txt })
      }
      const data = await r.json()
      const batch = Array.isArray(data) ? data : []
      all = all.concat(batch)
      if (batch.length < PER_PAGE) break
      page++
      if (page > 100) break // safety: hasta 20 000 productos
    }
    const compact = all.map(p => ({
      id: p.id,
      name: typeof p.name === "object" ? (p.name.es || p.name.pt || Object.values(p.name||{})[0] || "") : (p.name || ""),
      image: Array.isArray(p.images) && p.images.length ? (p.images[0].src || p.images[0].url || '') : '',
      permalink: p.permalink || '',
      variants: (p.variants || []).map(v => ({
        id: v.id,
        sku: v.sku || "",
        cost: v.cost != null ? Number(v.cost) : null,
        price: v.price != null ? Number(v.price) : null,
        stock: v.stock != null ? Number(v.stock) : null,
        values: Array.isArray(v.values) ? v.values.map(val => typeof val === 'object' ? (val.es || val.pt || Object.values(val||{})[0] || '') : String(val)) : []
      }))
    }))
    res.json(compact)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Actualizar stock y/o costo de una variante en TN
app.patch('/api/tn/products/:productId/variants/:variantId', async (req, res) => {
  const { wsId } = req.query
  const { productId, variantId } = req.params
  if (!wsId) return res.status(400).json({ error: 'wsId requerido' })
  try {
    const ws = await getWorkspace(wsId)
    const tn = ws?.data?.tnIntegration
    if (!tn?.token) return res.status(400).json({ error: 'Tienda Nube no conectada' })
    const { storeId, token } = tn
    const allowed = {}
    if (req.body.stock != null) allowed.stock = Number(req.body.stock)
    if (req.body.cost != null) allowed.cost = Number(req.body.cost)
    if (!Object.keys(allowed).length) return res.status(400).json({ error: 'Nada para actualizar' })
    const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/products/${productId}/variants/${variantId}`, {
      method: 'PUT',
      headers: { 'Authentication': `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'Soul eCommlab (soporte@veldos.app)' },
      body: JSON.stringify(allowed)
    })
    const body = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: body })
    res.json({ ok: true, variant: { id: body.id, stock: body.stock, cost: body.cost } })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Debug: estado webhooks y envío
app.get("/api/tn/debug-shipping", async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: "wsId requerido" })
  try {
    const ws = await getWorkspace(wsId)
    const tn = ws?.data?.tnIntegration
    if (!tn?.token) return res.status(400).json({ error: "TN no conectada" })
    const headers = { "Authentication": `bearer ${tn.token}`, "User-Agent": "Soul eCommlab (soporte@veldos.app)" }
    const [wbRes, ordRes] = await Promise.all([
      fetch(`https://api.tiendanube.com/v1/${tn.storeId}/webhooks`, { headers }),
      fetch(`https://api.tiendanube.com/v1/${tn.storeId}/orders?per_page=1&page=1`, { headers })
    ])
    const webhooks = await wbRes.json()
    const orders = await ordRes.json()
    const o = Array.isArray(orders) ? orders[0] : orders
    res.json({
      tnWebhookActive: ws.data?.tnWebhookActive,
      storeId: tn.storeId,
      webhooks,
      firstOrder: o ? { number: o.number, total: o.total, subtotal: o.subtotal, shipping_cost_customer: o.shipping_cost_customer, shipping_cost_owner: o.shipping_cost_owner } : null
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Register TN webhooks for a specific workspace
app.post("/api/tn/activate", async (req, res) => {
  const { wsId } = req.body
  if (!wsId) return res.status(400).json({ error: "wsId required" })
  try {
    const ws = await getWorkspace(wsId)
    const tn = ws?.data?.tnIntegration
    if (!tn?.token) return res.status(400).json({ error: "Tienda Nube no conectada en este proyecto" })

    const baseUrl = (process.env.BASE_URL || "https://soul-ecommlab.com").replace(/\/$/, '')
    const webhookUrl = baseUrl + "/api/tn/webhook"
    const tnHeaders = {
      "Authentication": `bearer ${tn.token}`,
      "User-Agent": "Soul eCommlab (soporte@veldos.app)",
      "Content-Type": "application/json"
    }
    const TOPICS = ["order/paid", "cart/updated", "customer/created"]

    // Eliminar webhooks existentes de VELDOS para evitar duplicados
    const existingRes = await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/webhooks`, { headers: tnHeaders })
    const existing = await existingRes.json()
    if (Array.isArray(existing)) {
      for (const wh of existing) {
        if (TOPICS.includes(wh.event) || wh.url.includes('/api/tn/webhook')) {
          await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/webhooks/${wh.id}`, { method: "DELETE", headers: tnHeaders })
        }
      }
    }

    // Registrar todos los topics
    for (const topic of TOPICS) {
      await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/webhooks`, {
        method: "POST", headers: tnHeaders,
        body: JSON.stringify({ event: topic, url: webhookUrl })
      })
    }

    // Save tnWebhookActive flag in workspace data
    const wsData = { ...(ws.data || {}), tnWebhookActive: true }
    await patchWorkspace(wsId, wsData)
    res.json({ ok: true, webhookUrl, topics: TOPICS })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// TN webhook — maneja order/paid, cart/updated, customer/created
app.post("/api/tn/webhook", async (req, res) => {
  res.sendStatus(200) // Responder inmediatamente a TN
  const { event, store_id: webhookStoreId, id: entityId } = req.body
  console.log(`[webhook] ${event} | store=${webhookStoreId} | id=${entityId}`)
  const HANDLED = ["order/paid", "cart/updated", "customer/created"]
  if (!HANDLED.includes(event) || !entityId) return
  try {
    // Cargar solo config del workspace (sin crm/finanzas) — mucho menos memoria
    const wsRes = await fetch(
      `${SUPA_URL}/rest/v1/workspaces?select=id,tnWebhookActive:data->>tnWebhookActive,tnIntegration:data->tnIntegration,processedTnOrders:data->processedTnOrders,flows:data->flows,waProviders:data->waProviders,waConfig:data->waConfig,store:data->store,tienda:data->tienda`,
      { headers: { "apikey": SUPA_KEY(), "Authorization": "Bearer " + SUPA_KEY() } }
    )
    const allWs = await wsRes.json()
    const target = (allWs || []).find(w =>
      w.tnWebhookActive === 'true' && w.tnIntegration &&
      (!webhookStoreId || String(w.tnIntegration.storeId) === String(webhookStoreId))
    ) || (allWs || []).find(w => w.tnWebhookActive === 'true' && w.tnIntegration)
    if (!target) return

    const tn = target.tnIntegration
    const tnHeaders = { "Authentication": `bearer ${tn.token}`, "User-Agent": "Soul eCommlab (soporte@veldos.app)" }
    // Fake data object con solo lo necesario para _processImmediateFlows (flows + WA config)
    const cfgData = { flows: target.flows || [], waProviders: target.waProviders || [], waConfig: target.waConfig || {}, store: target.store || {}, tienda: target.tienda || {} }
    const today = new Date().toISOString().slice(0, 10)

    // ── cart/updated → carrito abandonado ────────────────────────────────────
    if (event === "cart/updated") {
      const cartRes = await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/carts/${entityId}`, { headers: tnHeaders })
      if (!cartRes.ok) return
      const cart = await cartRes.json()
      const cust = cart.customer
      if (!cust) return
      const email = (cust.email || '').toLowerCase()
      const phone = cust.phone || ''
      if (!email && !phone) return
      const items = (cart.products || []).map(p => ({ nombre: p.name?.es || p.name || '', precio: parseFloat(p.price) || 0, qty: p.quantity || 1 }))
      const total = parseFloat(cart.prices?.total || cart.subtotal || 0)
      // Buscar en DB y actualizar o crear
      let contact = await db_findContact(target.id, { email, tnId: cust.id })
      if (!contact && phone) contact = await db_findContact(target.id, { tel: phone })
      if (contact) {
        await db_updateContactFields(target.id, contact.id, { carritoAbandonado: true, cartDate: today, valorAbandonado: total, ultimoCarritoItems: items, ...(phone && !contact.tel ? { tel: phone } : {}) })
      } else {
        await db_upsertContact(target.id, {
          id: 'c_tn_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
          nombre: `${cust.name || ''} ${cust.surname || ''}`.trim() || 'Cliente TN',
          email, tel: phone, estado: 'Lead', etapa: 'lead', canal: 'Tienda Nube',
          carritoAbandonado: true, cartDate: today, valorAbandonado: total, ultimoCarritoItems: items, creado: today, tn_customer_id: cust.id
        })
      }
      return
    }

    // ── customer/created → nuevo lead ────────────────────────────────────────
    if (event === "customer/created") {
      const custRes = await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/customers/${entityId}`, { headers: tnHeaders })
      if (!custRes.ok) return
      const cust = await custRes.json()
      const email = (cust.email || '').toLowerCase()
      const phone = cust.phone || ''
      if (!email && !phone) return
      // Verificar si ya existe
      let existing = await db_findContact(target.id, { email })
      if (!existing && phone) existing = await db_findContact(target.id, { tel: phone })
      if (existing) return
      const newContact = {
        id: 'c_tn_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
        nombre: `${cust.name || ''} ${cust.surname || ''}`.trim() || 'Cliente TN',
        email, tel: phone, estado: 'Lead', etapa: 'lead', canal: 'Tienda Nube', creado: today, tn_customer_id: cust.id
      }
      await db_upsertContact(target.id, newContact)
      _addContactToList(target.id, 'Clientes TN', 'dl_clientes_tn', newContact.id).catch(() => {})
      _processImmediateFlows(target.id, cfgData, newContact, ['new_lead'], {}).catch(e => console.error('[flows] TN customer/created:', e.message))
      return
    }

    // ── order/paid → importar venta ───────────────────────────────────────────
    const oRes = await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/orders/${entityId}`, { headers: tnHeaders })
    if (!oRes.ok) return
    const o = await oRes.json()

    // Dedup con DB — rápido y sin race condition
    const orderId = String(o.id)
    const processedArr = Array.isArray(target.processedTnOrders) ? target.processedTnOrders : []
    const alreadyInBlob = processedArr.includes(orderId)
    const alreadyInDB = !alreadyInBlob && await db_tnOrderExists(target.id, orderId)
    if (alreadyInBlob || alreadyInDB) return

    // Marcar como procesado en el blob (array pequeño, solo para hot-path)
    const newProcessed = [...processedArr, orderId].slice(-1000)
    const wsForPatch = await getWorkspace(target.id)
    if (wsForPatch?.data) {
      wsForPatch.data.processedTnOrders = newProcessed
      patchWorkspace(target.id, wsForPatch.data).catch(e => console.warn('[webhook] No se pudo actualizar processedTnOrders:', e.message))
      _invalidateWsCache(target.id)
    }

    const g = (o.gateway || "").toLowerCase()
    const medioPago = g.includes("mercado") ? "Mercado Pago" : g.includes("nuvem") || g.includes("nube") ? "Pago Nube" : g.includes("transfer") ? "transferencia" : g.includes("cash") || g.includes("efectivo") ? "Efectivo" : o.gateway || "Otro"
    const fecha = (o.created_at || "").slice(0, 10)
    const cliente = o.customer?.name || o.customer?.email || "Cliente TN"
    const productos = (o.products || []).map(p => p.name).join(", ") || "Venta"
    const envioMonto = parseFloat(o.shipping_cost_customer || o.shipping_cost_owner || 0)

    // Insertar ingreso en orders table
    await db_insertOrder(target.id, {
      tipo: "ingreso", fecha, concepto: `TN #${o.number} — ${cliente}`,
      categoria: "Ventas tienda", monto: parseFloat(o.total) || 0,
      medioPago, cuotas: 1,
      unidades: (o.products || []).reduce((a, p) => a + (p.quantity || 1), 0),
      notas: productos, tn_id: o.id, tn_number: o.number, tn_envio: envioMonto,
      email: (o.customer?.email || '').toLowerCase()
    })
    if (envioMonto > 0) {
      await db_insertOrder(target.id, { tipo: "gasto", fecha, concepto: `Envío TN #${o.number}`, categoria: "Envíos", monto: envioMonto, medioPago, tn_id: `${o.id}_envio` })
    }
    const comisionPct = medioPago === "Mercado Pago" ? 6.29 : medioPago === "Pago Nube" ? 2.5 : 0
    const comisionMonto = comisionPct > 0 ? Math.round((parseFloat(o.total) || 0) * comisionPct / 100) : 0
    if (comisionMonto > 0) {
      await db_insertOrder(target.id, { tipo: "gasto", fecha, concepto: `Comisión TN #${o.number}`, categoria: "Comisiones", monto: comisionMonto, medioPago, tn_id: `${o.id}_com` })
    }

    // CRM upsert atómico en DB — sin race condition
    let crmContact = null
    if (o.customer) {
      const email = (o.customer.email || '').toLowerCase()
      crmContact = await db_findContact(target.id, { email }) || await db_findContact(target.id, { tnId: o.customer.id })
      const monto = parseFloat(o.total) || 0
      if (crmContact) {
        await db_updateContactFields(target.id, crmContact.id, {
          valor: (parseFloat(crmContact.valor) || 0) + monto,
          valorTotal: (parseFloat(crmContact.valorTotal) || 0) + monto,
          cantCompras: (parseInt(crmContact.cantCompras) || 0) + 1,
          ultimaCompra: fecha, ultimoPedido: o.number || '',
          ultimoProducto: (o.products || []).map(p => p.name).join(', ').slice(0, 80) || '',
          etapa: crmContact.etapa || 'cliente', carritoAbandonado: false, cartDate: null,
          ...(o.customer.phone && !crmContact.tel ? { tel: o.customer.phone } : {})
        })
        crmContact = { ...crmContact, ultimaCompra: fecha }
      } else {
        crmContact = {
          id: 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
          nombre: o.customer.name || "Cliente TN", email, tel: o.customer.phone || "",
          estado: "Cliente", etapa: "cliente", valor: monto, valorTotal: monto,
          ultimaCompra: fecha, cantCompras: 1, canal: "Tienda Nube",
          ciudad: o.shipping_address?.city || "", provincia: o.shipping_address?.province || "",
          tags: ["tiendanube"], creado: today, tn_customer_id: o.customer.id
        }
        await db_upsertContact(target.id, crmContact)
      }
    }

    // Disparar flows inmediatos
    if (crmContact) {
      const lineas = (o.products || []).map(p => ({ nombre: p.name, qty: p.quantity || 1 }))
      const total = parseFloat(o.total) || 0
      const isFirstPurchase = (crmContact.cantCompras === 1) || (!crmContact.cantCompras && !crmContact.ultimaCompra)
      const triggerTypes = ['after_purchase', 'post_purchase', 'payment_confirmed', 'order_placed']
      if (isFirstPurchase) triggerTypes.push('first_purchase')
      _processImmediateFlows(target.id, cfgData, crmContact, triggerTypes, { total, lineas })
        .catch(e2 => console.error('[flows] TN webhook flows error:', e2.message))
    }
  } catch(e) {
    console.error("TN webhook error:", e)
  }
})

// ── TN: tracking de visitas desde snippet JS ─────────────────────────────────
app.post('/api/tn/track', async (req, res) => {
  const { wsId, email, tel, nombre, evento, productId, productName, productUrl } = req.body
  if (!wsId || (!email && !tel)) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const emailNorm = (email || '').toLowerCase()
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    let contact = await db_findContact(wsId, { email: emailNorm })
    if (!contact && tel) contact = await db_findContact(wsId, { tel })
    if (!contact) return res.json({ ok: true, found: false })

    const updates = { ultimaVisita: now }

    if (evento === 'product_view' && productId) {
      const views = contact.productViews || []
      const ex = views.find(p => p.id === productId)
      if (ex) { ex.vistas = (ex.vistas || 1) + 1; ex.lastSeen = now }
      else views.unshift({ id: productId, nombre: productName || productId, url: productUrl || '', vistas: 1, firstSeen: now, lastSeen: now })
      updates.productViews = views.slice(0, 50)
      updates.totalProductViews = (contact.totalProductViews || 0) + 1
    }
    if (evento === 'cart_add' && productId) {
      const adds = contact.cartAdds || []
      adds.unshift({ id: productId, nombre: productName || productId, fecha: now })
      updates.cartAdds = adds.slice(0, 20)
      updates.carritoAbandonado = true
      updates.cartDate = today
    }
    if (evento === 'cart_abandon') { updates.carritoAbandonado = true; updates.cartDate = today }
    if (evento === 'purchase') { updates.carritoAbandonado = false; updates.cartAdds = [] }

    await db_updateContactFields(wsId, contact.id, updates)

    // Disparar flows inmediatos según el evento
    if (evento === 'product_view' && productId) {
      const ws2 = await getWorkspace(wsId).catch(() => null)
      if (ws2?.data) _processImmediateFlows(wsId, ws2.data, { ...contact, ...updates }, ['product_view'], { productId, productName }).catch(() => {})
    }

    res.json({ ok: true, found: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── TN: analytics agregados de la tienda ─────────────────────────────────────
app.get('/api/tn/store-analytics', async (req, res) => {
  const { wsId, from, to } = req.query
  if (!wsId) return res.json({})
  try {
    const orderOpts = { tipo: 'ingreso', limit: 2000 }
    if (from) orderOpts.from = from
    if (to) orderOpts.to = to
    const [allOrders, crm] = await Promise.all([
      db_listOrders(wsId, orderOpts),
      db_listContacts(wsId, { limit: 2000 })
    ])

    const ventas = allOrders.filter(f => !f.categoria || f.categoria === 'Ventas tienda' || f.categoria === '')
    const now = new Date()
    const rangeEnd = to ? new Date(to + 'T23:59:59') : now
    const rangeStart = from ? new Date(from) : null
    const d30 = new Date(rangeEnd - 30 * 86400000).toISOString().slice(0, 10)
    const d60 = new Date(rangeEnd - 60 * 86400000).toISOString().slice(0, 10)
    const d7  = new Date(rangeEnd - 7  * 86400000).toISOString().slice(0, 10)

    // Revenue metrics
    const totalRevenue = ventas.reduce((s, f) => s + (f.monto || 0), 0)
    const rev30 = ventas.filter(f => (f.fecha || '') >= d30).reduce((s, f) => s + (f.monto || 0), 0)
    const rev7  = ventas.filter(f => (f.fecha || '') >= d7).reduce((s, f) => s + (f.monto || 0), 0)
    const avgTicket = ventas.length ? totalRevenue / ventas.length : 0

    // Product popularity from finanzas.notas (products string) + productViews
    const prodSales = {}
    ventas.forEach(f => {
      if (!f.notas) return
      f.notas.split(',').forEach(p => {
        const name = p.trim().split(' x')[0].trim()
        if (!name) return
        prodSales[name] = (prodSales[name] || 0) + 1
      })
    })
    const topProductsSales = Object.entries(prodSales).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, c]) => ({ nombre: n, ventas: c }))

    // Product views aggregated from CRM
    const prodViews = {}
    crm.forEach(c => {
      (c.productViews || []).forEach(pv => {
        if (!prodViews[pv.id]) prodViews[pv.id] = { nombre: pv.nombre, url: pv.url, vistas: 0, visitantes: 0 }
        prodViews[pv.id].vistas += pv.vistas || 1
        prodViews[pv.id].visitantes += 1
      })
    })
    const topProductsViews = Object.values(prodViews).sort((a, b) => b.vistas - a.vistas).slice(0, 10)

    // Customer segments — match by email (Supabase orders have .email directly)
    const buyerEmails = new Set(ventas.map(f => (f.email || '').toLowerCase()).filter(Boolean))
    const clientesConCompras = crm.filter(c => c.email && buyerEmails.has(c.email.toLowerCase()))
    const enRiesgo = clientesConCompras.filter(c => {
      const lastOrder = ventas.filter(f => (f.email || '').toLowerCase() === (c.email || '').toLowerCase()).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''))[0]
      return lastOrder && lastOrder.fecha < d60
    })
    const activos30 = clientesConCompras.filter(c => {
      const lastOrder = ventas.filter(f => (f.email || '').toLowerCase() === (c.email || '').toLowerCase()).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''))[0]
      return lastOrder && lastOrder.fecha >= d30
    })
    const carritosAbandonados = crm.filter(c => c.carritoAbandonado && c.cartDate >= d30)

    // Conversion approximation: contacts who viewed products but haven't bought
    const visitantesNoBuyers = crm.filter(c => (c.productViews || []).length > 0 && !clientesConCompras.find(cl => cl.id === c.id))

    // Monthly revenue trend (last 6 months)
    const monthly = {}
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = d.toISOString().slice(0, 7)
      monthly[key] = 0
    }
    ventas.forEach(f => {
      const key = (f.fecha || '').slice(0, 7)
      if (monthly[key] !== undefined) monthly[key] += f.monto || 0
    })

    res.json({
      revenue: { total: totalRevenue, last30: rev30, last7: rev7, avgTicket },
      orders: { total: ventas.length, last30: ventas.filter(f => (f.fecha || '') >= d30).length },
      customers: {
        total: clientesConCompras.length,
        activos30: activos30.length,
        enRiesgo: enRiesgo.length,
        carritosAbandonados: carritosAbandonados.length,
        visitantesNoBuyers: visitantesNoBuyers.length
      },
      topProductsSales,
      topProductsViews,
      monthly,
      enRiesgoList: enRiesgo.map(c => ({ nombre: c.nombre, email: c.email, tel: c.tel })).slice(0, 20),
      carritosAbandonadosList: carritosAbandonados.map(c => ({ nombre: c.nombre, email: c.email, tel: c.tel, cartDate: c.cartDate, cartAdds: c.cartAdds || [] })).slice(0, 20)
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── TN: tablas de talles ──────────────────────────────────────────────────────
app.get('/api/tn/size-charts', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.json([])
  try {
    const [ws, tiendaResult] = await Promise.all([
      getWorkspace(wsId),
      getTienda(wsId).catch(() => null)
    ])
    const legacyCharts = ws?.data?.sizeCharts || []
    const guias = tiendaResult?.t?.guias || []
    const productos = tiendaResult?.t?.productos || []

    // Build chart list from tienda.guias, deriving productoIds from products with matching guiaTalles
    const guiaCharts = guias.map(g => {
      const pIds = productos
        .filter(p => p.guiaTalles === g.id)
        .map(p => String(p.tnId || p.id || ''))
        .filter(Boolean)
      return { ...g, productoIds: pIds }
    })

    // Merge: tienda.guias take priority, legacy charts fill in if not already present
    const guiaIds = new Set(guias.map(g => g.id))
    const merged = [...guiaCharts, ...legacyCharts.filter(c => !guiaIds.has(c.id))]
    res.json(merged)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/tn/size-charts', async (req, res) => {
  const { wsId } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })
    const data = ws.data || {}
    if (!data.sizeCharts) data.sizeCharts = []
    const chart = req.body.chart
    if (!chart) return res.status(400).json({ error: 'Falta chart' })
    const idx = data.sizeCharts.findIndex(c => c.id === chart.id)
    if (idx >= 0) { data.sizeCharts[idx] = chart } else {
      chart.id = chart.id || ('sc_' + Date.now().toString(36))
      data.sizeCharts.push(chart)
    }
    await patchWorkspace(wsId, data)
    _invalidateWsCache(wsId)
    res.json({ ok: true, id: chart.id })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/tn/size-charts/:id', async (req, res) => {
  const { wsId } = req.query
  const { id } = req.params
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })
    const data = ws.data || {}
    data.sizeCharts = (data.sizeCharts || []).filter(c => c.id !== id)
    await patchWorkspace(wsId, data)
    _invalidateWsCache(wsId)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/tn/size-charts/stock', async (req, res) => {
  const { wsId, chartId, stockStatus } = req.body
  if (!wsId || !chartId) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })
    const data = ws.data || {}
    const chart = (data.sizeCharts || []).find(c => c.id === chartId)
    if (!chart) return res.status(404).json({ error: 'Chart no encontrado' })
    chart.stockStatus = stockStatus
    await patchWorkspace(wsId, data)
    _invalidateWsCache(wsId)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── TN: wishlist ─────────────────────────────────────────────────────────────
app.get('/api/tn/wishlist', async (req, res) => {
  const { wsId, email } = req.query
  if (!wsId || !email) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const contact = await db_findContact(wsId, { email: email.toLowerCase() })
    res.json({ ok: true, wishlist: contact ? (contact.wishlist || []) : [] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/tn/wishlist', async (req, res) => {
  const { wsId, email, productId, productName, productUrl, productImg, action } = req.body
  if (!wsId || !email || !productId) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const contact = await db_findContact(wsId, { email: email.toLowerCase() })
    if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' })
    let wishlist = contact.wishlist || []
    if (action === 'remove') {
      wishlist = wishlist.filter(p => p.id !== productId)
    } else {
      if (!wishlist.find(p => p.id === productId)) {
        wishlist.unshift({ id: productId, nombre: productName || productId, url: productUrl || '', img: productImg || '', addedAt: new Date().toISOString() })
        if (wishlist.length > 100) wishlist = wishlist.slice(0, 100)
      }
    }
    await db_updateContactFields(wsId, contact.id, { wishlist })
    res.json({ ok: true, wishlist })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── TN: cashback ─────────────────────────────────────────────────────────────
app.get('/api/tn/cashback', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const rows = await _sGET('contacts', `ws_id=eq.${encodeURIComponent(wsId)}&cashback=gt.0&order=cashback.desc&limit=500`)
    const result = (rows || []).map(r => ({ email: r.email, nombre: r.nombre, cashback: r.cashback, cashbackHistory: (r.data || {}).cashbackHistory || [] }))
    res.json(result)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/tn/cashback/apply', async (req, res) => {
  const { wsId, email, amount, motivo } = req.body
  if (!wsId || !email || amount == null) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const contact = await db_findContact(wsId, { email })
    if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' })
    const newCashback = Math.max(0, (contact.cashback || 0) - amount)
    const history = [...(contact.cashbackHistory || []), { tipo: 'aplicado', monto: amount, motivo: motivo || '', fecha: Date.now() }]
    await db_updateContactFields(wsId, contact.id, { cashback: newCashback, cashbackHistory: history })
    res.json({ ok: true, cashback: newCashback })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/tn/cashback/adjust', async (req, res) => {
  const { wsId, email, cashback, motivo } = req.body
  if (!wsId || !email || cashback == null) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const contact = await db_findContact(wsId, { email })
    if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' })
    const history = [...(contact.cashbackHistory || []), { tipo: 'ajuste', monto: cashback, motivo: motivo || '', fecha: Date.now() }]
    await db_updateContactFields(wsId, contact.id, { cashback, cashbackHistory: history })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── TN: reviews ───────────────────────────────────────────────────────────────
app.post('/api/tn/reviews', async (req, res) => {
  const { wsId, productId, productName, email, nombre, stars, texto } = req.body
  if (!wsId || !productId || !email) return res.status(400).json({ error: 'Faltan campos' })
  try {
    await db_insertReview(wsId, {
      productId, productName: productName || '', email, nombre: nombre || '',
      stars: Number(stars) || 5, texto: texto || '', estado: 'pending',
      foto_url: null  // base64 no se acepta — el cliente debe subir a Storage y pasar URL
    })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/tn/reviews', async (req, res) => {
  const { wsId, productId, estado } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const reviews = await db_listReviews(wsId, { productId, estado })
    res.json(reviews)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/tn/reviews/:id', async (req, res) => {
  const { wsId, estado, texto, nombre, stars, foto_url, fecha } = req.body
  const { id } = req.params
  if (!wsId) return res.status(400).json({ error: 'Faltan campos' })
  try {
    await db_updateReview(wsId, id, { estado, texto, nombre, stars, foto_url, fecha })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/tn/reviews/:id', async (req, res) => {
  const wsId = req.body?.wsId || req.query?.wsId
  const { id } = req.params
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    await db_deleteReview(wsId, id)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── TN: suscripción desde popup embebido en TN ────────────────────────────────
app.post('/api/tn/subscribe', async (req, res) => {
  const { wsId, email, nombre, tel } = req.body
  if (!wsId || !email) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const emailNorm = email.toLowerCase()
    const today = new Date().toISOString().slice(0, 10)
    const sessionToken = _genToken()
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    const existing = await db_findContact(wsId, { email: emailNorm })
    let contactId, contactNombre
    if (!existing) {
      const contact = {
        id: 'c_tnpop_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
        nombre: nombre || '', email: emailNorm, tel: tel || '',
        estado: 'Lead', etapa: 'lead', canal: 'Popup TN', newsletter: 'si', creado: today
      }
      await db_upsertContact(wsId, contact)
      contactId = contact.id
      contactNombre = contact.nombre
      const ws = await getWorkspace(wsId)
      if (ws?.data) _processImmediateFlows(wsId, ws.data, contact, ['new_lead'], {}).catch(() => {})
    } else {
      contactId = existing.id
      contactNombre = nombre || existing.nombre || ''
    }
    await db_updateContactFields(wsId, contactId, { vldToken: sessionToken, vldTokenExpiry: tokenExpiry })
    _addContactToList(wsId, 'Pop Up TN', 'dl_popup_tn', contactId).catch(() => {})
    res.json({ ok: true, token: sessionToken, nombre: contactNombre, email: emailNorm })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── TN: update profile fields from storefront ────────────────────────────────
app.post('/api/tn/update-profile', async (req, res) => {
  const { wsId, token, nombre, email, tel } = req.body
  if (!wsId || !token) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const contact = await db_findContactByToken(wsId, token)
    if (!contact) return res.status(401).json({ error: 'Sesión no válida' })
    const updates = {}
    if (nombre !== undefined && nombre !== contact.nombre) updates.nombre = nombre.trim()
    if (tel !== undefined && tel !== contact.tel) updates.tel = tel.trim()
    if (email && email.toLowerCase() !== contact.email) updates.email = email.toLowerCase().trim()
    if (Object.keys(updates).length > 0) await db_updateContactFields(wsId, contact.id, updates)
    res.json({ ok: true, nombre: updates.nombre ?? contact.nombre, email: updates.email ?? contact.email, tel: updates.tel ?? contact.tel })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Admin: popup stats (subscribers via Popup TN) ────────────────────────────
app.get('/api/admin/popup-stats', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    // Count total contacts from popup
    const countRows = await _sGET('contacts', `ws_id=eq.${encodeURIComponent(wsId)}&canal=eq.Popup%20TN&select=id`)
    const total = Array.isArray(countRows) ? countRows.length : 0
    // Get last 50 subscribers with relevant fields
    const rows = await _sGET('contacts', `ws_id=eq.${encodeURIComponent(wsId)}&canal=eq.Popup%20TN&order=created_at.desc&limit=50&select=id,nombre,email,tel,created_at,data`)
    const subs = (rows || []).map(r => ({
      id: r.id,
      nombre: r.nombre || '',
      email: r.email || '',
      tel: r.tel || '',
      wapp: r.tel || (r.data?.tel) || '',
      creado: r.created_at?.slice(0,10) || ''
    }))
    res.json({ total, subs })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── TN: panel de cliente para storefront de TN ───────────────────────────────
app.get('/api/tn/customer-panel', async (req, res) => {
  const { wsId, email, tel } = req.query
  if (!wsId || (!email && !tel)) return res.json({})
  try {
    let contact = null
    if (email) contact = await db_findContact(wsId, { email: email.toLowerCase() })
    if (!contact && tel) contact = await db_findContact(wsId, { tel: tel.replace(/\D/g, '') })
    if (!contact) return res.json({ nombre: null, pedidos: [], reclamos: [] })
    const emailNorm = contact.email || ''
    // Pedidos del cliente desde orders table
    const orders = emailNorm ? await db_listOrders(wsId, { email: emailNorm, tipo: 'ingreso', limit: 20 }) : []
    const pedidos = orders
      .filter(f => f.categoria === 'Ventas tienda')
      .map(f => ({
        numero:    f.tn_number || (f.concepto || '').match(/#(\d+)/)?.[1] || '',
        fecha:     f.fecha || '',
        monto:     f.monto || 0,
        productos: f.notas || '',
        medioPago: f.medioPago || '',
      }))
    res.json({
      nombre:            contact.nombre || '',
      tel:               contact.tel || '',
      etapa:             contact.etapa || contact.estado || '',
      cantCompras:       contact.cantCompras || 0,
      valorTotal:        contact.valorTotal || 0,
      ultimoPedido:      contact.ultimoPedido || '',
      ultimoProducto:    contact.ultimoProducto || '',
      ultimaCompra:      contact.ultimaCompra || '',
      carritoAbandonado: contact.carritoAbandonado || false,
      valorAbandonado:   contact.valorAbandonado || 0,
      pedidos,
    })
  } catch(e) { res.json({}) }
})

// ── TN: XP, cashback y nivel del cliente ─────────────────────────────────────
app.get('/api/tn/customer-stats', async (req, res) => {
  const { wsId, email, tel } = req.query
  if (!wsId || (!email && !tel)) return res.json({})
  try {
    let contact = null
    if (email) contact = await db_findContact(wsId, { email: email.toLowerCase() })
    if (!contact && tel) contact = await db_findContact(wsId, { tel: tel.replace(/\D/g, '') })
    if (!contact) return res.json({ xp: 0, cashback: 0, nivel: 'Bronze', exchanges: [] })
    const valorTotal = parseFloat(contact.valorTotal || 0)
    const xp = Math.floor(valorTotal / 100)
    const nivel = xp >= 5000 ? 'Platinum' : xp >= 2000 ? 'Gold' : xp >= 500 ? 'Silver' : 'Bronze'
    const vldCode = contact.codigoCashback || ('VLD-' + contact.id.replace(/\W/g, '').slice(-6).toUpperCase())
    res.json({ xp, cashback: contact.cashback || 0, nivel, valorTotal, exchanges: [], vldCode, contactId: contact.id })
  } catch(e) { res.json({}) }
})

// ── TN: solicitud de cambio / devolución ─────────────────────────────────────
app.post('/api/tn/exchange-request', async (req, res) => {
  const { wsId, email, nombre, orderNumber, producto, razon, tipo } = req.body
  if (!wsId || !email || !orderNumber) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(400).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    if (!t.solicitudes) t.solicitudes = []
    const sol = {
      id: 'exc_' + Date.now().toString(36),
      tipo: tipo || 'cambio',
      estado: 'pendiente',
      fecha: new Date().toISOString(),
      email: email.toLowerCase(),
      nombre: nombre || '',
      orderNumber: String(orderNumber),
      producto: producto || '',
      razon: razon || '',
    }
    t.solicitudes.push(sol)
    await saveTienda(wsId, t, d)
    res.json({ ok: true, id: sol.id })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── TN: PWA manifest ──────────────────────────────────────────────────────────
app.get('/api/tn/manifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json')
  res.json({
    name: 'SOULAB',
    short_name: 'SOULAB',
    start_url: 'https://soulab.com.ar/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#111111',
    icons: [
      { src: 'https://soul-ecommlab.com/soulab-icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'https://soul-ecommlab.com/soulab-icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  })
})

// ── TN: WA OTP login ──────────────────────────────────────────────────────────
const _tnOtpMap = new Map() // phone → { code, wsId, expiresAt }

app.post('/api/tn/wa-otp-send', async (req, res) => {
  const { wsId, phone } = req.body
  if (!wsId || !phone) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(400).json({ error: 'Workspace no encontrado' })
    const code = String(Math.floor(100000 + Math.random() * 900000))
    const phoneClean = phone.replace(/\D/g, '')
    _tnOtpMap.set(phoneClean, { code, wsId, expiresAt: Date.now() + 10 * 60 * 1000 })
    const text = `Tu código de verificación SOULAB es: *${code}*\n\nEste código expira en 10 minutos.`
    await _serverSendWa(ws.data, phone, text, null)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/tn/wa-otp-verify', async (req, res) => {
  const { wsId, phone, code } = req.body
  if (!wsId || !phone || !code) return res.status(400).json({ error: 'Faltan campos' })
  const phoneClean = phone.replace(/\D/g, '')
  const entry = _tnOtpMap.get(phoneClean)
  if (!entry || entry.code !== String(code) || entry.expiresAt < Date.now()) {
    return res.status(401).json({ error: 'Código inválido o expirado' })
  }
  _tnOtpMap.delete(phoneClean)
  try {
    // Search Supabase contacts by phone
    let contact = await db_findContact(wsId, { tel: phoneClean }).catch(() => null)
    if (!contact) {
      // Fuzzy fallback: last 8 digits match
      const rows = await _sGET('contacts', `ws_id=eq.${encodeURIComponent(wsId)}&limit=500&select=id,nombre,email,tel,xp,cashback,etapa,estado,tn_customer_id,tags,data`).catch(() => [])
      const found = (rows || []).find(r => {
        const t = (r.tel || '').replace(/\D/g, '')
        return t && (t.endsWith(phoneClean.slice(-8)) || phoneClean.endsWith(t.slice(-8)))
      })
      if (found) contact = _rowToContact(found)
    }
    if (!contact) return res.json({ ok: true, found: false })

    // Generate persistent session token (30-day expiry)
    const token = _genToken()
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    await db_updateContactFields(wsId, contact.id, { vldToken: token, vldTokenExpiry: tokenExpiry })

    res.json({ ok: true, found: true, nombre: contact.nombre || '', email: contact.email || '', tel: contact.tel || '', token })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── TN: snippet JS para pegar en el storefront de TN ─────────────────────────
app.get('/api/tn/snippet', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).send('// wsId requerido')
  const base = (process.env.BASE_URL || 'https://soul-ecommlab.com').replace(/\/$/, '')
  const snippet = `/* VELDOS tracking — no modificar */
(function(){
  var W='${wsId}',B='${base}';
  function post(path,body){fetch(B+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(function(){});}
  function getCust(){
    if(typeof LS!=='undefined'&&LS.customer&&LS.customer.email)return LS.customer;
    if(typeof NuvemShop!=='undefined'&&NuvemShop.theme&&NuvemShop.theme.customer&&NuvemShop.theme.customer.email)return NuvemShop.theme.customer;
    return null;
  }
  var c=getCust();
  if(c&&c.email){
    post('/api/tn/track',{wsId:W,email:c.email,tel:c.phone||'',nombre:(c.name||'')+' '+(c.last_name||''),evento:'visita'});
    if(location.pathname.indexOf('/cart')!==-1||location.pathname.indexOf('/carrito')!==-1){
      window.addEventListener('beforeunload',function(){
        navigator.sendBeacon(B+'/api/tn/track',JSON.stringify({wsId:W,email:c.email,evento:'cart_abandon'}));
      });
    }
  }
})();`
  res.type('application/javascript').set('Cache-Control','public,max-age=300').send(snippet)
})

// ── Eliminación de datos de usuario (requerido por Meta) ─────────────────────
app.get("/eliminar-datos", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eliminar mis datos — Soul eCommlab</title><style>body{font-family:system-ui,sans-serif;max-width:680px;margin:60px auto;padding:0 24px;color:#222;line-height:1.7}h1{font-size:24px;margin-bottom:8px}h2{font-size:16px;margin-top:32px;color:#1877f2}p,li{font-size:14px;color:#444}a{color:#1877f2}code{background:#f4f4f4;padding:2px 6px;border-radius:4px;font-size:13px}.box{background:#fff8e1;border-left:4px solid #f5c842;padding:14px 18px;border-radius:4px;margin:20px 0}.steps{counter-reset:step}.steps li{counter-increment:step;padding:8px 0 8px 0;font-size:14px;color:#444}</style></head><body>
  <h1>Eliminar mis datos</h1>
  <p>Última actualización: ${new Date().toLocaleDateString('es-AR')}</p>
  <p>En <strong>Soul eCommlab</strong> respetamos tu privacidad. Si conectaste tu cuenta de Facebook/Meta a nuestra plataforma y querés que eliminemos tus datos, seguí estos pasos.</p>

  <h2>Opción 1 — Desde Facebook (automático)</h2>
  <p>Podés revocar el acceso de Soul eCommlab directamente desde tu cuenta de Facebook:</p>
  <ol class="steps">
    <li>Entrá a <a href="https://www.facebook.com/settings?tab=applications" target="_blank">facebook.com/settings → Aplicaciones y sitios web</a></li>
    <li>Buscá <strong>Soul eCommlab</strong> en la lista</li>
    <li>Hacé clic en <strong>Eliminar</strong></li>
  </ol>
  <p>Esto revoca el acceso al token inmediatamente. No podremos usar tus datos de Meta a partir de ese momento.</p>

  <h2>Opción 2 — Solicitud directa por email</h2>
  <p>Envianos un email a <a href="mailto:soporte@veldos.app">soporte@veldos.app</a> con el asunto <code>Eliminar mis datos</code> indicando el email de tu cuenta. Procesamos la solicitud en un máximo de <strong>72 horas hábiles</strong>.</p>

  <div class="box">
    <strong>¿Qué datos guardamos?</strong><br>
    Solo almacenamos tu nombre de perfil de Facebook, el ID de tu cuenta publicitaria y el token de acceso cifrado necesario para sincronizar tus campañas. No almacenamos datos personales de tus clientes ni información sensible.
  </div>

  <h2>Qué eliminamos al recibir tu solicitud</h2>
  <ul>
    <li>Token de acceso a Meta Ads</li>
    <li>ID de cuenta publicitaria vinculada</li>
    <li>Nombre de perfil de Facebook asociado</li>
    <li>Historial de campañas sincronizadas</li>
  </ul>

  <p style="margin-top:32px;font-size:13px;color:#888">Para más información consultá nuestra <a href="/privacidad">Política de Privacidad</a>.</p>
</body></html>`)
})

// ── Páginas públicas (requeridas por Tienda Nube) ────────────────────────────
app.get("/privacidad", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Política de privacidad — Soul eCommlab</title><style>body{font-family:system-ui,sans-serif;max-width:700px;margin:60px auto;padding:0 24px;color:#222;line-height:1.7}h1{font-size:24px;margin-bottom:8px}h2{font-size:16px;margin-top:32px}p,li{font-size:14px;color:#444}a{color:#2979ff}</style></head><body>
  <h1>Política de privacidad</h1>
  <p>Última actualización: ${new Date().toLocaleDateString('es-AR')}</p>
  <h2>Datos que recopilamos</h2>
  <p>Soul eCommlab accede a los datos de órdenes de tu tienda Tiendanube (número de orden, fecha, monto total y medio de pago) únicamente para mostrarlos dentro de tu espacio de trabajo. No almacenamos datos personales de tus clientes.</p>
  <h2>Uso de los datos</h2>
  <p>Los datos de órdenes se importan a tu espacio de trabajo en Soul eCommlab para que puedas visualizar tus finanzas. Nunca se comparten con terceros.</p>
  <h2>Eliminación de datos</h2>
  <p>Al desinstalar la aplicación, podés eliminar todos los datos importados desde tu panel de Soul eCommlab. También podés escribirnos a <a href="mailto:soporte@veldos.app">soporte@veldos.app</a>.</p>
  <h2>Contacto</h2>
  <p><a href="mailto:soporte@veldos.app">soporte@veldos.app</a></p>
  </body></html>`)
})

app.get("/soporte", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Soporte — Soul eCommlab</title><style>body{font-family:system-ui,sans-serif;max-width:700px;margin:60px auto;padding:0 24px;color:#222;line-height:1.7}h1{font-size:24px;margin-bottom:8px}p{font-size:14px;color:#444}a{color:#2979ff}</style></head><body>
  <h1>Soporte</h1>
  <p>Para consultas o problemas con la integración de Soul eCommlab con Tiendanube, escribinos a:</p>
  <p><strong><a href="mailto:soporte@veldos.app">soporte@veldos.app</a></strong></p>
  <p>Respondemos dentro de las 48 horas hábiles.</p>
  </body></html>`)
})

// ── Tienda Nube — Privacy webhooks (obligatorios) ────────────────────────────
app.post("/api/tn/webhooks/store-redact", (req, res) => {
  // Called when a store uninstalls the app and requests data deletion
  // Soul eCommlab stores order data inside user workspaces in Supabase — no separate store records to delete
  console.log("TN store/redact:", req.body?.store_id)
  res.sendStatus(200)
})

app.post("/api/tn/webhooks/customers-redact", (req, res) => {
  // Called when a customer requests their data to be deleted
  // Soul eCommlab only stores order totals/dates, no personal customer data
  console.log("TN customers/redact:", req.body?.customer?.id)
  res.sendStatus(200)
})

app.post("/api/tn/webhooks/customers-data-request", (req, res) => {
  // Called when a customer requests to see what data the app holds about them
  // Soul eCommlab holds no personal customer data — respond with empty set
  console.log("TN customers/data_request:", req.body?.customer?.id)
  res.sendStatus(200)
})

// ── Meta (Ads + Ad Library + WhatsApp) ──────────────────────────────────────

// Connect Meta Ads — store token + adAccountId in workspace
app.post("/api/meta/connect", async (req, res) => {
  const { wsId, accessToken, adAccountId } = req.body
  if (!wsId || !accessToken) return res.status(400).json({ error: "wsId y accessToken requeridos" })
  try {
    const meRes = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${accessToken}`)
    const me = await meRes.json()
    if (me.error) return res.status(400).json({ error: me.error.message })
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: "Workspace no encontrado" })
    const wsData = { ...(ws.data || {}), metaIntegration: { ...(ws.data?.metaIntegration || {}), accessToken, adAccountId: adAccountId || ws.data?.metaIntegration?.adAccountId || "", name: me.name || "", connectedAt: new Date().toISOString() } }
    await patchWorkspace(wsId, wsData)
    res.json({ ok: true, name: me.name })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Get campaign metrics from Meta Marketing API
app.get("/api/meta/campaigns", async (req, res) => {
  const { wsId, datePreset = "last_30d" } = req.query
  if (!wsId) return res.status(400).json({ error: "wsId requerido" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken || !meta?.adAccountId) return res.status(400).json({ error: "Meta Ads no conectado" })
    const accountId = meta.adAccountId.startsWith("act_") ? meta.adAccountId : "act_" + meta.adAccountId
    const insightFields = `spend,impressions,clicks,ctr,cpc,reach,actions,action_values,frequency,cpp,cpm,cost_per_result`
    const fields = `id,name,status,objective,daily_budget,lifetime_budget,budget_remaining,insights.date_preset(${datePreset}){${insightFields}}`
    const url = `https://graph.facebook.com/v21.0/${accountId}/campaigns?fields=${encodeURIComponent(fields)}&limit=100&access_token=${meta.accessToken}`
    const r = await fetch(url)
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    const campaigns = (data.data || []).map(c => {
      const ins = c.insights?.data?.[0] || {}
      const findAction = (types) => (ins.actions || []).find(a => types.includes(a.action_type))
      const findValue = (types) => (ins.action_values || []).find(a => types.includes(a.action_type))
      const purchaseAction = findAction(["purchase","offsite_conversion.fb_pixel_purchase","omni_purchase","complete_registration"])
      const leadAction = findAction(["lead","onsite_web_lead"])
      const conversions = purchaseAction ? Number(purchaseAction.value) : (leadAction ? Number(leadAction.value) : 0)
      const spend = parseFloat(ins.spend || 0)
      const revenueVal = findValue(["purchase","offsite_conversion.fb_pixel_purchase","omni_purchase"])
      const revenue = revenueVal ? parseFloat(revenueVal.value) : 0
      const roas = spend > 0 && revenue > 0 ? revenue / spend : null
      const cpa = conversions > 0 ? spend / conversions : null
      const dailyBudget = c.daily_budget ? parseFloat(c.daily_budget) / 100 : null
      const lifetimeBudget = c.lifetime_budget ? parseFloat(c.lifetime_budget) / 100 : null
      const budgetRemaining = c.budget_remaining ? parseFloat(c.budget_remaining) / 100 : null
      return {
        id: c.id, name: c.name, status: c.status, objective: c.objective || "",
        spend, impressions: parseInt(ins.impressions || 0), clicks: parseInt(ins.clicks || 0),
        ctr: parseFloat(ins.ctr || 0), cpc: parseFloat(ins.cpc || 0),
        cpm: parseFloat(ins.cpm || 0), reach: parseInt(ins.reach || 0),
        conversions, roas, cpa, frequency: parseFloat(ins.frequency || 0),
        cpp: parseFloat(ins.cpp || 0), dailyBudget, lifetimeBudget, budgetRemaining
      }
    })
    res.json({ campaigns, accountId, datePreset })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Update campaign budget
app.post("/api/meta/campaign/budget", async (req, res) => {
  const { wsId, campaignId, dailyBudget, lifetimeBudget } = req.body
  if (!wsId || !campaignId || (dailyBudget == null && lifetimeBudget == null)) {
    return res.status(400).json({ error: "wsId, campaignId y dailyBudget o lifetimeBudget requeridos" })
  }
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken) return res.status(400).json({ error: "Meta Ads no conectado" })
    const body = { access_token: meta.accessToken }
    if (dailyBudget != null) body.daily_budget = String(Math.round(dailyBudget * 100)) // Meta uses cents as string
    if (lifetimeBudget != null) body.lifetime_budget = String(Math.round(lifetimeBudget * 100))
    const r = await fetch(`https://graph.facebook.com/v21.0/${campaignId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ok: true, campaignId, dailyBudget, lifetimeBudget })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Create a new campaign
app.post("/api/meta/campaign/create", async (req, res) => {
  const { wsId, name, objective, status = "PAUSED", dailyBudget, lifetimeBudget, startTime, endTime, specialAdCategories = [], budgetOptimizationOn = false } = req.body
  if (!wsId || !name || !objective) return res.status(400).json({ error: "wsId, name y objective requeridos" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken || !meta?.adAccountId) return res.status(400).json({ error: "Meta Ads no conectado" })
    const accountId = meta.adAccountId.startsWith("act_") ? meta.adAccountId : "act_" + meta.adAccountId
    const token = meta.accessToken
    const body = {
      name, objective, status,
      special_ad_categories: specialAdCategories.filter(c => c !== "NONE"),
      access_token: token
    }
    if (budgetOptimizationOn) {
      if (dailyBudget) body.daily_budget = String(Math.round(dailyBudget * 100))
      if (lifetimeBudget) body.lifetime_budget = String(Math.round(lifetimeBudget * 100))
      if (startTime) body.start_time = startTime
      if (endTime) body.end_time = endTime
    }
    const r = await fetch(`https://graph.facebook.com/v21.0/${accountId}/campaigns`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    })
    const d = await r.json()
    if (d.error) return res.status(400).json({ error: d.error.message })
    res.json({ ok: true, campaignId: d.id, name, objective, status })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Pause or enable a campaign
app.post("/api/meta/campaign/action", async (req, res) => {
  const { wsId, campaignId, action } = req.body // action: "PAUSED" | "ACTIVE"
  if (!wsId || !campaignId || !action) return res.status(400).json({ error: "wsId, campaignId y action requeridos" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken) return res.status(400).json({ error: "Meta Ads no conectado" })
    const r = await fetch(`https://graph.facebook.com/v21.0/${campaignId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: action, access_token: meta.accessToken })
    })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ok: true, campaignId, newStatus: action })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Delete a campaign
app.delete("/api/meta/campaign", async (req, res) => {
  const { wsId, campaignId } = req.body
  if (!wsId || !campaignId) return res.status(400).json({ error: "wsId y campaignId requeridos" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken) return res.status(400).json({ error: "Meta Ads no conectado" })
    const r = await fetch(`https://graph.facebook.com/v21.0/${campaignId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: meta.accessToken })
    })
    const d = await r.json()
    if (d.error) return res.status(400).json({ error: d.error.message })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Create a new ad set
app.post("/api/meta/adset/create", async (req, res) => {
  const {
    wsId, campaignId, name, status = "PAUSED",
    dailyBudget, lifetimeBudget, startTime, endTime,
    targeting = {}, optimizationGoal = "LINK_CLICKS",
    billingEvent = "IMPRESSIONS", placements = "auto",
    publisherPlatforms = []
  } = req.body
  if (!wsId || !campaignId || !name) return res.status(400).json({ error: "wsId, campaignId y name requeridos" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken || !meta?.adAccountId) return res.status(400).json({ error: "Meta Ads no conectado" })
    const accountId = meta.adAccountId.startsWith("act_") ? meta.adAccountId : "act_" + meta.adAccountId
    const token = meta.accessToken

    const body = {
      name, campaign_id: campaignId, status,
      billing_event: billingEvent,
      optimization_goal: optimizationGoal,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: {
        geo_locations: { countries: targeting.countries || ["AR"] },
        age_min: targeting.ageMin || 18,
        age_max: targeting.ageMax || 65,
        ...(targeting.genders && targeting.genders.length ? { genders: targeting.genders } : {}),
        ...(placements === "manual" && publisherPlatforms.length ? {
          publisher_platforms: publisherPlatforms,
          facebook_positions: publisherPlatforms.includes("facebook") ? ["feed"] : undefined,
          instagram_positions: publisherPlatforms.includes("instagram") ? ["stream"] : undefined
        } : {})
      },
      access_token: token
    }
    if (dailyBudget) body.daily_budget = String(Math.round(dailyBudget * 100))
    if (lifetimeBudget) body.lifetime_budget = String(Math.round(lifetimeBudget * 100))
    if (startTime) body.start_time = startTime
    if (endTime) body.end_time = endTime

    const r = await fetch(`https://graph.facebook.com/v21.0/${accountId}/adsets`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    })
    const d = await r.json()
    if (d.error) return res.status(400).json({ error: d.error.message })
    res.json({ ok: true, adsetId: d.id, name })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Get ad sets for a campaign (drill-down)
app.get("/api/meta/adsets", async (req, res) => {
  const { wsId, campaignId } = req.query
  if (!wsId || !campaignId) return res.status(400).json({ error: "wsId y campaignId requeridos" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken) return res.status(400).json({ error: "Meta Ads no conectado" })
    const fields = "id,name,status,daily_budget,lifetime_budget,insights.date_preset(last_30d){spend,impressions,clicks,ctr,cpc,reach,frequency,actions,action_values}"
    const url = `https://graph.facebook.com/v21.0/${campaignId}/adsets?fields=${encodeURIComponent(fields)}&limit=50&access_token=${meta.accessToken}`
    const r = await fetch(url)
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    const adsets = (data.data || []).map(s => {
      const ins = s.insights?.data?.[0] || {}
      const spend = parseFloat(ins.spend || 0)
      const conversions = (ins.actions || []).find(a => ["purchase","offsite_conversion.fb_pixel_purchase","lead"].includes(a.action_type))
      const conv = conversions ? Number(conversions.value) : 0
      return {
        id: s.id, name: s.name, status: s.status,
        spend, impressions: parseInt(ins.impressions || 0), clicks: parseInt(ins.clicks || 0),
        ctr: parseFloat(ins.ctr || 0), cpc: parseFloat(ins.cpc || 0),
        reach: parseInt(ins.reach || 0), frequency: parseFloat(ins.frequency || 0),
        conversions: conv, cpa: conv > 0 ? spend / conv : null,
        dailyBudget: s.daily_budget ? parseFloat(s.daily_budget) / 100 : null,
      }
    })
    res.json({ adsets })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Ad Library search (public API — can search any brand)
app.get("/api/meta/adlibrary", async (req, res) => {
  const { q, country = "AR", wsId } = req.query
  if (!q) return res.status(400).json({ error: "q (término de búsqueda) requerido" })
  try {
    let accessToken = process.env.META_ACCESS_TOKEN || ""
    if (wsId) { const ws = await getWorkspace(wsId); accessToken = ws?.data?.metaIntegration?.accessToken || accessToken }
    if (!accessToken) return res.status(400).json({ error: "Se necesita un token de Meta conectado para buscar la biblioteca de anuncios" })
    const fields = "id,ad_creative_body,ad_creative_link_title,ad_creative_link_caption,ad_snapshot_url,page_name,page_id,currency,spend,impressions,ad_delivery_start_time"
    const url = `https://graph.facebook.com/v21.0/ads_archive?search_terms=${encodeURIComponent(q)}&ad_reached_countries=${country}&ad_type=ALL&limit=24&fields=${encodeURIComponent(fields)}&access_token=${accessToken}`
    const r = await fetch(url)
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ads: data.data || [] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ════════════════════════════════════════════════════
// WA PROVIDERS — endpoint unificado multi-proveedor
// ════════════════════════════════════════════════════

// GET /api/wa/providers — listar proveedores configurados del workspace
app.get('/api/wa/providers', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    const providers = ws?.data?.waProviders || []
    // Nunca devolver tokens/secrets en texto plano
    const safe = providers.map(p => ({
      id: p.id, name: p.name, type: p.type, enabled: p.enabled,
      phone: p.phone || null,
      hasConfig: !!(p.config?.apiKey || p.config?.instanceId || p.config?.token || p.config?.phoneNumberId)
    }))
    res.json({ providers: safe })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Helper: enviar WA desde el servidor usando el proveedor configurado en el workspace
async function _serverSendWa(d, phone, text, providerId) {
  const providers = (d.waProviders || []).filter(p => p.enabled && p.type !== 'local')
  const provider = providerId ? (providers.find(p => p.id === providerId) || providers[0]) : providers[0]
  if (!provider) throw new Error('No hay proveedor WA habilitado')

  const cleanPhone = String(phone).replace(/\D/g, '')
  if (!cleanPhone) throw new Error('Teléfono vacío')

  if (provider.type === 'greenapi') {
    const { instanceId, apiToken } = provider.config || {}
    if (!instanceId || !apiToken) throw new Error('Green API: faltan instanceId y apiToken')
    const chatId = cleanPhone.startsWith('549') ? `${cleanPhone}@c.us` : `549${cleanPhone}@c.us`
    const r = await fetch(`https://api.green-api.com/waInstance${instanceId}/sendMessage/${apiToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message: text })
    })
    const result = await r.json()
    if (!r.ok || result.error) throw new Error(result.error || 'Green API error')
    return { ok: true }
  }

  if (provider.type === 'waha') {
    const { serverUrl, apiKey, session } = provider.config || {}
    if (!serverUrl) throw new Error('WAHA: falta serverUrl')
    const headers = { 'Content-Type': 'application/json' }
    if (apiKey) headers['X-Api-Key'] = apiKey
    const sess = (session || 'default').trim()
    const wahaNum = cleanPhone.startsWith('549') ? cleanPhone : `549${cleanPhone}`
    const chatId = cleanPhone.includes('@') ? cleanPhone : `${wahaNum}@c.us`
    const base = serverUrl.replace(/\/$/, '')
    const _wahaFetch = (url, body, timeoutMs = 6000) => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
        .finally(() => clearTimeout(timer))
    }
    // WAHA v2026: POST /api/sendText con session en body
    const r = await _wahaFetch(`${base}/api/sendText`, { session: sess, chatId, text })
    if (r.ok) { await r.json().catch(() => {}); return { ok: true } }
    // Solo intentar fallback si fue error de ruta (404/405), no timeout ni error de servidor
    if (r.status === 404 || r.status === 405) {
      const r2 = await _wahaFetch(`${base}/api/${sess}/sendText`, { chatId, text })
      const result2 = await r2.json().catch(() => ({}))
      if (!r2.ok) throw new Error(result2?.message || result2?.error || 'WAHA error ' + r2.status)
      return { ok: true }
    }
    const err = await r.json().catch(() => ({}))
    throw new Error(err?.message || err?.error || 'WAHA error ' + r.status)
  }

  if (provider.type === 'waba') {
    const { phoneNumberId, accessToken } = provider.config || {}
    if (!phoneNumberId || !accessToken) throw new Error('WABA: faltan phoneNumberId y accessToken')
    const r = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: cleanPhone, type: 'text', text: { body: text } })
    })
    const result = await r.json()
    if (!r.ok || result.error) throw new Error(result?.error?.message || 'WABA error')
    return { ok: true }
  }

  if (provider.type === 'twilio') {
    const { accountSid, authToken, from } = provider.config || {}
    if (!accountSid || !authToken || !from) throw new Error('Twilio: faltan accountSid, authToken, from')
    const body = new URLSearchParams({ From: `whatsapp:+${from}`, To: `whatsapp:+${cleanPhone}`, Body: text })
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    const result = await r.json()
    if (!r.ok || result.error_code) throw new Error(result.error_message || 'Twilio error')
    return { ok: true }
  }

  throw new Error(`Proveedor desconocido: ${provider.type}`)
}

// ── Auto-procesar flows con trigger after_purchase/post_purchase y delay=0 al completarse una compra
// Se llama en background (sin await) — no bloquea la respuesta al cliente
// ── Motor central de flows inmediatos ──────────────────────────────────────────
// triggerTypes: array de strings ('after_purchase','post_purchase','payment_confirmed','order_placed','new_lead','cart_abandon')
// extra: { total, lineas, cartItems } — datos adicionales según el evento
async function _processImmediateFlows(wsId, d, crmContact, triggerTypes, extra = {}) {
  const { total = 0, lineas = [], cartItems = [], numeroPedido = '', ultimoProducto = '' } = extra
  console.log(`[flows] _processImmediateFlows called wsId=${wsId} triggers=${JSON.stringify(triggerTypes)} contact=${crmContact?.id||'?'} nombre="${crmContact?.nombre||''}"`)
  try {
    const freshWs = await getWorkspace(wsId)
    const freshD = freshWs?.data || d

    const allFlows = freshD.flows || []
    // enabled puede ser true (bool) o "true" (string) — tolerar ambos
    const flows = allFlows.filter(f => f.enabled === true || f.enabled === 'true')
    console.log(`[flows] workspace flows total=${allFlows.length} enabled=${flows.length}`)
    if (!flows.length) {
      console.log(`[flows] no hay flows habilitados — abortando`)
      return
    }

    const today = new Date().toISOString().slice(0, 10)
    const ultimaCompra = crmContact.ultimaCompra || today
    const creado = crmContact.creado || today
    const cid = crmContact.id || (crmContact.tel || '').replace(/\D/g,'') || (crmContact.email || '').replace(/[^a-z0-9]/gi,'') || 'anon'

    // Key prefix por tipo de trigger — evita duplicados entre distintos eventos
    const triggerKeyMap = {
      after_purchase:    ultimaCompra,
      post_purchase:     `pp_${ultimaCompra}`,
      payment_confirmed: `pc_${ultimaCompra}`,
      order_placed:      `op_${ultimaCompra}`,
      new_lead:          `nl_${creado}`,
      cart_abandon:      `ca_${crmContact.cartDate || today}`,
      product_view:      `pv_${extra.productId || today}`,
      first_purchase:    `fp_${ultimaCompra}`,
    }

    for (const f of flows) {
      const trig = f.trigger || {}
      const trigType = trig.type
      if (!triggerTypes.includes(trigType)) {
        console.log(`[flows] skip flow "${f.name||f.id}": trigType="${trigType}" no está en ${JSON.stringify(triggerTypes)}`)
        continue
      }

      const delayVal  = trig.delayValue != null ? Number(trig.delayValue) : Number(trig.days || 0)
      const delayUnit = trig.delayUnit || 'dias'
      const delayMs   = delayUnit === 'minutos' ? delayVal * 60000 : delayUnit === 'horas' ? delayVal * 3600000 : delayVal * 86400000
      // Triggers marcados como "inmediatos" ignoran el delay configurado (el admin oculta el campo pero el valor por defecto es 1)
      const ALWAYS_IMMEDIATE = ['new_lead', 'payment_confirmed', 'order_placed', 'birthday', 'product_view', 'first_purchase']
      const effectiveDelayMs = ALWAYS_IMMEDIATE.includes(trigType) ? 0 : delayMs
      // Delays de hasta 10 minutos se consideran "inmediatos" y se procesan en el momento
      const IMMEDIATE_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutos
      if (effectiveDelayMs > IMMEDIATE_THRESHOLD_MS) {
        console.log(`[flows] skip flow "${f.name||f.id}": delay=${delayVal}${delayUnit} (lo maneja el cron)`)
        continue
      }

      if (f.filter?.estados?.length) {
        const estado = crmContact.estado || 'Cliente'
        if (!f.filter.estados.includes(estado)) {
          console.log(`[flows] skip flow "${f.name||f.id}": estado="${estado}" no en filtro ${JSON.stringify(f.filter.estados)}`)
          continue
        }
      }

      const triggerKey = triggerKeyMap[trigType] || ultimaCompra
      const hasMsg = (f.steps || []).some(s => s.type === 'message' || s.type === 'email' || s.type === 'both')
      if (!hasMsg) {
        console.log(`[flows] skip flow "${f.name||f.id}": sin steps de mensaje (steps=${JSON.stringify((f.steps||[]).map(s=>s.type))})`)
        continue
      }

      const cantCompras   = String(crmContact.cantCompras || 1)
      const valorStr      = total ? `$${Math.round(total).toLocaleString('es-AR')}` : ''
      const productosStr  = (lineas.length ? lineas : cartItems).map(l => l.nombre || l.name).filter(Boolean).join(', ')
      const ultimaCompraFmt = ultimaCompra.split('-').reverse().join('/')

      const _applyVars = str => (str || '')
        .replace(/\{nombre\}/gi,          crmContact.nombre || '')
        .replace(/\{apellido\}/gi,        crmContact.apellido || '')
        .replace(/\{ultimaCompra\}/gi,    ultimaCompraFmt)
        .replace(/\{cantCompras\}/gi,     cantCompras)
        .replace(/\{valor\}/gi,           valorStr)
        .replace(/\{productos\}/gi,       productosStr)
        .replace(/\{dias\}/gi,            '0')
        .replace(/\{carrito\}/gi,         productosStr)
        .replace(/\{ultimoProducto\}/gi,  ultimoProducto || crmContact.ultimoProducto || '')
        .replace(/\{numeroPedido\}/gi,    numeroPedido   || crmContact.ultimoPedido   || '')
        .replace(/\{producto\}/gi,        extra.productName || ultimoProducto || crmContact.ultimoProducto || '')
        .replace(/\{xp\}/gi,             String(crmContact.xp || 0))

      for (let si = 0; si < f.steps.length; si++) {
        const step = f.steps[si]
        const isWA    = step.type === 'message' && step.action === 'whatsapp'
        const isEmail = step.type === 'email'
        const isBoth  = step.type === 'both'
        if (!isWA && !isEmail && !isBoth) continue

        const key = `${f.id}|${cid}|${triggerKey}|step${si}`
        // Verificar en flow_log table — atómico, sin race condition
        if (await db_flowKeyExists(wsId, key)) continue

        const _logFlow = (channel, status, mensaje, error) => db_insertFlowLog(wsId, {
          flowId: f.id, flowName: f.name || f.id, flowKey: key,
          contactId: cid, email: crmContact.email || '', tel: crmContact.tel || '',
          channel, status, message: (mensaje || '').slice(0, 300),
          data: { error: error || null, triggerType: trigType, origen: 'auto', contactNombre: crmContact.nombre || '' }
        }).catch(e2 => console.error('[flows] logFlow error:', e2.message))

        if (isWA || isBoth) {
          const phone = (crmContact.tel || '').replace(/\D/g, '')
          const rawMsg = step.template || step.templateWA || ''
          if (rawMsg && phone) {
            const text = _applyVars(rawMsg)
            try {
              await _serverSendWa(freshD, phone, text, step.waProviderId)
              await _logFlow('whatsapp', 'sent', text, null)
              console.log(`[flows] WA sent → "${f.name||f.id}" (${trigType}) → ${crmContact.nombre||phone}`)
            } catch (e) {
              await _logFlow('whatsapp', 'failed', text, e.message)
              console.error(`[flows] WA error → "${f.name||f.id}" (${trigType}):`, e.message)
            }
          }
        }

        if ((isEmail || isBoth) && step.autoSend !== false) {
          const email = (crmContact.email || '').trim()
          const rawBody    = step.template || step.templateEmail || ''
          const rawSubject = step.subject || ''
          if (!process.env.RESEND_API_KEY) {
            await _logFlow('email', 'failed', rawBody.slice(0, 100), 'RESEND_API_KEY no configurado en Vercel')
          } else if (rawBody && email) {
            const bodyText    = _applyVars(rawBody)
            const subjectText = _applyVars(rawSubject) || 'Mensaje automático'
            try {
              const resend = _getResend()
              const emailSettings = { ...(freshD.tienda?.settings || {}), ...(freshD.store?.settings || {}) }
              const fromDomain = emailSettings.emailFromDomain || process.env.EMAIL_FROM_DOMAIN || 'resend.dev'
              const fromUser   = emailSettings.emailFromUser   || process.env.EMAIL_FROM_USER   || 'onboarding'
              const fromName   = emailSettings.emailFromName   || ''
              const fromAddr   = `${fromUser}@${fromDomain}`
              const from       = fromName ? `${fromName} <${fromAddr}>` : fromAddr
              console.log(`[flows] email attempt → from=${from} to=${email}`)
              const result     = await resend.emails.send({ from, to: [email], subject: subjectText, html: bodyText })
              if (result.error) throw new Error(result.error.message || JSON.stringify(result.error))
              await _logFlow('email', 'sent', subjectText, null)
              console.log(`[flows] email sent → "${f.name||f.id}" (${trigType}) → ${email}`)
            } catch (e) {
              await _logFlow('email', 'failed', subjectText, e.message)
              console.error(`[flows] email error → "${f.name||f.id}" (${trigType}):`, e.message)
            }
          }
        }
      }
    }
    // No patchWorkspace — todo va a flow_log table
  } catch (e) {
    console.error(`[flows] _processImmediateFlows(${triggerTypes}) error:`, e.message)
  }
}

// Backward compat — purchases disparan todos los triggers de compra
async function _processFlowsOnPurchase(wsId, d, crmContact, total, lineas) {
  return _processImmediateFlows(wsId, d, crmContact,
    ['after_purchase', 'post_purchase', 'payment_confirmed'],
    { total, lineas }
  )
}

// POST /api/wa/providers — guardar proveedores del workspace
app.post('/api/wa/providers', async (req, res) => {
  const { wsId, providers } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: 'WS no encontrado' })
    const data = { ...(ws.data || {}), waProviders: providers }
    await patchWorkspace(wsId, data)
    _invalidateWsCache(wsId)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/wa/send — enviar mensaje por el proveedor indicado
app.post('/api/wa/send', async (req, res) => {
  const { wsId, providerId, to, text, typing } = req.body
  if (!wsId || !to || !text) return res.status(400).json({ error: 'Faltan campos: wsId, to, text' })

  const phone = String(to).replace(/\D/g, '')

  try {
    // Si providerId = 'local', reenviar al servidor local del cliente (no desde aquí)
    if (!providerId || providerId === 'local') {
      return res.status(400).json({ error: 'El proveedor "local" se envía directo desde el browser a localhost:3001. Usá un proveedor cloud.' })
    }

    const ws = await getWorkspace(wsId)
    const provider = (ws?.data?.waProviders || []).find(p => p.id === providerId)
    if (!provider) return res.status(404).json({ error: 'Proveedor no encontrado' })
    if (!provider.enabled) return res.status(400).json({ error: 'Proveedor deshabilitado' })

    let result

    // ── Green API (cloud, informal)
    if (provider.type === 'greenapi') {
      const { instanceId, apiToken } = provider.config || {}
      if (!instanceId || !apiToken) return res.status(400).json({ error: 'Green API: faltan instanceId y apiToken' })
      const chatId = phone.startsWith('549') ? phone + '@c.us' : `549${phone}@c.us`
      const r = await fetch(`https://api.green-api.com/waInstance${instanceId}/sendMessage/${apiToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, message: text })
      })
      result = await r.json()
      if (!r.ok || result.error) throw new Error(result.error || 'Green API error')
    }

    // ── WAHA (WhatsApp HTTP API - Docker self-hosted)
    else if (provider.type === 'waha') {
      const { serverUrl, apiKey, session } = provider.config || {}
      if (!serverUrl) return res.status(400).json({ error: 'WAHA: falta serverUrl' })
      const headers = { 'Content-Type': 'application/json' }
      if (apiKey) headers['X-Api-Key'] = apiKey
      const sess = (session || 'default').trim()
      const wahaNum = phone.startsWith('549') ? phone : `549${phone}`
      const chatId = phone.includes('@') ? phone : `${wahaNum}@c.us`
      const base = serverUrl.replace(/\/$/, '')

      // Verificar que la sesión esté conectada antes de enviar (timeout 5s para no bloquear)
      const _statusTimeout = (url, hdrs, ms = 5000) => {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), ms)
        return fetch(url, { headers: hdrs, signal: ctrl.signal }).finally(() => clearTimeout(t))
      }
      const statusChk = await _statusTimeout(`${base}/api/sessions/${sess}`, headers).catch(() => null)
      const stData = statusChk?.ok ? await statusChk.json().catch(() => ({})) : {}
      const stVal = stData.status || stData.engine?.status || stData.state || ''
      console.log(`[wa/send] session="${sess}" status="${stVal}" chatId="${chatId}"`)
      const CONNECTED_ST = ['WORKING','AUTHENTICATED','CONNECTED','ONLINE','SCAN_QR_CODE']
      if (statusChk && !CONNECTED_ST.includes(stVal) && stVal !== '') {
        return res.status(400).json({ error: `WAHA no conectado — estado: "${stVal}". Escaneá el QR o reiniciá el container.` })
      }
      // Si el status check no responde, intentamos enviar igual (WAHA puede estar cargando)

      // Intentar enviar — 2 formatos de endpoint, timeout 8s cada uno (safe para Vercel 30s)
      const fetchWithTimeout = (url, opts, ms = 8000) => {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), ms)
        return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t))
      }
      const attempts = [
        // WAHA v1/v2026: session en body
        { url: `${base}/api/sendText`,         body: { session: sess, chatId, text } },
        // WAHA v2: session en URL path
        { url: `${base}/api/${sess}/sendText`, body: { chatId, text } },
      ]
      let lastErr = 'WAHA error'
      let sent = false
      for (const att of attempts) {
        let r, rawResp
        try {
          r = await fetchWithTimeout(att.url, { method: 'POST', headers, body: JSON.stringify(att.body) })
          rawResp = await r.text().catch(() => '')
        } catch(fetchErr) {
          console.log(`[wa/send] ${att.url} → ${fetchErr.name === 'AbortError' ? 'TIMEOUT' : fetchErr.message}`)
          lastErr = fetchErr.name === 'AbortError' ? 'Timeout enviando mensaje' : fetchErr.message
          continue
        }
        console.log(`[wa/send] ${att.url} → HTTP ${r.status} | ${rawResp.slice(0,150)}`)
        if (r.ok) {
          result = JSON.parse(rawResp || '{}')
          sent = true
          break
        }
        let errData; try { errData = JSON.parse(rawResp) } catch(e) { errData = {} }
        lastErr = errData.message || errData.error || errData.details || rawResp.slice(0,100) || `HTTP ${r.status}`
      }
      if (!sent) throw new Error(lastErr)
    }

    // ── Meta WhatsApp Business API (oficial)
    else if (provider.type === 'waba') {
      const { phoneNumberId, accessToken, templateName, templateLang } = provider.config || {}
      if (!phoneNumberId || !accessToken) return res.status(400).json({ error: 'WABA: faltan phoneNumberId y accessToken' })
      // Si hay template configurado, enviarlo como template; si no, texto libre (solo dentro de 24hs de contacto)
      let msgPayload
      if (templateName) {
        msgPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'template',
          template: {
            name: templateName,
            language: { code: templateLang || 'es_AR' },
            components: text ? [{
              type: 'body',
              parameters: [{ type: 'text', text }]
            }] : []
          }
        }
      } else {
        msgPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'text',
          text: { body: text }
        }
      }
      const r = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
        body: JSON.stringify(msgPayload)
      })
      result = await r.json()
      if (!r.ok || result.error) throw new Error(result?.error?.message || 'WABA error')
    }

    // ── Twilio WhatsApp
    else if (provider.type === 'twilio') {
      const { accountSid, authToken, from } = provider.config || {}
      if (!accountSid || !authToken || !from) return res.status(400).json({ error: 'Twilio: faltan accountSid, authToken, from' })
      const body = new URLSearchParams({ From: `whatsapp:+${from}`, To: `whatsapp:+${phone}`, Body: text })
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      })
      result = await r.json()
      if (!r.ok || result.error_code) throw new Error(result.error_message || 'Twilio error')
    }

    else {
      return res.status(400).json({ error: `Tipo de proveedor desconocido: ${provider.type}` })
    }

    res.json({ ok: true, result })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/wa/waha-session — estado de sesión WAHA (proxy)
app.get('/api/wa/waha-session', async (req, res) => {
  const { serverUrl, apiKey, session } = req.query
  if (!serverUrl) return res.status(400).json({ error: 'falta serverUrl' })
  const sess = (session || 'default').trim()
  const headers = {}
  if (apiKey) headers['X-Api-Key'] = apiKey
  res.setHeader('Cache-Control', 'no-store')
  try {
    const url = `${serverUrl.replace(/\/$/, '')}/api/sessions/${sess}`
    const r = await fetch(url, { headers })
    const text = await r.text()
    console.log(`[waha-session] ${url} → HTTP ${r.status} | ${text.slice(0, 200)}`)
    let data; try { data = JSON.parse(text) } catch(e) { data = { rawText: text } }
    res.json(data)
  } catch(e) {
    console.error('[waha-session] fetch error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/wa/waha-qr — imagen QR de sesión WAHA (proxy, evita CORS)
app.get('/api/wa/waha-qr', async (req, res) => {
  const { serverUrl, apiKey, session } = req.query
  if (!serverUrl) return res.status(400).json({ error: 'falta serverUrl' })
  const sess = (session || 'default').trim()
  const headers = {}
  if (apiKey) headers['X-Api-Key'] = apiKey
  const base = serverUrl.replace(/\/$/, '')

  async function tryQRUrl(url) {
    const r = await fetch(url, { headers })
    if (!r.ok) return null
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('image')) {
      return { buf: Buffer.from(await r.arrayBuffer()), ct: 'image/png' }
    }
    if (ct.includes('json') || ct.includes('text')) {
      const json = await r.json().catch(() => null)
      if (!json) return null
      // WAHA v2+ devuelve { mimetype, data } donde data es base64 puro o data-URI
      const b64raw = json.data || json.qr || json.image || json.base64
      if (b64raw) {
        const b64clean = String(b64raw).replace(/^data:[^;]+;base64,/, '')
        return { buf: Buffer.from(b64clean, 'base64'), ct: 'image/png' }
      }
    }
    return null
  }

  try {
    // 1. QR como imagen binaria (WAHA v1)
    const r1 = await tryQRUrl(`${base}/api/${sess}/auth/qr?format=image`)
    if (r1) {
      res.setHeader('Content-Type', r1.ct)
      res.setHeader('Cache-Control', 'no-store')
      return res.send(r1.buf)
    }
    // 2. QR como JSON base64 (WAHA v2+)
    const r2 = await tryQRUrl(`${base}/api/${sess}/auth/qr`)
    if (r2) {
      res.setHeader('Content-Type', r2.ct)
      res.setHeader('Cache-Control', 'no-store')
      return res.send(r2.buf)
    }
    // 3. Screenshot como último recurso
    const r3 = await fetch(`${base}/api/screenshot`, { headers })
    if (r3.ok) {
      const buf = Buffer.from(await r3.arrayBuffer())
      res.setHeader('Content-Type', r3.headers.get('content-type') || 'image/png')
      res.setHeader('Cache-Control', 'no-store')
      return res.send(buf)
    }
    res.status(404).json({ error: 'QR no disponible — sesión ya conectada o WAHA no responde' })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/wa/waha-diag — diagnóstico completo de la sesión WAHA
app.get('/api/wa/waha-diag', async (req, res) => {
  const { serverUrl, apiKey, session } = req.query
  if (!serverUrl) return res.status(400).json({ error: 'falta serverUrl' })
  const sess = (session || 'default').trim()
  const headers = {}
  if (apiKey) headers['X-Api-Key'] = apiKey
  const base = serverUrl.replace(/\/$/, '')
  const diag = { serverUrl, session: sess, checks: [] }

  const chk = async (label, url, method = 'GET', body = null) => {
    try {
      const opts = { method, headers: { ...headers, 'Content-Type': 'application/json' } }
      if (body) opts.body = JSON.stringify(body)
      const r = await fetch(url, opts)
      const text = await r.text().catch(() => '')
      let data; try { data = JSON.parse(text) } catch(e) { data = { raw: text.slice(0, 200) } }
      diag.checks.push({ label, url, status: r.status, ok: r.ok, data })
      return { ok: r.ok, data, status: r.status }
    } catch(e) {
      diag.checks.push({ label, url, error: e.message })
      return { ok: false, error: e.message }
    }
  }

  // 1. Estado de la sesión
  const s = await chk('session_status', `${base}/api/sessions/${sess}`)
  const st = s.data?.status || s.data?.engine?.status || s.data?.state || 'UNKNOWN'
  diag.sessionStatus = st

  // 2. Listar todas las sesiones
  await chk('sessions_list', `${base}/api/sessions`)

  // 3. Versión de WAHA
  await chk('waha_version', `${base}/api/version`)
  await chk('waha_health', `${base}/health`)
  await chk('waha_root', `${base}/`)

  res.json(diag)
})

// ── POST /api/wa/waha-start — iniciar/reiniciar sesión WAHA (proxy)
app.post('/api/wa/waha-start', async (req, res) => {
  const { serverUrl, apiKey, session } = req.body
  if (!serverUrl) return res.status(400).json({ error: 'falta serverUrl' })
  const sess = (session || 'default').trim()
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-Api-Key'] = apiKey
  const base = serverUrl.replace(/\/$/, '')
  const CONNECTED = ['WORKING', 'AUTHENTICATED', 'CONNECTED', 'ONLINE']
  const NEEDS_QR  = ['SCAN_QR_CODE', 'QR', 'UNPAIRED', 'UNPAIRED_IDLE']

  const fetchTimeout = (url, opts, ms = 6000) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), ms)
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t))
  }

  const getStatus = async () => {
    const r = await fetchTimeout(`${base}/api/sessions/${sess}`, { headers }, 5000).catch(() => null)
    if (!r) return null
    const text = await r.text().catch(() => '{}')
    const d = JSON.parse(text || '{}')
    const st = d.status || d.engine?.status || d.state || ''
    console.log(`[waha-start] poll → HTTP ${r.status} state="${st}" raw=${text.slice(0,120)}`)
    return { ok: r.ok, st, d }
  }

  try {
    // 0. Check de conectividad rápido — si WAHA no responde, fallar inmediato
    const ping = await fetchTimeout(`${base}/api/version`, { headers }, 5000).catch(() => null)
    if (!ping) {
      console.error(`[waha-start] WAHA no responde en ${base} — servidor caído o inaccesible`)
      return res.status(503).json({ error: `El servidor WAHA en ${base} no responde. Reiniciá el container Docker (docker restart waha).` })
    }

    // 1. Ver estado actual
    const cur = await getStatus()
    if (cur?.ok) {
      if (CONNECTED.includes(cur.st)) return res.json({ ok: true, alreadyConnected: true })
      if (NEEDS_QR.includes(cur.st))  return res.json({ ok: true, needsQR: true })
      // Cualquier otro estado (FAILED, STOPPED, STARTING…) → borrar y recrear
      // WAHA v2026 no tiene /stop ni /start: se usa DELETE + POST con start:true
      console.log(`[waha-start] estado "${cur.st}" → reseteando sesión`)
      await fetchTimeout(`${base}/api/sessions/${sess}`, { method: 'DELETE', headers }, 5000).catch(() => {})
      await new Promise(r => setTimeout(r, 600))
    }
    // Crear sesión con start:true (funciona tanto si existía antes como si no)
    const createR = await fetchTimeout(`${base}/api/sessions`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: sess, start: true, config: { webhooks: [] } })
    }, 6000).catch(() => null)
    console.log(`[waha-start] create+start HTTP ${createR?.status}`)

    // 2. Esperar hasta 25s a que WAHA llegue a SCAN_QR_CODE o CONNECTED
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2500))
      const s = await getStatus()
      if (!s) continue
      if (CONNECTED.includes(s.st)) return res.json({ ok: true, alreadyConnected: true })
      if (NEEDS_QR.includes(s.st))  return res.json({ ok: true, needsQR: true })
    }

    // 3. Timeout — devolver igual para que el front muestre el QR y siga polling
    console.log('[waha-start] timeout esperando QR — devolviendo needsQR=true de todos modos')
    res.json({ ok: true, needsQR: true, timeout: true })
  } catch(e) {
    console.error('[waha-start] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})


// WhatsApp — connect phone number
app.post("/api/meta/wa/connect", async (req, res) => {
  const { wsId, accessToken, phoneNumberId, businessAccountId } = req.body
  if (!wsId || !accessToken || !phoneNumberId) return res.status(400).json({ error: "wsId, accessToken y phoneNumberId requeridos" })
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}?fields=verified_name,display_phone_number&access_token=${accessToken}`)
    const info = await r.json()
    if (info.error) return res.status(400).json({ error: info.error.message })
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: "Workspace no encontrado" })
    const wsData = { ...(ws.data || {}), metaIntegration: { ...(ws.data?.metaIntegration || {}), waAccessToken: accessToken, waPhoneNumberId: phoneNumberId, waBusinessAccountId: businessAccountId || "", waPhoneName: info.verified_name || "", waPhoneNumber: info.display_phone_number || "", waConnectedAt: new Date().toISOString() } }
    await patchWorkspace(wsId, wsData)
    res.json({ ok: true, name: info.verified_name, number: info.display_phone_number })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// WhatsApp — list approved templates
app.get("/api/meta/wa/templates", async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: "wsId requerido" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.waAccessToken || !meta?.waBusinessAccountId) return res.status(400).json({ error: "WhatsApp no conectado o falta Business Account ID" })
    const r = await fetch(`https://graph.facebook.com/v21.0/${meta.waBusinessAccountId}/message_templates?status=APPROVED&limit=50&access_token=${meta.waAccessToken}`)
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ templates: data.data || [] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// WhatsApp — send template message
app.post("/api/meta/wa/send", async (req, res) => {
  const { wsId, to, templateName, languageCode = "es_AR", params = [] } = req.body
  if (!wsId || !to || !templateName) return res.status(400).json({ error: "wsId, to y templateName requeridos" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.waAccessToken || !meta?.waPhoneNumberId) return res.status(400).json({ error: "WhatsApp no conectado" })
    let phone = to.replace(/[\s\-\(\)\+]/g, "")
    if (!phone.startsWith("54")) phone = "54" + phone
    const msgBody = { messaging_product: "whatsapp", to: phone, type: "template", template: { name: templateName, language: { code: languageCode }, ...(params.length ? { components: [{ type: "body", parameters: params.map(p => ({ type: "text", text: String(p) })) }] } : {}) } }
    const r = await fetch(`https://graph.facebook.com/v21.0/${meta.waPhoneNumberId}/messages`, { method: "POST", headers: { "Authorization": `Bearer ${meta.waAccessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(msgBody) })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    // Log to workspace (non-critical)
    try {
      const freshWs = await getWorkspace(wsId)
      const d = freshWs.data || {}
      if (!d.waLog) d.waLog = []
      d.waLog.unshift({ to: phone, templateName, params, sentAt: new Date().toISOString(), messageId: data.messages?.[0]?.id || "" })
      if (d.waLog.length > 500) d.waLog = d.waLog.slice(0, 500)
      await patchWorkspace(wsId, d)
    } catch(e) { /* log failure non-critical */ }
    res.json({ ok: true, messageId: data.messages?.[0]?.id })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Lista todos los workspaces del usuario — sin los campos grandes (CRM, finanzas, etc.)
app.get("/api/workspaces", async (req, res) => {
  try {
    const rows = await _sGET('workspaces', 'select=*&order=created_at.asc')
    const safe = (rows || []).map(ws => {
      const { crm, finanzas, reviews, flowDone, flowHistory, ...safeData } = ws.data || {}
      return { ...ws, data: safeData }
    })
    res.json(safe)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Get a single workspace by ID (used to refresh S after OAuth callback)
// CRM/finanzas/reviews/flowDone/flowHistory viven en tablas propias — no se mandan al browser
app.get("/api/workspace/:wsId", async (req, res) => {
  const ws = await getWorkspace(req.params.wsId)
  if (!ws) return res.status(404).json({ error: "not found" })
  const { crm, finanzas, reviews, flowDone, flowHistory, ...safeData } = ws.data || {}
  res.json({ id: ws.id, data: safeData })
})

// ── Brief público para creadoras ──────────────────────────────────────────────
app.get('/brief-view', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'brief.html'))
})

app.get('/api/brief-public', async (req, res) => {
  const { ws, id } = req.query
  if (!ws || !id) return res.status(400).json({ error: 'Faltan parámetros' })
  try {
    const workspace = await getWorkspace(ws)
    const briefs = workspace?.data?.briefs || []
    const brief = briefs.find(b => b.id === id)
    if (!brief) return res.status(404).json({ error: 'Brief no encontrado' })
    res.json({ brief })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── CRM (contacts table) ──────────────────────────────────────────────────────
app.get('/api/crm', async (req, res) => {
  const { wsId, search, estado, limit = '500', offset = '0' } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const contacts = await db_listContacts(wsId, { search, estado, limit: parseInt(limit), offset: parseInt(offset) })
    res.json({ contacts, total: contacts.length })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/crm', async (req, res) => {
  const { wsId, contact } = req.body
  if (!wsId || !contact) return res.status(400).json({ error: 'Faltan campos' })
  try {
    if (!contact.id) contact.id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    await db_upsertContact(wsId, contact)
    res.json({ ok: true, id: contact.id })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/crm/batch', async (req, res) => {
  const { wsId, contacts } = req.body
  if (!wsId || !Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const rows = contacts.map(c => {
      if (!c.id) c.id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
      return _contactToRow(wsId, c)
    })
    await _sPOST('contacts', rows, 'return=minimal,resolution=merge-duplicates')
    res.json({ ok: true, count: rows.length })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/crm/:id', async (req, res) => {
  const { wsId, fields } = req.body
  const { id } = req.params
  if (!wsId || !fields) return res.status(400).json({ error: 'Faltan campos' })
  try {
    await db_updateContactFields(wsId, id, fields)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/crm/:id', async (req, res) => {
  const wsId = req.body?.wsId || req.query?.wsId
  const { id } = req.params
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    await db_deleteContact(wsId, id)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Agrega una nota a un contacto (append-only)
app.post('/api/crm/:id/note', async (req, res) => {
  const { wsId, nota } = req.body
  const { id } = req.params
  if (!wsId || !nota) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const contact = await db_findContact(wsId, { email: id }).catch(() => null) ||
      (await _sGET('contacts', `ws_id=eq.${encodeURIComponent(wsId)}&id=eq.${encodeURIComponent(id)}&limit=1`).then(r => r?.[0] ? _rowToContact(r[0]) : null))
    if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' })
    const notas = Array.isArray(contact.notas) ? contact.notas : []
    notas.push({ texto: nota, fecha: new Date().toISOString().slice(0, 10), ts: Date.now() })
    await db_updateContactFields(wsId, contact.id, { notas })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Finanzas (orders table) ───────────────────────────────────────────────────
app.get('/api/finanzas', async (req, res) => {
  const { wsId, from, to, tipo, limit = '500', offset = '0' } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const orders = await db_listOrders(wsId, { from, to, tipo, limit: parseInt(limit), offset: parseInt(offset) })
    res.json({ orders, total: orders.length })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/finanzas', async (req, res) => {
  const { wsId, order } = req.body
  if (!wsId || !order) return res.status(400).json({ error: 'Faltan campos' })
  try {
    await db_insertOrder(wsId, order)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/finanzas/:id', async (req, res) => {
  const wsId = req.body?.wsId || req.query?.wsId
  const { id } = req.params
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    await db_deleteOrder(wsId, id)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Flow log ──────────────────────────────────────────────────────────────────
app.get('/api/flow-log', async (req, res) => {
  const { wsId, limit = '200', offset = '0' } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const logs = await db_listFlowLog(wsId, { limit: parseInt(limit), offset: parseInt(offset) })
    res.json({ logs })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Migración: blob → tablas propias ─────────────────────────────────────────
// Batch insert helpers (no loop — una sola llamada HTTP por tabla)
async function _batchUpsert(table, rows, onConflict) {
  if (!rows.length) return { ok: rows.length, fail: 0, total: 0 }
  const CHUNK = 200
  let ok = 0, fail = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    try {
      const prefer = `return=minimal,resolution=merge-duplicates`
      const url = `${SUPA_URL}/rest/v1/${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`
      const r = await fetch(url, { method: 'POST', headers: _sHdrs({ Prefer: prefer }), body: JSON.stringify(chunk) })
      if (!r.ok) { const t = await r.text(); console.error(`[migrate] batch ${table} chunk ${i}:`, t); fail += chunk.length }
      else ok += chunk.length
    } catch(e) { console.error(`[migrate] batch ${table} chunk ${i}:`, e.message); fail += chunk.length }
  }
  return { ok, fail, total: rows.length }
}

app.post('/api/migrate/v1', async (req, res) => {
  const { wsId, tables = ['contacts', 'orders', 'reviews'] } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws?.data) return res.status(404).json({ error: 'Workspace no encontrado' })
    const d = ws.data
    const results = {}

    if (tables.includes('contacts') && Array.isArray(d.crm) && d.crm.length) {
      const rows = d.crm.map(c => _contactToRow(wsId, c))
      results.contacts = await _batchUpsert('contacts', rows, 'id')
    } else {
      results.contacts = { ok: 0, fail: 0, total: 0, skipped: 'no data in blob' }
    }

    if (tables.includes('orders') && Array.isArray(d.finanzas) && d.finanzas.length) {
      const rows = d.finanzas.map(f => {
        if (!f.id) f.id = 'ord_' + Math.random().toString(36).slice(2, 10)
        return _orderToRow(wsId, f)
      })
      results.orders = await _batchUpsert('orders', rows, 'id')
    } else {
      results.orders = { ok: 0, fail: 0, total: 0, skipped: 'no data in blob' }
    }

    if (tables.includes('reviews') && Array.isArray(d.reviews) && d.reviews.length) {
      const rows = d.reviews.map(r => ({
        id: r.id || 'rev_' + Math.random().toString(36).slice(2, 10),
        ws_id: wsId,
        product_id: r.productId || r.product_id || null,
        product_name: r.productName || r.product_name || '',
        email: r.email || null,
        nombre: r.nombre || '',
        stars: r.stars || r.estrellas || 5,
        texto: r.texto || r.text || '',
        foto_url: null,  // no migrar base64
        estado: r.estado || 'pending',
      }))
      results.reviews = await _batchUpsert('reviews', rows, 'id')
    } else {
      results.reviews = { ok: 0, fail: 0, total: 0, skipped: 'no data in blob' }
    }

    res.json({ ok: true, results })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Meta OAuth 2.0 ──────────────────────────────────────────────────────────

// Step 1 — redirect user to Facebook consent screen
app.get("/api/meta/oauth/start", (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).send("wsId requerido")
  if (!META_APP_ID()) return res.status(500).send("META_APP_ID no configurado en el servidor")
  const redirectUri = encodeURIComponent(`${APP_BASE_URL()}/api/meta/oauth/callback`)
  const scope = encodeURIComponent("ads_read,ads_management,business_management,pages_show_list,pages_manage_ads")
  // state = wsId so we know which workspace to update after callback
  const state = encodeURIComponent(wsId)
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${META_APP_ID()}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}&response_type=code`
  res.redirect(url)
})

// Step 2 — Facebook redirects back here with a code
app.get("/api/meta/oauth/callback", async (req, res) => {
  const { code, state, error: fbError, error_description } = req.query
  const wsId = decodeURIComponent(state || "")

  // User denied or error
  if (fbError || !code) {
    const msg = error_description || fbError || "El usuario canceló la autorización"
    return res.redirect(`/?metaOAuth=error&msg=${encodeURIComponent(msg)}`)
  }
  if (!wsId) return res.redirect("/?metaOAuth=error&msg=Missing+wsId+in+state")

  try {
    const redirectUri = encodeURIComponent(`${APP_BASE_URL()}/api/meta/oauth/callback`)

    // Exchange code → short-lived token
    const tokenRes = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?client_id=${META_APP_ID()}&redirect_uri=${redirectUri}&client_secret=${META_APP_SECRET()}&code=${code}`)
    const tokenData = await tokenRes.json()
    if (tokenData.error) throw new Error(tokenData.error.message)
    const shortToken = tokenData.access_token

    // Exchange short-lived → long-lived token (60 days)
    const longRes = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID()}&client_secret=${META_APP_SECRET()}&fb_exchange_token=${shortToken}`)
    const longData = await longRes.json()
    if (longData.error) throw new Error(longData.error.message)
    const accessToken = longData.access_token
    const expiresIn   = longData.expires_in || 5184000 // ~60 days default

    // Get user info
    const meRes = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${accessToken}`)
    const me = await meRes.json()

    // Get their ad accounts — exclude only explicitly disabled/closed accounts
    const DEAD_STATUSES_OAUTH = new Set([2, 101]) // DISABLED, CLOSED
    const accsRes = await fetch(`https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name,account_status,currency,account_id&limit=100&access_token=${accessToken}`)
    const accsData = await accsRes.json()
    const adAccounts = (accsData.data || []).filter(a => {
      if (DEAD_STATUSES_OAUTH.has(a.account_status)) return false
      const rawId = a.account_id || (a.id || "").replace("act_", "")
      return rawId && /^\d+$/.test(rawId)
    })

    // Save token + user info + ad accounts list in workspace
    const ws = await getWorkspace(wsId)
    if (!ws) throw new Error("Workspace no encontrado")
    const d = ws.data || {}
    d.metaIntegration = {
      ...(d.metaIntegration || {}),
      accessToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      userId: me.id,
      name: me.name || "",
      connectedAt: new Date().toISOString(),
      oauthConnected: true,
      // If multiple accounts, store them for selection; if only one auto-pick
      pendingAdAccounts: adAccounts.length > 1 ? adAccounts : undefined,
      adAccountId: adAccounts.length === 1 ? (adAccounts[0].account_id || adAccounts[0].id?.replace('act_','') || "") : (d.metaIntegration?.adAccountId || ""),
      adAccountName: adAccounts.length === 1 ? adAccounts[0].name : (d.metaIntegration?.adAccountName || ""),
    }
    await patchWorkspace(wsId, d)

    // Redirect back to app
    if (adAccounts.length > 1) {
      // Multiple accounts — let frontend show the selector
      res.redirect(`/?metaOAuth=select&wsId=${encodeURIComponent(wsId)}`)
    } else if (adAccounts.length === 1) {
      res.redirect(`/?metaOAuth=ok&wsId=${encodeURIComponent(wsId)}`)
    } else {
      // No active ad accounts found — still connected, but needs manual account ID
      res.redirect(`/?metaOAuth=noaccount&wsId=${encodeURIComponent(wsId)}`)
    }
  } catch(e) {
    console.error("Meta OAuth callback error:", e)
    res.redirect(`/?metaOAuth=error&msg=${encodeURIComponent(e.message)}`)
  }
})

// List ad accounts for selection (after OAuth with multiple accounts)
// Returns both flat accounts list AND grouped by Business Portfolio
app.get("/api/meta/adaccounts", async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: "wsId requerido" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken) return res.status(400).json({ error: "Meta no conectado" })
    const token = meta.accessToken

    // Helper: normalise an account object — always set rawId and exclude truly closed/disabled
    const DEAD_STATUSES = new Set([2, 101]) // DISABLED, CLOSED
    const normaliseAccount = (a) => {
      const rawId = (a.account_id || (a.id || "").replace("act_", "")).toString()
      if (!rawId || !/^\d+$/.test(rawId)) return null          // not a real ad account
      if (DEAD_STATUSES.has(a.account_status)) return null     // disabled or closed
      return { ...a, rawId }
    }
    const filterAdAccounts = (list) => (list || []).map(normaliseAccount).filter(Boolean)

    // 1. Personal ad accounts (direct access)
    const personalRes = await fetch(`https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name,account_status,currency,account_id&limit=100&access_token=${token}`)
    const personalData = await personalRes.json()
    const personalAccounts = filterAdAccounts(personalData.data || [])

    // 2. Business Portfolios (Portafolios Comerciales) with their owned/client ad accounts
    // Note: account_id is NOT a valid sub-field for nested account queries — derive from id
    const bizRes = await fetch(`https://graph.facebook.com/v21.0/me/businesses?fields=id,name,owned_ad_accounts{id,name,account_status,currency},client_ad_accounts{id,name,account_status,currency}&limit=50&access_token=${token}`)
    const bizData = await bizRes.json()
    const businesses = (bizData.data || []).map(b => {
      const owned = filterAdAccounts(b.owned_ad_accounts?.data || [])
      const client = filterAdAccounts(b.client_ad_accounts?.data || [])
      // Merge, deduplicate by rawId
      const seen = new Set()
      const accs = [...owned, ...client].filter(a => {
        if (seen.has(a.rawId)) return false
        seen.add(a.rawId); return true
      })
      return { id: b.id, name: b.name, adAccounts: accs }
    }).filter(b => b.adAccounts.length > 0)

    // 3. Build a flat deduped list (business accounts first, then personal extras)
    const allIds = new Set()
    const allAccounts = []
    businesses.forEach(b => b.adAccounts.forEach(a => {
      if (!allIds.has(a.rawId)) { allIds.add(a.rawId); allAccounts.push({ ...a, businessName: b.name, businessId: b.id }) }
    }))
    personalAccounts.forEach(a => {
      if (!allIds.has(a.rawId)) { allIds.add(a.rawId); allAccounts.push(a) }
    })

    res.json({ accounts: allAccounts, businesses, personalAccounts })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Save selected ad account after OAuth multi-account selection
app.post("/api/meta/select-account", async (req, res) => {
  const { wsId, accountId, accountName } = req.body
  if (!wsId || !accountId) return res.status(400).json({ error: "wsId y accountId requeridos" })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: "Workspace no encontrado" })
    const d = ws.data || {}
    d.metaIntegration = { ...(d.metaIntegration || {}), adAccountId: accountId, adAccountName: accountName || "", pendingAdAccounts: undefined }
    await patchWorkspace(wsId, d)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Get individual ads for an ad set (or campaign)
app.get("/api/meta/ads", async (req, res) => {
  const { wsId, adsetId, campaignId } = req.query
  if (!wsId || (!adsetId && !campaignId)) return res.status(400).json({ error: "wsId y adsetId o campaignId requeridos" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken) return res.status(400).json({ error: "Meta Ads no conectado" })
    const parentId = adsetId || campaignId
    const endpoint = adsetId ? `${adsetId}/ads` : `${campaignId}/ads`
    const fields = "id,name,status,creative{name,thumbnail_url,image_url,object_story_spec,effective_object_story_id},insights.date_preset(last_30d){spend,impressions,clicks,ctr,cpc,actions,action_values}"
    const url = `https://graph.facebook.com/v21.0/${endpoint}?fields=${encodeURIComponent(fields)}&limit=50&access_token=${meta.accessToken}`
    const r = await fetch(url)
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    const ads = (data.data || []).map(a => {
      const ins = a.insights?.data?.[0] || {}
      const convAction = (ins.actions || []).find(x => ["purchase","offsite_conversion.fb_pixel_purchase","lead"].includes(x.action_type))
      const conversions = convAction ? Number(convAction.value) : 0
      // Try to get preview URL
      const previewUrl = a.creative?.image_url || a.creative?.thumbnail_url || ""
      return {
        id: a.id, name: a.name, status: a.status,
        creative: { name: a.creative?.name || "", thumbnail_url: previewUrl, effective_object_story_id: a.creative?.effective_object_story_id || "" },
        insights: { spend: parseFloat(ins.spend || 0), impressions: parseInt(ins.impressions || 0), clicks: parseInt(ins.clicks || 0), ctr: parseFloat(ins.ctr || 0), cpc: parseFloat(ins.cpc || 0) },
        conversions
      }
    })
    res.json({ ads })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Pause or enable a single ad
app.post("/api/meta/ad/action", async (req, res) => {
  const { wsId, adId, action } = req.body
  if (!wsId || !adId || !action) return res.status(400).json({ error: "wsId, adId y action requeridos" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken) return res.status(400).json({ error: "Meta Ads no conectado" })
    const r = await fetch(`https://graph.facebook.com/v21.0/${adId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: action, access_token: meta.accessToken })
    })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ok: true, adId, newStatus: action })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Pause or enable an ad set
app.post("/api/meta/adset/action", async (req, res) => {
  const { wsId, adsetId, action } = req.body
  if (!wsId || !adsetId || !action) return res.status(400).json({ error: "wsId, adsetId y action requeridos" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken) return res.status(400).json({ error: "Meta Ads no conectado" })
    const r = await fetch(`https://graph.facebook.com/v21.0/${adsetId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: action, access_token: meta.accessToken })
    })
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ ok: true, adsetId, newStatus: action })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Get pages available to promote (for ad creation)
app.get("/api/meta/pages", async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: "wsId requerido" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken || !meta?.adAccountId) return res.status(400).json({ error: "Meta Ads no conectado" })
    const accountId = meta.adAccountId.startsWith("act_") ? meta.adAccountId : "act_" + meta.adAccountId
    const r = await fetch(`https://graph.facebook.com/v21.0/${accountId}/promote_pages?fields=id,name,category&access_token=${meta.accessToken}`)
    const data = await r.json()
    if (data.error) {
      // Fallback: try /me/accounts
      const r2 = await fetch(`https://graph.facebook.com/v21.0/me/accounts?access_token=${meta.accessToken}`)
      const d2 = await r2.json()
      if (d2.error) return res.status(400).json({ error: d2.error.message })
      return res.json({ pages: (d2.data || []).map(p => ({ id: p.id, name: p.name })) })
    }
    res.json({ pages: (data.data || []).map(p => ({ id: p.id, name: p.name, category: p.category })) })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Get ALL ads for an account (flat list with insights)
app.get("/api/meta/account-ads", async (req, res) => {
  const { wsId, datePreset = "last_30d" } = req.query
  if (!wsId) return res.status(400).json({ error: "wsId requerido" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken || !meta?.adAccountId) return res.status(400).json({ error: "Meta Ads no conectado" })
    const accountId = meta.adAccountId.startsWith("act_") ? meta.adAccountId : "act_" + meta.adAccountId
    const fields = `id,name,status,campaign_id,adset_id,adset{name},campaign{name},creative{thumbnail_url,image_url},insights.date_preset(${datePreset}){spend,impressions,clicks,ctr,cpc,actions}`
    const url = `https://graph.facebook.com/v21.0/${accountId}/ads?fields=${encodeURIComponent(fields)}&limit=100&access_token=${meta.accessToken}`
    const r = await fetch(url)
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    const ads = (data.data || []).map(a => {
      const ins = a.insights?.data?.[0] || {}
      const convAction = (ins.actions || []).find(x => ["purchase","offsite_conversion.fb_pixel_purchase","lead"].includes(x.action_type))
      const conversions = convAction ? Number(convAction.value) : 0
      return {
        id: a.id, name: a.name, status: a.status,
        campaignId: a.campaign_id, campaignName: a.campaign?.name || "",
        adsetId: a.adset_id, adsetName: a.adset?.name || "",
        creative: { thumbnail_url: a.creative?.image_url || a.creative?.thumbnail_url || "" },
        insights: {
          spend: parseFloat(ins.spend || 0), impressions: parseInt(ins.impressions || 0),
          clicks: parseInt(ins.clicks || 0), ctr: parseFloat(ins.ctr || 0), cpc: parseFloat(ins.cpc || 0)
        },
        conversions
      }
    })
    res.json({ ads })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Get Instagram posts for a Facebook page (for IG post ad creation)
app.get("/api/meta/ig-posts", async (req, res) => {
  const { wsId, pageId } = req.query
  if (!wsId || !pageId) return res.status(400).json({ error: "wsId y pageId requeridos" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken) return res.status(400).json({ error: "Meta Ads no conectado" })
    // Get IG Business Account linked to page
    const igRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}?fields=instagram_business_account&access_token=${meta.accessToken}`)
    const igData = await igRes.json()
    if (igData.error) return res.status(400).json({ error: igData.error.message })
    const igUserId = igData.instagram_business_account?.id
    if (!igUserId) return res.status(400).json({ error: "Esta página no tiene una cuenta de Instagram Business vinculada" })
    // Get recent posts
    const postsRes = await fetch(`https://graph.facebook.com/v21.0/${igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp&limit=12&access_token=${meta.accessToken}`)
    const postsData = await postsRes.json()
    if (postsData.error) return res.status(400).json({ error: postsData.error.message })
    res.json({ posts: postsData.data || [], igUserId })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Upload image to Meta adimages API and return hash + URL
app.post("/api/meta/upload-image", async (req, res) => {
  const { wsId, base64, fileName = "image.jpg", mimeType = "image/jpeg" } = req.body
  if (!wsId || !base64) return res.status(400).json({ error: "Faltan campos: wsId, base64" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken || !meta?.adAccountId) return res.status(400).json({ error: "Meta Ads no conectado" })
    const accountId = meta.adAccountId.startsWith("act_") ? meta.adAccountId : "act_" + meta.adAccountId
    const token = meta.accessToken
    const r = await fetch(`https://graph.facebook.com/v21.0/${accountId}/adimages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bytes: base64, name: fileName, access_token: token })
    })
    const d = await r.json()
    if (d.error) return res.status(400).json({ error: "Error al subir imagen: " + d.error.message })
    // Response: { images: { "filename": { hash, url, ... } } }
    const images = d.images || {}
    const imageInfo = Object.values(images)[0]
    if (!imageInfo) return res.status(400).json({ error: "Meta no devolvió datos de imagen" })
    res.json({ ok: true, hash: imageInfo.hash, url: imageInfo.url })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Get ALL Instagram accounts accessible via the ad account (Business Portfolio)
app.get("/api/meta/ig-accounts", async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: "wsId requerido" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken || !meta?.adAccountId) return res.status(400).json({ error: "Meta Ads no conectado" })
    const accountId = meta.adAccountId.startsWith("act_") ? meta.adAccountId : "act_" + meta.adAccountId
    const token = meta.accessToken
    const r = await fetch(`https://graph.facebook.com/v21.0/${accountId}/instagram_accounts?fields=id,name,username,profile_pic&access_token=${token}`)
    const d = await r.json()
    if (d.error) return res.status(400).json({ error: d.error.message })
    const accounts = (d.data || []).map(a => ({ id: a.id, name: a.name || a.username, username: a.username, profilePic: a.profile_pic }))
    res.json({ accounts })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Get Instagram Business Account linked to a Facebook page
app.get("/api/meta/ig-account", async (req, res) => {
  const { wsId, pageId } = req.query
  if (!wsId || !pageId) return res.status(400).json({ error: "Faltan parámetros: wsId, pageId" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken) return res.status(400).json({ error: "Meta Ads no conectado" })
    const token = meta.accessToken
    const r = await fetch(`https://graph.facebook.com/v21.0/${pageId}?fields=instagram_business_account%7Bid%2Cname%2Cusername%7D&access_token=${token}`)
    const d = await r.json()
    if (d.error) return res.status(400).json({ error: d.error.message })
    const igAccount = d.instagram_business_account
    if (!igAccount) return res.json({ igUserId: null, igName: null, igUsername: null })
    res.json({ igUserId: igAccount.id, igName: igAccount.name || null, igUsername: igAccount.username || null })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Create a new ad (creative + ad) — supports manual image or existing IG post
app.post("/api/meta/ad/create", async (req, res) => {
  const {
    wsId, adsetId, name, pageId,
    ctaType = "SHOP_NOW", status = "PAUSED", destinationUrl = "",
    creativeType = "manual",
    // Manual fields
    imageUrl = "", imageHash = "", primaryText = "", headline = "", description = "",
    // IG post fields
    igMediaId = "", igUserId = "",
    // Shared: IG actor for placement
    igActorId = ""
  } = req.body

  if (!wsId || !adsetId || !name || !pageId) {
    return res.status(400).json({ error: "Faltan campos requeridos: adsetId, name, pageId" })
  }
  if (creativeType === "manual" && (!imageHash && !imageUrl)) {
    return res.status(400).json({ error: "Para creativo manual: se requiere imagen (imageHash o imageUrl)" })
  }
  if (creativeType === "manual" && (!primaryText || !headline || !destinationUrl)) {
    return res.status(400).json({ error: "Para creativo manual: primaryText, headline y destinationUrl son requeridos" })
  }
  if (creativeType === "igpost" && !igMediaId) {
    return res.status(400).json({ error: "Para publicación de Instagram: igMediaId es requerido" })
  }

  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken || !meta?.adAccountId) return res.status(400).json({ error: "Meta Ads no conectado" })
    const accountId = meta.adAccountId.startsWith("act_") ? meta.adAccountId : "act_" + meta.adAccountId
    const token = meta.accessToken

    // Build creative body based on type
    let creativeBody
    if (creativeType === "igpost") {
      // Promote existing Instagram post as ad
      creativeBody = {
        name: `${name} — creative`,
        source_instagram_media_id: igMediaId,
        ...(igActorId || igUserId ? { instagram_actor_id: igActorId || igUserId } : {}),
        access_token: token
      }
    } else {
      // Manual image/video creative — prefer image_hash (uploaded) over image_url
      const imageField = imageHash ? { image_hash: imageHash } : { image_url: imageUrl }
      creativeBody = {
        name: `${name} — creative`,
        object_story_spec: {
          page_id: pageId,
          ...(igActorId ? { instagram_actor_id: igActorId } : {}),
          link_data: {
            ...imageField,
            message: primaryText,
            name: headline,
            ...(description ? { description } : {}),
            link: destinationUrl,
            call_to_action: { type: ctaType, value: { link: destinationUrl } }
          }
        },
        access_token: token
      }
    }

    // Step 1: Create ad creative
    const creativeRes = await fetch(`https://graph.facebook.com/v21.0/${accountId}/adcreatives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(creativeBody)
    })
    const creativeData = await creativeRes.json()
    if (creativeData.error) return res.status(400).json({ error: "Error al crear creativo: " + creativeData.error.message })

    // Step 2: Create the ad
    const adBody = {
      name,
      adset_id: adsetId,
      creative: { creative_id: creativeData.id },
      status,
      access_token: token
    }
    const adRes = await fetch(`https://graph.facebook.com/v21.0/${accountId}/ads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adBody)
    })
    const adData = await adRes.json()
    if (adData.error) return res.status(400).json({ error: "Error al crear anuncio: " + adData.error.message })

    res.json({ ok: true, adId: adData.id, creativeId: creativeData.id, name, status })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Crealo — AI UGC Video Creation ──────────────────────────────────────────
// Lazy-load Anthropic SDK so a missing package doesn't crash the whole server
const CREATOMATE_KEY = () => process.env.CREATOMATE_API_KEY || ''
const HEYGEN_KEY = () => process.env.HEYGEN_API_KEY || ''
let _anthropic = null
function getAnthropic () {
  if (_anthropic) return _anthropic
  try {
    const Anthropic = require('@anthropic-ai/sdk')
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' })
    return _anthropic
  } catch (e) {
    throw new Error('Anthropic SDK no disponible: ' + e.message)
  }
}

// POST /api/crealo/analyze-product — fetch URL, extract OG/meta tags
app.post('/api/crealo/analyze-product', async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL requerida' })
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Veldos/1.0)' },
      signal: AbortSignal.timeout(8000)
    })
    if (!r.ok) return res.status(400).json({ error: 'No se pudo acceder a la URL (status ' + r.status + ')' })
    const html = await r.text()

    const ogGet = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["'](?:og:)?${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:)?${prop}["']`, 'i'))
      return m ? m[1].trim() : ''
    }

    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = ogGet('title') || (titleTag ? titleTag[1].trim() : '') || ''
    const description = ogGet('description') || ''
    const imageUrl = ogGet('image') || ''

    // Try to find price in JSON-LD or meta
    let price = ''
    const ldMatch = html.match(/"price"\s*:\s*"?([0-9.,]+)"?/)
    if (ldMatch) price = ldMatch[1]
    const priceMetaMatch = html.match(/content=["']([0-9.,]+)["'][^>]+(?:property|name)=["'][^"']*price[^"']*["']/i)
      || html.match(/(?:property|name)=["'][^"']*price[^"']*["'][^>]+content=["']([0-9.,]+)["']/i)
    if (!price && priceMetaMatch) price = priceMetaMatch[1]

    res.json({ title, description, price, imageUrl, url })
  } catch (e) {
    if (e.name === 'TimeoutError') return res.status(400).json({ error: 'La URL tardó demasiado en responder' })
    res.status(400).json({ error: 'No se pudo analizar la URL: ' + e.message })
  }
})

// POST /api/crealo/generate-script — generate 3 UGC script variants with Claude
app.post('/api/crealo/generate-script', async (req, res) => {
  const { product, angle, duration, tone, language } = req.body
  if (!product || !angle) return res.status(400).json({ error: 'product y angle son requeridos' })
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY no configurada' })

  const prompt = `Sos un director creativo especializado en UGC ads de alto rendimiento para Meta e Instagram.
Generá 3 variaciones de guión para un video de ${duration || 30} segundos.

PRODUCTO: ${product.title || 'Sin nombre'}
DESCRIPCIÓN: ${product.description || 'Sin descripción'}
PRECIO: ${product.price || 'No especificado'}
ÁNGULO: ${angle}
TONO: ${tone || 'Casual y cercano'}
IDIOMA: ${language || 'Español (Argentina)'}

Para cada variación generá:
1. HOOK (primeros 3 segundos — debe generar pattern interrupt y detener el scroll)
2. DESARROLLO (el mensaje central, natural, conversacional)
3. CTA (llamada a la acción clara y específica)

Reglas de ORO para UGC ads que funcionan:
- El hook NUNCA empieza con "Hola" o presentación
- Hablá directamente al dolor/deseo del cliente
- Usá lenguaje natural, no corporativo
- El CTA debe crear urgencia real
- Adaptá al idioma y cultura especificada
- Estimá duración real en segundos

Respondé SOLO con JSON válido:
{
  "scripts": [
    { "hook": "...", "body": "...", "cta": "...", "estimatedSeconds": 30 },
    { "hook": "...", "body": "...", "cta": "...", "estimatedSeconds": 28 },
    { "hook": "...", "body": "...", "cta": "...", "estimatedSeconds": 32 }
  ]
}`

  try {
    const message = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    })
    const text = message.content[0].text
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return res.status(500).json({ error: 'Claude no devolvió JSON válido' })
    const data = JSON.parse(jsonMatch[0])
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: 'Error generando guión: ' + e.message })
  }
})

// POST /api/crealo/generate-video — generate video via HeyGen or Creatomate
app.post('/api/crealo/generate-video', async (req, res) => {
  const { wsId, script, avatarId, voiceId, format = '9:16', music = 'none', product } = req.body
  if (!script) return res.status(400).json({ error: 'script es requerido' })

  const fullScript = [script.hook, script.body, script.cta].filter(Boolean).join(' ')

  try {
    let videoSourceUrl = null
    let heygenVideoId = null

    // Step 1: HeyGen if key available
    if (HEYGEN_KEY() && avatarId && avatarId !== 'placeholder_1' && !avatarId.startsWith('placeholder_')) {
      const dim = format === '9:16' ? { width: 1080, height: 1920 }
        : format === '1:1' ? { width: 1080, height: 1080 }
        : { width: 1920, height: 1080 }

      const hRes = await fetch('https://api.heygen.com/v2/video/generate', {
        method: 'POST',
        headers: { 'X-Api-Key': HEYGEN_KEY(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_inputs: [{
            character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
            voice: { type: 'text', input_text: fullScript, voice_id: voiceId || '' }
          }],
          dimension: dim
        })
      })
      const hData = await hRes.json()
      if (hData.data?.video_id) heygenVideoId = hData.data.video_id
    }

    // Step 2: Creatomate — demo video or post-processing
    if (CREATOMATE_KEY()) {
      const w = format === '9:16' ? 1080 : format === '1:1' ? 1080 : 1920
      const h = format === '9:16' ? 1920 : format === '1:1' ? 1080 : 1080
      const bgColor = '#111111'

      const elements = []
      if (videoSourceUrl) {
        elements.push({ type: 'video', source: videoSourceUrl, fit: 'cover', duration: 'auto' })
      } else {
        // Demo: text-on-background video
        elements.push({ type: 'rectangle', width: '100%', height: '100%', fill_color: bgColor })
        elements.push({
          type: 'text', text: script.hook || '',
          y: '35%', width: '85%', x_alignment: '50%',
          font_size: '5 vmin', font_weight: '700', color: '#ffffff',
          font_family: 'Montserrat'
        })
        elements.push({
          type: 'text', text: script.body || '',
          y: '55%', width: '80%', x_alignment: '50%',
          font_size: '3.5 vmin', font_weight: '400', color: 'rgba(255,255,255,0.85)',
          font_family: 'Montserrat'
        })
      }
      elements.push({
        type: 'text', text: script.cta || '',
        y: '85%', width: '85%', x_alignment: '50%',
        font_size: '6 vmin', font_weight: '700', color: '#ffffff',
        background_color: 'rgba(41,121,255,0.85)',
        background_x_padding: '8%', background_y_padding: '4%', border_radius: '8px',
        font_family: 'Montserrat'
      })

      const ctRes = await fetch('https://api.creatomate.com/v1/renders', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + CREATOMATE_KEY(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ output_format: 'mp4', width: w, height: h, elements })
      })
      const ctData = await ctRes.json()
      const render = Array.isArray(ctData) ? ctData[0] : ctData
      return res.json({
        videoId: heygenVideoId || render?.id || null,
        renderId: render?.id || null,
        renderStatus: render?.status || 'planned',
        renderUrl: render?.url || null,
        heygenVideoId,
        provider: heygenVideoId ? 'heygen' : 'creatomate',
        message: heygenVideoId
          ? 'Video en proceso con HeyGen — verificá el estado con /api/crealo/video-status'
          : 'Video en proceso con Creatomate — verificá el estado con /api/crealo/video-status'
      })
    }

    // No keys — return demo response
    res.json({
      videoId: 'demo_' + Date.now(),
      renderId: null,
      renderStatus: 'demo',
      renderUrl: null,
      heygenVideoId: null,
      provider: 'demo',
      message: 'Demo: Conectá CREATOMATE_API_KEY y/o HEYGEN_API_KEY para generar videos reales.'
    })
  } catch (e) {
    res.status(500).json({ error: 'Error generando video: ' + e.message })
  }
})

// GET /api/crealo/avatars — list HeyGen avatars or return placeholders
app.get('/api/crealo/avatars', async (req, res) => {
  if (HEYGEN_KEY()) {
    try {
      const r = await fetch('https://api.heygen.com/v2/avatars', {
        headers: { 'X-Api-Key': HEYGEN_KEY() }
      })
      const data = await r.json()
      return res.json({ avatars: data.data?.avatars || [], source: 'heygen' })
    } catch (e) {
      // fall through to placeholders
    }
  }
  const placeholderAvatars = [
    { id: 'placeholder_1', name: 'Sofía', style: 'Casual', gender: 'female', preview: null },
    { id: 'placeholder_2', name: 'Martín', style: 'Profesional', gender: 'male', preview: null },
    { id: 'placeholder_3', name: 'Valentina', style: 'Energética', gender: 'female', preview: null },
    { id: 'placeholder_4', name: 'Diego', style: 'Casual', gender: 'male', preview: null },
    { id: 'placeholder_5', name: 'Camila', style: 'Profesional', gender: 'female', preview: null },
    { id: 'placeholder_6', name: 'Lucas', style: 'Energético', gender: 'male', preview: null }
  ]
  res.json({ avatars: placeholderAvatars, source: 'placeholder' })
})

// GET /api/crealo/video-status — poll HeyGen or Creatomate for render status
app.get('/api/crealo/video-status', async (req, res) => {
  const { videoId, provider = 'creatomate', renderId } = req.query
  if (!videoId) return res.status(400).json({ error: 'videoId requerido' })

  try {
    if (provider === 'heygen' && HEYGEN_KEY()) {
      const r = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, {
        headers: { 'X-Api-Key': HEYGEN_KEY() }
      })
      const data = await r.json()
      const status = data.data?.status || 'processing'
      return res.json({
        status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'processing',
        videoUrl: data.data?.video_url || null,
        progress: data.data?.progress || 0
      })
    }

    if ((provider === 'creatomate' || !provider) && CREATOMATE_KEY()) {
      const id = renderId || videoId
      const r = await fetch(`https://api.creatomate.com/v1/renders/${id}`, {
        headers: { 'Authorization': 'Bearer ' + CREATOMATE_KEY() }
      })
      const data = await r.json()
      return res.json({
        status: data.status === 'succeeded' ? 'completed' : data.status === 'failed' ? 'failed' : 'processing',
        videoUrl: data.url || null,
        progress: data.status === 'succeeded' ? 100 : 50
      })
    }

    // Demo mode
    res.json({ status: 'completed', videoUrl: null, progress: 100, demo: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/crealo/viral-score — Claude analyzes the script and returns a viral score
app.post('/api/crealo/viral-score', async (req, res) => {
  const { script, product, angle } = req.body
  if (!script) return res.status(400).json({ error: 'script es requerido' })
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY no configurada' })

  const prompt = `Sos un experto en performance marketing en Meta e Instagram.
Analizá este guión UGC y devolvé un análisis de viralidad.

GUIÓN:
Hook: ${script.hook || ''}
Desarrollo: ${script.body || ''}
CTA: ${script.cta || ''}

PRODUCTO: ${product?.title || 'Sin especificar'}
ÁNGULO: ${angle || 'Sin especificar'}

Analizá según:
1. Fuerza del hook (0-10)
2. Claridad del mensaje (0-10)
3. Urgencia del CTA (0-10)
4. Adecuación al algoritmo de Meta/Instagram (0-10)

Respondé SOLO con JSON válido:
{
  "score": 7.5,
  "strengths": ["Punto fuerte 1", "Punto fuerte 2"],
  "improvements": ["Mejora 1", "Mejora 2"],
  "algorithmTips": [
    "Los Reels de 7-15 segundos tienen mayor tasa de visualización completa",
    "El hook en los primeros 3 segundos determina el 80% del rendimiento",
    "Videos con subtítulos tienen 40% más retención (85% ve sin sonido)",
    "Mostrá el producto en uso real antes del segundo 5",
    "Terminá con una pregunta o CTA que invite a comentar"
  ]
}`

  try {
    const message = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    })
    const text = message.content[0].text
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return res.status(500).json({ error: 'Claude no devolvió JSON válido' })
    res.json(JSON.parse(jsonMatch[0]))
  } catch (e) {
    res.status(500).json({ error: 'Error analizando guión: ' + e.message })
  }
})

// ════════════════════════════════════════════════════
// IDENTITY SYSTEM — OTP + User Memory + XP + Niveles
// ════════════════════════════════════════════════════

// WhatsApp server — en Vercel, setear WAPP_URL con URL publica (ngrok, etc.)
const WAPP_URL = process.env.WAPP_URL || 'http://localhost:3001'

const _otpMemory = new Map() // phone -> { code, expires, attempts }
const BYPASS_OTP = true  // ← poner en false para activar verificación real

function _genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function _genToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let t = ''
  for (let i = 0; i < 48; i++) t += chars[Math.floor(Math.random() * chars.length)]
  return t
}

// ── Referral code generator ──────────────────────────
function _genReferralCode(user, data) {
  if (user.codigoReferido) return user.codigoReferido
  if (!data.referidoCodes) data.referidoCodes = {}
  const base = ((user.nombre || '') + (user.apellido || ''))
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 16) || (user.telefono || '').replace(/\D/g,'').slice(-6) || 'ref'
  let code = base + '15'
  let n = 2
  while (data.referidoCodes[code] && data.referidoCodes[code] !== user.id) { code = base + n++ + '15' }
  user.codigoReferido = code
  data.referidoCodes[code] = user.id
  return code
}

function _genUserId() {
  return 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

function _normalizeAR(raw) {
  // Normaliza número argentino a formato internacional sin +
  // Acepta: 1155667788, 01155667788, 541155667788, +541155667788
  let n = raw.toString().replace(/\D/g, '')
  if (n.startsWith('0')) n = n.slice(1) // quitar 0 inicial
  if (n.length === 10 && !n.startsWith('54')) n = '549' + n
  else if (n.length === 11 && n.startsWith('0')) n = '549' + n.slice(1)
  else if (n.length === 10) n = '549' + n
  else if (n.startsWith('54') && n.length === 12) n = '549' + n.slice(2)
  return n
}

function _calcUserScore(user) {
  if (!user || !Array.isArray(user.historial)) return 0
  const weights = {
    page_view: 1,
    section_view: 2,
    product_view: 5,
    product_hover: 3,
    like_product: 8,
    unlike_product: -2,
    add_to_cart: 15,
    combo_add: 20,
    checkout_start: 25,
    checkout_complete: 80,
    order_placed: 100,
    scroll_depth: 1,
    time_on_page: 0.5,
    share: 12,
    review: 20,
  }
  let xp = 0
  for (const ev of user.historial) {
    xp += (weights[ev.evento] || 1)
  }
  return Math.round(xp)
}

function _calcNivel(xp) {
  if (xp >= 500) return { nivel: 'VIP',        emoji: '👑', minXp: 500, nextXp: null }
  if (xp >= 250) return { nivel: 'Miembro',    emoji: '⭐', minXp: 250, nextXp: 500 }
  if (xp >= 100) return { nivel: 'Conocedor',  emoji: '💎', minXp: 100, nextXp: 250 }
  if (xp >= 30)  return { nivel: 'Explorador', emoji: '🧭', minXp: 30,  nextXp: 100 }
  return           { nivel: 'Visitante',  emoji: '👋', minXp: 0,   nextXp: 30  }
}

function _calcFunnel(user) {
  if (!user || !Array.isArray(user.historial)) return 'lead'
  const evs = new Set(user.historial.map(e => e.evento))
  if (evs.has('order_placed') || evs.has('checkout_complete')) return 'cliente'
  if (evs.has('checkout_start')) return 'prospecto'
  if (evs.has('add_to_cart') || evs.has('combo_add')) return 'interesado'
  return 'lead'
}

function _calcBadges(user) {
  if (!user || !Array.isArray(user.historial)) return []
  const badges = []
  const evs = user.historial.map(e => e.evento)
  const evSet = new Set(evs)
  if (evSet.has('order_placed') || evSet.has('checkout_complete')) badges.push({ id: 'primera_compra', label: 'Primera compra', emoji: '🛍' })
  const likes = evs.filter(e => e === 'like_product').length
  if (likes >= 5) badges.push({ id: 'curadora', label: 'Curadora', emoji: '❤️' })
  if (likes >= 1) badges.push({ id: 'primer_like', label: 'Primer Like', emoji: '💖' })
  if (evSet.has('share')) badges.push({ id: 'embajadora', label: 'Embajadora', emoji: '📣' })
  const carts = evs.filter(e => e === 'add_to_cart' || e === 'combo_add').length
  if (carts >= 3) badges.push({ id: 'exploradora', label: 'Exploradora', emoji: '✨' })
  if (user.historial.length >= 50) badges.push({ id: 'leal', label: 'Cliente Leal', emoji: '🌟' })
  return badges
}

function _userPublic(user) {
  const xp = _calcUserScore(user)
  const nivelInfo = _calcNivel(xp)
  return {
    id: user.id,
    nombre: user.nombre || null,
    telefono: user.telefono || null,
    email: user.email || null,
    xp,
    nivel: nivelInfo.nivel,
    nivelEmoji: nivelInfo.emoji,
    nivelMinXp: nivelInfo.minXp,
    nivelNextXp: nivelInfo.nextXp,
    funnel: _calcFunnel(user),
    badges: _calcBadges(user),
    historial: (user.historial || []).slice(-20),
    fechaAlta: user.fechaAlta || null,
    ultimaVisita: user.ultimaVisita || null,
    totalEventos: (user.historial || []).length,
    codigoReferido: user.codigoReferido || null,
    cashbackBalance: user.cashbackBalance || 0,
    ultimoProductoVisto: user.ultimoProductoVisto || null,
    ultimoCarritoItems: user.ultimoCarritoItems || null,
    carritoAbandonado: user.carritoAbandonado || false,
    cantCompras: user.cantCompras || 0,
    valorTotalCompras: user.valorTotalCompras || 0,
  }
}

// ── POST /api/identity/request-otp ──────────────────
app.post('/api/identity/request-otp', async (req, res) => {
  const { wsId, telefono, nombre, email, utm } = req.body
  if (!wsId || !telefono) return res.status(400).json({ error: 'Faltan campos' })

  const phone = _normalizeAR(telefono)

  // BYPASS: registrar/loguear sin código
  if (BYPASS_OTP) {
    const supaHeaders = { 'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' }
    let ws
    try {
      const r = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}&select=id,data`, { headers: supaHeaders })
      const arr = await r.json()
      ws = arr[0]
    } catch (e) { return res.status(500).json({ error: 'Error cargando workspace' }) }
    if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })

    const data = ws.data || {}
    if (!data.usuarios) data.usuarios = []
    let user = data.usuarios.find(u => u.telefono === phone)
    const now = new Date().toISOString()
    if (!user) {
      user = { id: _genUserId(), telefono: phone, nombre: nombre || '', email: email || '', historial: [], fechaAlta: now, ultimaVisita: now, utm: utm || {} }
      data.usuarios.push(user)
    } else {
      user.ultimaVisita = now
      if (nombre && !user.nombre) user.nombre = nombre
      if (email && !user.email) user.email = email
    }
    // Generate referral code if not set (or update when name is now available)
    _genReferralCode(user, data)
    const token = _genToken()
    if (!data.tokens) data.tokens = {}
    data.tokens[token] = { userId: user.id, wsId, createdAt: now }
    try {
      await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}`, {
        method: 'PATCH', headers: supaHeaders, body: JSON.stringify({ data }),
      })
    } catch (e) { return res.status(500).json({ error: 'Error guardando usuario' }) }
    return res.json({ ok: true, bypass: true, token, user: _userPublic(user) })
  }

  const code = _genOtp()
  _otpMemory.set(phone, { code, expires: Date.now() + 10 * 60 * 1000, attempts: 0 })

  const msgText = `Tu código de verificación es: *${code}*\n_Válido por 10 minutos._`

  // Intentar enviar por WhatsApp
  let wappOk = false
  try {
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), 8000)
    const r = await fetch(WAPP_URL + '/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phone, text: msgText, typing: true }),
      signal: ctrl.signal,
    })
    clearTimeout(tid)
    if (r.ok) wappOk = true
  } catch (e) {
    console.log('[OTP] WhatsApp no disponible:', e.message)
  }

  // Fallback por email si WhatsApp falla y hay email
  let emailOk = false
  if (!wappOk && email && process.env.RESEND_API_KEY) {
    try {
      await _resendSend({
        from: 'VELDOS <noreply@soul-ecommlab.com>',
        to: email,
        subject: 'Tu código de verificación',
        html: `<p>Tu código es: <strong style="font-size:24px;letter-spacing:4px">${code}</strong></p><p>Válido por 10 minutos.</p>`,
      })
      emailOk = true
    } catch (e) {
      console.log('[OTP] Email fallback falló:', e.message)
    }
  }

  if (!wappOk && !emailOk) {
    return res.json({ ok: true, channel: 'dev', dev_code: process.env.NODE_ENV !== 'production' ? code : undefined })
  }

  res.json({ ok: true, channel: wappOk ? 'whatsapp' : 'email' })
})

// ── POST /api/identity/verify-otp ───────────────────
app.post('/api/identity/verify-otp', async (req, res) => {
  const { wsId, telefono, codigo } = req.body
  if (!wsId || !telefono || !codigo) return res.status(400).json({ error: 'Faltan campos' })

  const phone = _normalizeAR(telefono)
  const entry = _otpMemory.get(phone)

  if (!entry) return res.status(400).json({ error: 'No hay código pendiente. Solicitá uno nuevo.' })
  if (Date.now() > entry.expires) {
    _otpMemory.delete(phone)
    return res.status(400).json({ error: 'Código expirado. Solicitá uno nuevo.' })
  }
  entry.attempts = (entry.attempts || 0) + 1
  if (entry.attempts > 5) {
    _otpMemory.delete(phone)
    return res.status(400).json({ error: 'Demasiados intentos. Solicitá un nuevo código.' })
  }
  if (entry.code !== String(codigo).trim()) {
    return res.status(400).json({ error: 'Código incorrecto.' })
  }

  _otpMemory.delete(phone)

  // Buscar o crear usuario en Supabase
  const supaHeaders = { 'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' }

  let ws
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}&select=id,data`, { headers: supaHeaders })
    const arr = await r.json()
    ws = arr[0]
  } catch (e) {
    return res.status(500).json({ error: 'Error cargando workspace' })
  }
  if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })

  const data = ws.data || {}
  if (!data.usuarios) data.usuarios = []

  let user = data.usuarios.find(u => u.telefono === phone)
  const now = new Date().toISOString()
  if (!user) {
    user = { id: _genUserId(), telefono: phone, historial: [], fechaAlta: now, ultimaVisita: now }
    data.usuarios.push(user)
  } else {
    user.ultimaVisita = now
  }

  // Generate referral code if not already set
  _genReferralCode(user, data)

  const token = _genToken()
  if (!data.tokens) data.tokens = {}
  data.tokens[token] = { userId: user.id, wsId, createdAt: now }

  try {
    await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}`, {
      method: 'PATCH',
      headers: supaHeaders,
      body: JSON.stringify({ data }),
    })
  } catch (e) {
    return res.status(500).json({ error: 'Error guardando usuario' })
  }

  res.json({ ok: true, token, user: _userPublic(user) })
})

// ── GET /api/identity/me ─────────────────────────────
app.get('/api/identity/me', async (req, res) => {
  const auth = req.headers.authorization || ''
  const token = auth.replace('Bearer ', '').trim()
  const wsId = req.query.wsId
  if (!token || !wsId) return res.status(401).json({ error: 'No autorizado' })

  const supaHeaders = { 'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(), 'Content-Type': 'application/json' }
  let ws
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}&select=id,data`, { headers: supaHeaders })
    const arr = await r.json()
    ws = arr[0]
  } catch (e) {
    return res.status(500).json({ error: 'Error' })
  }
  if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })

  const data = ws.data || {}
  const tokenEntry = (data.tokens || {})[token]
  if (!tokenEntry) return res.status(401).json({ error: 'Token inválido' })

  // Expirar tokens con más de 365 días sin uso
  const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000
  const lastUsed = tokenEntry.lastUsed || tokenEntry.createdAt
  if (lastUsed && Date.now() - new Date(lastUsed).getTime() > TOKEN_TTL_MS) {
    delete data.tokens[token]
    patchWorkspace(wsId, data).catch(() => {})
    return res.status(401).json({ error: 'Sesión expirada' })
  }

  const user = (data.usuarios || []).find(u => u.id === tokenEntry.userId)
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })

  // Renovar lastUsed y generar código de referido si falta
  data.tokens[token].lastUsed = new Date().toISOString()
  const hadCode = !!user.codigoReferido
  _genReferralCode(user, data)
  patchWorkspace(wsId, data).catch(() => {})

  res.json({ ok: true, user: _userPublic(user) })
})

// ── POST /api/identity/track ─────────────────────────
app.post('/api/identity/track', async (req, res) => {
  const auth = req.headers.authorization || ''
  const token = auth.replace('Bearer ', '').trim()
  const { wsId, evento, datos } = req.body
  if (!token || !wsId || !evento) return res.status(400).json({ error: 'Faltan campos' })

  const supaHeaders = { 'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(), 'Content-Type': 'application/json' }
  let ws
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}&select=id,data`, { headers: supaHeaders })
    const arr = await r.json()
    ws = arr[0]
  } catch (e) {
    return res.status(500).json({ error: 'Error' })
  }
  if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })

  const data = ws.data || {}
  const tokenEntry = (data.tokens || {})[token]
  if (!tokenEntry) return res.status(401).json({ error: 'Token inválido' })

  const user = (data.usuarios || []).find(u => u.id === tokenEntry.userId)
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })

  if (!user.historial) user.historial = []
  user.historial.push({ evento, datos: datos || {}, ts: new Date().toISOString() })
  user.ultimaVisita = new Date().toISOString()

  try {
    await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}`, {
      method: 'PATCH',
      headers: supaHeaders,
      body: JSON.stringify({ data }),
    })
  } catch (e) {
    return res.status(500).json({ error: 'Error guardando evento' })
  }

  const xp = _calcUserScore(user)
  res.json({ ok: true, xp, nivel: _calcNivel(xp) })
})

// ── POST /api/identity/journey ───────────────────────
app.post('/api/identity/journey', async (req, res) => {
  const { wsId, token, evento, datos, ts } = req.body
  if (!wsId || !token || !evento) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    const tokenEntry = (data.tokens||{})[token]
    if (!tokenEntry) return res.status(401).json({ error: 'Token inválido' })
    const user = (data.usuarios||[]).find(u => u.id === tokenEntry.userId)
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })

    if (!user.journey) user.journey = []
    const now = ts || new Date().toISOString()
    const entry = { evento, datos: datos||{}, ts: now }
    user.journey.push(entry)
    if (user.journey.length > 1000) user.journey = user.journey.slice(-1000)

    // Update summary fields based on event
    if (evento === 'session_start') {
      user.ultimaVisita = now
      user.totalVisitas = (user.totalVisitas||0) + 1
      if (datos?.device) user.dispositivo = datos.device
      if (datos?.utm?.utm_source) user.utmSource = datos.utm.utm_source
    }

    if (evento === 'heartbeat') {
      user.tiempoTotalSeg = (user.tiempoTotalSeg||0) + 60
    }

    if (evento === 'view_product') {
      if (!user.productosVisitados) user.productosVisitados = []
      const existing = user.productosVisitados.find(p => p.id === datos?.productoId)
      if (existing) {
        existing.vistas = (existing.vistas||1) + 1
        existing.ultimaVista = now
      } else {
        user.productosVisitados.push({ id: datos?.productoId, nombre: datos?.productoNombre, precio: datos?.precio, categoria: datos?.categoria, vistas: 1, ultimaVista: now })
      }
      if (user.productosVisitados.length > 100) user.productosVisitados = user.productosVisitados.slice(-100)
      user.ultimoProductoVisto = datos?.productoNombre
      user.ultimaVisita = now
      // Histórico persistente de interacciones
      if (!user.historialInteracciones) user.historialInteracciones = []
      user.historialInteracciones.push({ tipo: 'producto_visto', payload: { id: datos?.productoId, nombre: datos?.productoNombre, precio: datos?.precio }, ts: now })
      if (user.historialInteracciones.length > 200) user.historialInteracciones = user.historialInteracciones.slice(-200)
    }

    if (evento === 'add_cart') {
      user.ultimoCarrito = now
      user.carritoAbandonado = false
      user.totalAgregadosCarrito = (user.totalAgregadosCarrito||0) + 1
    }

    if (evento === 'cart_update') {
      user.ultimoCarrito = now
      user.ultimoCarritoItems = datos?.items || null
      user.carritoAbandonado = (datos?.items?.length || 0) > 0
    }

    if (evento === 'cart_abandon') {
      user.carritoAbandonado = true
      user.ultimoAbandonoCarrito = now
      user.totalAbandonos = (user.totalAbandonos||0) + 1
      user.valorAbandonado = datos?.total || 0
      // Histórico persistente de interacciones
      if (!user.historialInteracciones) user.historialInteracciones = []
      user.historialInteracciones.push({ tipo: 'carrito_abandonado', payload: { items: datos?.items || [], total: datos?.total || 0 }, ts: now })
      if (user.historialInteracciones.length > 200) user.historialInteracciones = user.historialInteracciones.slice(-200)
    }

    if (evento === 'purchase') {
      user.carritoAbandonado = false
      user.cantCompras = (user.cantCompras||0) + 1
      user.ultimaCompra = now
      user.valorTotalCompras = (user.valorTotalCompras||0) + (datos?.total||0)
      user.ultimaVisita = now
      // Sync to CRM if phone exists
      if (user.telefono) {
        const phone = user.telefono.replace(/\D/g,'')
        const crmContact = (data.crm||[]).find(c => (c.tel||'').replace(/\D/g,'') === phone)
        if (crmContact) {
          crmContact.cantCompras = user.cantCompras
          crmContact.valorTotal = user.valorTotalCompras
          crmContact.ultimaCompra = now
          crmContact.etapa = 'cliente'
        }
      }
    }

    await patchWorkspace(wsId, data)
    _invalidateWsCache(wsId)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/identity/analytics — aggregate analytics for admin ──
app.get('/api/identity/analytics', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  res.set('Cache-Control', 'no-store')
  // Forzar lectura fresca — invalidar caché para ver datos de compras recientes
  _invalidateWsCache(wsId)
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    // Cruzar cantCompras con d.crm para mayor precisión
    const crmMap = {}
    ;(data.crm || []).forEach(c => {
      const tel = (c.tel || '').replace(/\D/g,'')
      const email = (c.email || '').toLowerCase()
      const key = tel || email
      if (key) crmMap[key] = c
    })
    const usuarios = (data.usuarios || []).map(u => {
      // Si el usuario tiene compras en CRM pero no en usuarios, sincronizar
      const tel = (u.telefono || '').replace(/\D/g,'')
      const email = (u.email || '').toLowerCase()
      const crmContact = crmMap[tel] || crmMap[email]
      if (crmContact && (crmContact.cantCompras || 0) > (u.cantCompras || 0)) {
        return { ...u, cantCompras: crmContact.cantCompras, valorTotalCompras: crmContact.valorTotal || u.valorTotalCompras }
      }
      return u
    })
    const now = new Date()
    const hoy = now.toISOString().slice(0,10)
    const hace7 = new Date(now-7*864e5).toISOString()
    const hace30 = new Date(now-30*864e5).toISOString()

    const stats = {
      totalClientes: usuarios.length,
      activosHoy: usuarios.filter(u => u.ultimaVisita?.startsWith(hoy)).length,
      activos7dias: usuarios.filter(u => u.ultimaVisita > hace7).length,
      activos30dias: usuarios.filter(u => u.ultimaVisita > hace30).length,
      carritoAbandonado: usuarios.filter(u => u.carritoAbandonado).length,
      compradores: usuarios.filter(u => u.cantCompras > 0).length,
      revenueTotal: usuarios.reduce((s,u) => s+(u.valorTotalCompras||0), 0),
      topProductos: (() => {
        const map = {}
        usuarios.forEach(u => (u.productosVisitados||[]).forEach(p => {
          if (!p || !p.id) return
          if (!map[p.id]) map[p.id] = { nombre: p.nombre, vistas: 0 }
          map[p.id].vistas += p.vistas||1
        }))
        return Object.values(map).sort((a,b)=>b.vistas-a.vistas).slice(0,10)
      })(),
      clientesAbandonaron: usuarios
        .filter(u => u.carritoAbandonado && u.telefono)
        .map(u => ({ nombre: u.nombre, tel: u.telefono, valor: u.valorAbandonado, fecha: u.ultimoAbandonoCarrito }))
        .slice(0,20)
    }
    res.json({ ok: true, stats, usuarios: usuarios.map(u => ({
      id: u.id, nombre: u.nombre, telefono: u.telefono, email: u.email,
      ultimaVisita: u.ultimaVisita, totalVisitas: u.totalVisitas,
      cantCompras: u.cantCompras, valorTotalCompras: u.valorTotalCompras,
      carritoAbandonado: u.carritoAbandonado, ultimoAbandonoCarrito: u.ultimoAbandonoCarrito,
      ultimoCarrito: u.ultimoCarrito || null,
      ultimoCarritoItems: u.ultimoCarritoItems || null,
      productosVisitados: (u.productosVisitados||[]).slice(-10),
      tiempoTotalMin: Math.round((u.tiempoTotalSeg||0)/60),
      dispositivo: u.dispositivo, etapa: u.etapa,
      ultimoProductoVisto: u.ultimoProductoVisto
    })) })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/identity/sync-crm — bidirectional sync ──────────────────
app.post('/api/identity/sync-crm', async (req, res) => {
  const { wsId } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: 'WS no encontrado' })
    const data = ws.data || {}
    const usuarios = data.usuarios || []
    if (!data.crm) data.crm = []
    let synced = 0, created = 0

    usuarios.forEach(u => {
      const telClean = (u.telefono || '').replace(/\D/g,'')
      const emailClean = (u.email || '').toLowerCase().trim()
      if (!telClean && !emailClean) return // sin identificador, no sincronizar

      // Buscar contacto en CRM por tel o email
      let contact = null
      if (telClean) contact = data.crm.find(c => (c.tel||'').replace(/\D/g,'') === telClean)
      if (!contact && emailClean) contact = data.crm.find(c => (c.email||'').toLowerCase().trim() === emailClean)

      if (contact) {
        // Actualizar contacto existente con datos de identidad
        // Siempre tomar el máximo de compras (evita regresiones)
        const uCompras = u.cantCompras || 0
        const cCompras = parseInt(contact.cantCompras) || 0
        if (uCompras > cCompras) {
          contact.cantCompras = uCompras
          contact.valorTotal = Math.max(parseFloat(contact.valorTotal)||0, u.valorTotalCompras||0)
          if (u.ultimaCompra) contact.ultimaCompra = u.ultimaCompra
          contact.etapa = 'cliente'
        }
        // Enriquecer contacto con datos faltantes
        if (!contact.email && emailClean) contact.email = emailClean
        if (!contact.tel && telClean) contact.tel = telClean
        if (!contact.nombre && u.nombre) contact.nombre = u.nombre
        if (u.carritoAbandonado) contact.carritoAbandonado = true
        if (u.productosVisitados?.length) {
          contact.productosVisitados = u.productosVisitados.map(p => p.nombre || p).filter(Boolean).slice(0, 10)
        }
        synced++
      } else if (u.cantCompras > 0 || u.nombre) {
        // Crear nuevo contacto en CRM solo si tiene compras o tiene nombre
        const nameParts = (u.nombre || '').trim().split(' ')
        data.crm.push({
          id: 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,5),
          nombre: nameParts[0] || '',
          apellido: nameParts.slice(1).join(' ') || '',
          email: emailClean,
          tel: telClean,
          etapa: u.cantCompras > 0 ? 'cliente' : 'lead',
          cantCompras: u.cantCompras || 0,
          valorTotal: u.valorTotalCompras || 0,
          ultimaCompra: u.ultimaCompra || null,
          carritoAbandonado: u.carritoAbandonado || false,
          productosVisitados: (u.productosVisitados||[]).map(p => p.nombre || p).filter(Boolean).slice(0, 10),
          canal: 'Tienda propia',
          origen: 'clientes_web',
          creado: u.fechaAlta || new Date().toISOString().slice(0,10),
        })
        created++
      }

      // Reverse: también actualizar identity user con datos del CRM
      if (contact) {
        const cCompras = parseInt(contact.cantCompras) || 0
        if (cCompras > (u.cantCompras || 0)) {
          u.cantCompras = cCompras
          u.valorTotalCompras = Math.max(u.valorTotalCompras||0, parseFloat(contact.valorTotal)||0)
          if (contact.ultimaCompra) u.ultimaCompra = contact.ultimaCompra
          u.etapa = 'cliente'
        }
      }
    })

    await patchWorkspace(wsId, data)
    _invalidateWsCache(wsId)
    res.json({ ok: true, synced, created, total: usuarios.length })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/identity/users (admin) ─────────────────
app.get('/api/identity/users', async (req, res) => {
  const wsId = req.query.wsId
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })

  const supaHeaders = { 'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(), 'Content-Type': 'application/json' }
  let ws
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}&select=id,data`, { headers: supaHeaders })
    const arr = await r.json()
    ws = arr[0]
  } catch (e) {
    return res.status(500).json({ error: 'Error' })
  }
  if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })

  const usuarios = ((ws.data || {}).usuarios || []).map(_userPublic)
  res.json({ ok: true, total: usuarios.length, usuarios })
})

// ── GET /api/identity/user/:id (admin) ──────────────
app.get('/api/identity/user/:id', async (req, res) => {
  const { id } = req.params
  const wsId = req.query.wsId
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })

  const supaHeaders = { 'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(), 'Content-Type': 'application/json' }
  let ws
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}&select=id,data`, { headers: supaHeaders })
    const arr = await r.json()
    ws = arr[0]
  } catch (e) {
    return res.status(500).json({ error: 'Error' })
  }
  if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })

  const user = ((ws.data || {}).usuarios || []).find(u => u.id === id)
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })

  res.json({ ok: true, user: _userPublic(user) })
})

// ── PATCH /api/identity/user/:id (admin) ─────────────
app.patch('/api/identity/user/:id', async (req, res) => {
  const { id } = req.params
  const wsId = req.query.wsId
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })

  const supaHeaders = { 'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(), 'Content-Type': 'application/json' }
  let ws
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}&select=id,data`, { headers: supaHeaders })
    const arr = await r.json()
    ws = arr[0]
  } catch (e) {
    return res.status(500).json({ error: 'Error' })
  }
  if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })

  const data = ws.data || {}
  const idx = (data.usuarios || []).findIndex(u => u.id === id)
  if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' })

  const allowed = ['nombre', 'email', 'notas', 'tags']
  for (const k of allowed) {
    if (req.body[k] !== undefined) data.usuarios[idx][k] = req.body[k]
  }

  try {
    await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}`, {
      method: 'PATCH',
      headers: supaHeaders,
      body: JSON.stringify({ data }),
    })
  } catch (e) {
    return res.status(500).json({ error: 'Error guardando' })
  }

  res.json({ ok: true, user: _userPublic(data.usuarios[idx]) })
})


// ════════════════════════════════════════════════════
// STORE ROUTES — /api/store/*
// ════════════════════════════════════════════════════

// Helper to get tienda sub-data from workspace
async function getTienda(wsId) {
  const ws = await getWorkspace(wsId)
  if (!ws) return null
  const d = ws.data || {}
  if (!d.tienda) d.tienda = {}
  return { ws, d, t: d.tienda }
}

async function saveTienda(wsId, tienda, d) {
  const updated = { ...d, tienda }
  await patchWorkspace(wsId, updated)
}

// Direct write — skips the merge-read step in patchWorkspace.
// Use ONLY when the caller already holds the latest workspace data
// (e.g. checkout handler that just called getTienda at the top of the request).
async function _writeDirect(wsId, data) {
  _wsCache.delete(wsId)
  const saveRes = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(),
      'Content-Type': 'application/json', 'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ data })
  })
  if (!saveRes.ok) {
    const errText = await saveRes.text().catch(() => '')
    console.error(`[_writeDirect] Save failed for ${wsId}: ${saveRes.status} ${errText.slice(0,200)}`)
    throw new Error('Error guardando pedido (' + saveRes.status + ')')
  }
}

// ── GET /api/store/public — public store data for storefront
app.get('/api/store/public', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  // Sin cache — siempre leer la data más fresca de Supabase
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
  try {
    const { t } = await getTienda(wsId).then(r => r || {}).catch(() => ({}))
    if (!t) return res.status(404).json({ error: 'Tienda no encontrada' })
    const tSettings = t.settings || {}
    // Construir config pública de PayWay (sin private key) con fallback a env vars
    const pwCfg = tSettings.payway || {}
    const paywayPublic = {
      siteId:     pwCfg.siteId     || process.env.PAYWAY_SITE_ID     || '',
      templateId: pwCfg.templateId || process.env.PAYWAY_TEMPLATE_ID || '',
      publicKey:  pwCfg.publicKey  || process.env.PAYWAY_PUBLIC_KEY  || '',
      sandbox:    pwCfg.sandbox    || false,
      activo:     !!(pwCfg.siteId || process.env.PAYWAY_SITE_ID),
    }
    res.json({
      settings:  { ...tSettings, payway: paywayPublic },
      productos: (t.productos || []).filter(p => p.activo !== false),
      secciones: t.secciones || [],
      paginas:   (t.paginas  || []).filter(p => p.activo !== false),
      guias:     t.guias     || [],
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/store/products — list all products (admin)
app.get('/api/store/products', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    res.json({ productos: result.t.productos || [] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/store/products — create product (admin)
app.post('/api/store/products', async (req, res) => {
  const { wsId, producto } = req.body
  if (!wsId || !producto) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    if (!t.productos) t.productos = []
    const newProd = { ...producto, id: 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6), createdAt: new Date().toISOString() }
    t.productos.push(newProd)
    await saveTienda(wsId, t, d)
    res.json({ ok: true, producto: newProd })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── PUT /api/store/products/:id — update product (admin)
app.put('/api/store/products/:id', async (req, res) => {
  const { id } = req.params
  const { wsId, producto } = req.body
  if (!wsId || !producto) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    const idx = (t.productos || []).findIndex(p => p.id === id)
    if (idx === -1) return res.status(404).json({ error: 'Producto no encontrado' })
    t.productos[idx] = { ...t.productos[idx], ...producto, id, updatedAt: new Date().toISOString() }
    await saveTienda(wsId, t, d)
    res.json({ ok: true, producto: t.productos[idx] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── DELETE /api/store/products/:id — delete product (admin)
app.delete('/api/store/products/:id', async (req, res) => {
  const { id } = req.params
  const { wsId } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    t.productos = (t.productos || []).filter(p => p.id !== id)
    await saveTienda(wsId, t, d)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ════════════════════════════════════════════════════
// DIFUSION JOBS — persistencia para reanudar envíos
// ════════════════════════════════════════════════════

// GET /api/store/dif-jobs — obtener jobs del workspace
app.get('/api/store/dif-jobs', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  res.set('Cache-Control', 'no-store')
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    res.json({ jobs: result.t.difJobs || [] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/store/dif-job — crear o actualizar un job (checkpoint)
app.post('/api/store/dif-job', async (req, res) => {
  const { wsId, job } = req.body
  if (!wsId || !job || !job.id) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    if (!t.difJobs) t.difJobs = []
    const idx = t.difJobs.findIndex(j => j.id === job.id)
    if (idx >= 0) t.difJobs[idx] = { ...t.difJobs[idx], ...job } // merge: preserva indices si el checkpoint no los trae
    else t.difJobs.push(job)
    // Conservar solo los últimos 30 jobs
    if (t.difJobs.length > 30) t.difJobs = t.difJobs.slice(-30)
    await saveTienda(wsId, t, d)
    _invalidateWsCache(wsId)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ════════════════════════════════════════════════════
// WA QUEUE — cola de mensajes con rate limiting
// ════════════════════════════════════════════════════

app.get('/api/store/wa-queue', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  res.set('Cache-Control', 'no-store')
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'WS no encontrado' })
    res.json({ queue: result.t.waQueue || [], config: result.t.waQueueConfig || {} })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/store/wa-queue', async (req, res) => {
  const { wsId, queue, config } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'WS no encontrado' })
    const { t, d } = result
    if (queue !== undefined) {
      // Conservar solo pendientes + últimos 200 enviados
      const sent = (queue || []).filter(i => i.status !== 'pending').slice(-200)
      const pending = (queue || []).filter(i => i.status === 'pending')
      t.waQueue = [...pending, ...sent]
    }
    if (config !== undefined) t.waQueueConfig = config
    await saveTienda(wsId, t, d)
    _invalidateWsCache(wsId)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/store/guias — list size guides
app.get('/api/store/guias', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    res.json({ guias: result.t.guias || [] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/store/guias — save size guides
app.post('/api/store/guias', async (req, res) => {
  const { wsId, guias } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    t.guias = guias || []
    await saveTienda(wsId, t, d)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/store/sections — save page builder sections
app.post('/api/store/sections', async (req, res) => {
  const { wsId, secciones } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    t.secciones = secciones || []
    await saveTienda(wsId, t, d)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/store/settings — read store settings
app.get('/api/store/settings', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    res.json({ settings: result.t.settings || {} })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/store/settings — save store settings
app.post('/api/store/settings', async (req, res) => {
  const { wsId, settings } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    t.settings = { ...(t.settings || {}), ...settings }
    await saveTienda(wsId, t, d)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/store/capture-contact — direct lead capture (no OTP) ──
app.post('/api/store/capture-contact', async (req, res) => {
  const { wsId, nombre, tel, email, utm } = req.body
  if (!wsId || (!tel && !email)) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })
    const data = ws.data || {}

    // ── Upsert CRM contact ──
    if (!data.crm) data.crm = []
    const phone = tel ? tel.replace(/\D/g, '') : ''
    const emailLow = (email || '').toLowerCase().trim()
    let crmContact = data.crm.find(c =>
      (phone && c.tel && c.tel.replace(/\D/g, '') === phone) ||
      (emailLow && c.email && c.email.toLowerCase() === emailLow)
    )
    const now = new Date().toISOString().slice(0, 10)
    const isNewContact = !crmContact
    if (!crmContact) {
      crmContact = {
        id: 'c' + Date.now(),
        nombre: nombre || '',
        email: emailLow || '',
        tel: phone,
        etapa: 'prospecto',
        estado: 'Nuevo',
        tags: ['tienda'],
        fechaAlta: now,
        creado: now,
        ultimoContacto: now,
        contactos: [{ fecha: now, nota: 'Captura en tienda', tipo: 'auto' }]
      }
      data.crm.push(crmContact)
    } else {
      if (nombre && !crmContact.nombre) crmContact.nombre = nombre
      if (emailLow && !crmContact.email) crmContact.email = emailLow
      if (phone && !crmContact.tel) crmContact.tel = phone
      crmContact.ultimoContacto = now
    }

    // ── Upsert "Contactos de Mi Tienda" static list ──
    if (!data.difListas) data.difListas = []
    let lista = data.difListas.find(l => l.nombre === 'Contactos de Mi Tienda')
    if (!lista) {
      lista = {
        id: 'dl_tienda',
        nombre: 'Contactos de Mi Tienda',
        tipo: 'estatica',
        filtros: {},
        contactIds: [],
        creado: now,
        ultimaDifusion: null
      }
      data.difListas.push(lista)
    }
    if (!lista.contactIds) lista.contactIds = []
    if (!lista.contactIds.includes(crmContact.id)) {
      lista.contactIds.push(crmContact.id)
    }

    const sessionToken = _genToken()
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    await patchWorkspace(wsId, data)
    _invalidateWsCache(wsId)
    res.json({ ok: true, contactId: crmContact.id, token: sessionToken, nombre: crmContact.nombre, email: crmContact.email })

    // ── Also persist contact to Supabase contacts table ──
    await db_upsertContact(wsId, {
      id: crmContact.id,
      nombre: crmContact.nombre,
      email: crmContact.email || '',
      tel: crmContact.tel || '',
      estado: crmContact.estado || 'Lead',
      etapa: crmContact.etapa || 'lead',
      canal: crmContact.canal || 'Popup',
      creado: crmContact.creado || now,
      tags: crmContact.tags || ['popup'],
      origen: 'popup',
    }).then(() => db_updateContactFields(wsId, crmContact.id, { vldToken: sessionToken, vldTokenExpiry: tokenExpiry }))
      .catch(e2 => console.error('[capture-contact] db:', e2.message))

    // ── Auto-add to "Pop Up web" list ──
    await _addContactToList(wsId, 'Pop Up web', 'dl_popup_web', crmContact.id)
      .catch(e2 => console.error('[capture-contact] addToList:', e2.message))

    // ── Disparar flow new_lead — para todos (nuevo o existente que llena el form)
    // flowDone con clave nl_${creado} evita que se repita para el mismo contacto
    _processImmediateFlows(wsId, data, crmContact, ['new_lead'], {})
      .catch(e2 => console.error('[flows] new_lead error:', e2.message))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/store/me — verify persistent session token, return profile ──
app.get('/api/store/me', async (req, res) => {
  const { wsId, token } = req.query
  if (!wsId || !token) return res.status(400).json({ ok: false, error: 'Faltan campos' })
  try {
    const contact = await db_findContactByToken(wsId, token)
    if (!contact) return res.json({ ok: false, error: 'Sesión no encontrada' })
    if (contact.vldTokenExpiry && new Date(contact.vldTokenExpiry) < new Date()) {
      return res.json({ ok: false, error: 'Sesión expirada' })
    }
    res.json({
      ok: true,
      nombre: contact.nombre || '',
      email: contact.email || '',
      tel: contact.tel || '',
      xp: contact.xp || 0,
      cashback: contact.cashback || 0,
      cantCompras: contact.cantCompras || 0,
      ultimaCompra: contact.ultimaCompra || null
    })
  } catch(e) { res.status(500).json({ ok: false, error: e.message }) }
})

// ── GET /api/dif/listas ── fetch broadcast lists from workspace
app.get('/api/dif/listas', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'wsId requerido' })
  try {
    const ws = await getWorkspace(wsId)
    res.json(ws?.data?.difListas || [])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/dif/listas ── create or update a broadcast list
app.post('/api/dif/listas', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'wsId requerido' })
  const lista = req.body
  if (!lista?.nombre) return res.status(400).json({ error: 'nombre requerido' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    if (!data.difListas) data.difListas = []
    const idx = lista.id ? data.difListas.findIndex(l => l.id === lista.id) : -1
    if (idx >= 0) {
      data.difListas[idx] = { ...data.difListas[idx], ...lista }
    } else {
      if (!lista.id) lista.id = 'dl_' + Date.now()
      data.difListas.unshift(lista)
    }
    await patchWorkspace(wsId, { difListas: data.difListas })
    _invalidateWsCache(wsId)
    const saved = idx >= 0 ? data.difListas[idx] : data.difListas[0]
    res.json({ ok: true, lista: saved })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── DELETE /api/dif/listas/:id ── delete a broadcast list
app.delete('/api/dif/listas/:id', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'wsId requerido' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    data.difListas = (data.difListas || []).filter(l => l.id !== req.params.id)
    await patchWorkspace(wsId, { difListas: data.difListas })
    _invalidateWsCache(wsId)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/dif/listas/:id/members ── add or remove contactIds from a list
app.post('/api/dif/listas/:id/members', async (req, res) => {
  const { wsId } = req.query
  const { add = [], remove = [] } = req.body
  if (!wsId) return res.status(400).json({ error: 'wsId requerido' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    const lista = (data.difListas || []).find(l => l.id === req.params.id)
    if (!lista) return res.status(404).json({ error: 'Lista no encontrada' })
    if (!lista.contactIds) lista.contactIds = []
    for (const id of add) {
      if (!lista.contactIds.includes(id)) lista.contactIds.push(id)
    }
    lista.contactIds = lista.contactIds.filter(id => !remove.includes(id))
    await patchWorkspace(wsId, { difListas: data.difListas })
    _invalidateWsCache(wsId)
    res.json({ ok: true, count: lista.contactIds.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/store/checkout — submit order from storefront
app.post('/api/store/checkout', async (req, res) => {
  const { wsId, items, cliente, envio, ecid } = req.body
  if (!wsId || !items || !cliente) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result

    const productos = t.productos || []
    // Compute total
    let total = 0
    const lineas = items.map(item => {
      const p = productos.find(x => x.id === item.id) || {}
      const precio = Number(p.precio || 0)
      const cantidad = Number(item.cantidad || 1)
      total += precio * cantidad
      return { id: item.id, nombre: p.nombre || item.id, precio, cantidad }
    })

    // Decrement stock
    items.forEach(item => {
      const idx = productos.findIndex(p => p.id === item.id)
      if (idx >= 0 && productos[idx].stock != null) {
        productos[idx].stock = Math.max(0, (productos[idx].stock || 0) - Number(item.cantidad || 1))
      }
    })
    t.productos = productos

    // Apply coupon discount if provided
    const cuponCodigo = req.body.cuponCodigo
    const descuento = Number(req.body.descuento) || 0
    if (descuento > 0 && descuento < total) total = Math.max(0, total - descuento)

    // ── Transfer discount ─────────────────────────────────────────────
    const transferDiscountPct = Number(req.body.transferDiscount || 0)
    let descuentoTransfer = 0
    if (transferDiscountPct > 0 && transferDiscountPct <= 50) {
      descuentoTransfer = Math.round(total * transferDiscountPct / 100)
      total = Math.max(0, total - descuentoTransfer)
    }

    // ── Referral code discount (10% OFF) ──────────────────────────────
    const codigoReferido = (req.body.codigoReferido || '').toLowerCase().trim()
    const usarCashback = !!req.body.usarCashback
    const authToken = (req.headers.authorization || '').replace('Bearer ','').trim()
    let referrerId = null, descuentoReferido = 0, descuentoCashback = 0
    const totalAntesDescuentos = total

    const refCfg = d.tienda?.settings?.referidosConfig || {}
    const pctDescuento = Number(refCfg.pctDescuento ?? 10) / 100
    const pctCashback  = Number(refCfg.pctCashback  ?? 10) / 100

    if (codigoReferido && (d.referidoCodes || {})[codigoReferido]) {
      referrerId = d.referidoCodes[codigoReferido]
      const selfUser = authToken ? (d.usuarios||[]).find(u => u.id === (d.tokens||{})[authToken]?.userId) : null
      if (!selfUser || selfUser.id !== referrerId) {
        descuentoReferido = Math.round(total * pctDescuento)
        total = Math.max(0, total - descuentoReferido)
      } else {
        referrerId = null
      }
    }

    // ── Cashback discount ────────────────────────────────────────────
    if (usarCashback && authToken) {
      const selfUser = (d.usuarios||[]).find(u => u.id === (d.tokens||{})[authToken]?.userId)
      if (selfUser && (selfUser.cashbackBalance||0) > 0) {
        descuentoCashback = Math.min(selfUser.cashbackBalance, total)
        total = Math.max(0, total - descuentoCashback)
      }
    }

    // Add shipping cost to total
    const envioAmt = Number(envio) || 0
    total = total + envioAmt

    // Save order
    if (!t.ordenes) t.ordenes = []
    const numero = (t.ordenes.length || 0) + 1
    const orden = {
      id: 'o_' + Date.now().toString(36),
      numero,
      cliente,
      envio: envio || null,
      metodoEnvio: cliente.envioTipo || (envio != null ? 'envio' : 'retiro'),
      envioNombre: cliente.envioMethodName || '',
      lineas,
      total,
      estado: 'pendiente',
      fecha: new Date().toISOString(),
      cupon: cuponCodigo || undefined,
      descuento: descuento || undefined,
      codigoReferido: codigoReferido || undefined,
      descuentoReferido: descuentoReferido || undefined,
      descuentoCashback: descuentoCashback || undefined,
      metodoPago: req.body.metodoPago || 'transferencia',
      ecid: ecid || undefined,
    }
    t.ordenes.push(orden)

    // PayWay payment processing
    const paywayToken = req.body.paywayToken
    const paywayBin   = req.body.paywayBin || ''
    const cuotas      = Number(req.body.cuotas) || 1
    if (paywayToken && t.settings?.payway?.privateKey) {
      const pw = t.settings.payway
      const pwUrl = pw.sandbox
        ? 'https://developers.decidir.com/api/v2/payments'
        : 'https://live.decidir.com/api/v2/payments'
      const pwBody = {
        site_transaction_id: orden.id,
        token: paywayToken,
        customer: { id: cliente.tel || cliente.email || 'guest', email: cliente.email || '' },
        payment_method_id: 1, // PayWay auto-detecta con el bin/token
        bin: paywayBin,
        amount: Math.round(total * 100), // centavos
        currency: 'ARS',
        installments: cuotas,
        description: `Pedido #${numero}`,
        payment_type: 'single',
        sub_payments: []
      }
      if (pw.siteId) pwBody.site_id = String(pw.siteId)
      try {
        const pwRes = await fetch(pwUrl, {
          method: 'POST',
          headers: { 'apikey': pw.privateKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(pwBody)
        })
        const pwData = await pwRes.json()
        if (pwData.status === 'approved' || pwData.status === 'pre_approved') {
          orden.estado = 'pagado'
          orden.metodoPago = 'tarjeta'
          orden.paywayId = pwData.id
        } else {
          // Pago rechazado — no guardar la orden
          return res.status(402).json({ error: 'Pago rechazado: ' + (pwData.status_details?.[0]?.response?.message || pwData.status || 'Error') })
        }
      } catch(e) {
        return res.status(500).json({ error: 'Error procesando pago: ' + e.message })
      }
    }

    // ── Sincronizar cliente al CRM ──────────────────────────────
    if (!d.crm) d.crm = []
    const telClean = (cliente.tel || '').replace(/\D/g, '')
    const emailClean = (cliente.email || '').toLowerCase().trim()
    const fechaCompra = new Date().toISOString().slice(0, 10)

    let crmIdx = -1
    if (telClean) crmIdx = d.crm.findIndex(c => (c.tel || '').replace(/\D/g,'') === telClean)
    if (crmIdx === -1 && emailClean) crmIdx = d.crm.findIndex(c => (c.email||'').toLowerCase() === emailClean)

    if (crmIdx >= 0) {
      d.crm[crmIdx].cantCompras = (parseInt(d.crm[crmIdx].cantCompras) || 0) + 1
      d.crm[crmIdx].valorTotal  = (parseFloat(d.crm[crmIdx].valorTotal) || 0) + total
      d.crm[crmIdx].ultimaCompra = fechaCompra
      d.crm[crmIdx].ultimoPedido = String(numero || '')
      d.crm[crmIdx].etapa = 'cliente'
      d.crm[crmIdx].estado = 'Cliente'  // asegurar que estado quede seteado
      // Deduplicación: mismo teléfono/email = mismo cliente aunque cambie el nombre
      // → actualizar nombre al más reciente (el de esta compra)
      if (cliente.nombre) d.crm[crmIdx].nombre = cliente.nombre
      if (cliente.apellido !== undefined) d.crm[crmIdx].apellido = cliente.apellido || d.crm[crmIdx].apellido || ''
      if (!d.crm[crmIdx].email && emailClean) d.crm[crmIdx].email = emailClean
      if (!d.crm[crmIdx].tel && telClean) d.crm[crmIdx].tel = telClean
    } else {
      d.crm.push({
        id: 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,5),
        nombre: cliente.nombre || '', apellido: cliente.apellido || '',
        email: emailClean, tel: telClean,
        estado: 'Cliente', etapa: 'cliente',
        cantCompras: 1, valorTotal: total, ultimaCompra: fechaCompra,
        creado: fechaCompra, canal: 'Tienda propia', origen: 'checkout',
      })
    }

    // ── FINANZAS: registrar ingreso + costo de mercadería ───────────
    if (!d.finanzas) d.finanzas = []
    const productosNombres = lineas.map(l => `${l.nombre}${l.cantidad > 1 ? ' x'+l.cantidad : ''}`).join(', ')
    const totalUnidades = lineas.reduce((s, l) => s + (l.cantidad || 1), 0)
    const finId = Date.now().toString(36)

    // Ingreso por ventas
    d.finanzas.push({
      id:        'fin_' + finId,
      tipo:      'ingreso',
      fecha:     fechaCompra,
      concepto:  `Venta #${numero} — ${cliente.nombre || 'Cliente'}`,
      categoria: 'Ventas tienda',
      monto:     total,
      medioPago: 'Transferencia',
      cuotas:    1,
      unidades:  totalUnidades,
      notas:     productosNombres,
      ordenId:   orden.id,
      ordenNum:  numero,
    })

    // Costo de mercadería vendida (si los productos tienen costo cargado)
    let totalCosto = 0
    lineas.forEach(l => {
      const prod = productos.find(p => p.id === l.id)
      if (prod && prod.costo && Number(prod.costo) > 0) {
        totalCosto += Number(prod.costo) * (l.cantidad || 1)
      }
    })
    if (totalCosto > 0) {
      d.finanzas.push({
        id:        'fin_' + finId + '_c',
        tipo:      'gasto',
        fecha:     fechaCompra,
        concepto:  `CMV Venta #${numero} — ${productosNombres}`,
        categoria: 'Costo de mercadería',
        monto:     totalCosto,
        medioPago: '—',
        cuotas:    1,
        unidades:  totalUnidades,
        notas:     `Costo asociado a venta #${numero}`,
        ordenId:   orden.id,
        ordenNum:  numero,
      })
    }

    // ── CLIENTES WEB (usuarios): actualizar o crear siempre ──────────
    // Buscar por tel O por email — no requerir tel para sincronizar
    if (!d.usuarios) d.usuarios = []
    let userIdx = -1
    if (telClean) {
      userIdx = d.usuarios.findIndex(u =>
        u.telefono && u.telefono.replace(/\D/g,'') === telClean
      )
    }
    if (userIdx === -1 && emailClean) {
      userIdx = d.usuarios.findIndex(u =>
        u.email && u.email.toLowerCase() === emailClean
      )
    }
    if (userIdx === -1 && cliente.nombre) {
      userIdx = d.usuarios.findIndex(u =>
        u.nombre && u.nombre.toLowerCase() === (cliente.nombre || '').toLowerCase()
      )
    }

    const purchaseJourneyEntry = {
      evento: 'purchase',
      datos: { ordenId: orden.id, total, items: lineas.length, productos: productosNombres },
      ts: new Date().toISOString()
    }

    if (userIdx >= 0) {
      // Actualizar usuario existente — SIEMPRE sumar compra
      d.usuarios[userIdx].cantCompras = (d.usuarios[userIdx].cantCompras || 0) + 1
      d.usuarios[userIdx].valorTotalCompras = (d.usuarios[userIdx].valorTotalCompras || 0) + total
      d.usuarios[userIdx].ultimaCompra = new Date().toISOString()
      d.usuarios[userIdx].etapa = 'cliente'
      d.usuarios[userIdx].carritoAbandonado = false
      if (!d.usuarios[userIdx].nombre && cliente.nombre) d.usuarios[userIdx].nombre = cliente.nombre
      if (!d.usuarios[userIdx].email && emailClean) d.usuarios[userIdx].email = emailClean
      if (!d.usuarios[userIdx].telefono && telClean) d.usuarios[userIdx].telefono = telClean
      if (!d.usuarios[userIdx].journey) d.usuarios[userIdx].journey = []
      d.usuarios[userIdx].journey.push(purchaseJourneyEntry)
      if (d.usuarios[userIdx].journey.length > 500) d.usuarios[userIdx].journey = d.usuarios[userIdx].journey.slice(-500)
    } else {
      // Crear nuevo usuario aunque no tenga tel (el email o nombre alcanzan)
      d.usuarios.push({
        id: 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,5),
        telefono: telClean || '',
        nombre: cliente.nombre || '',
        email: emailClean || '',
        etapa: 'cliente',
        fechaAlta: new Date().toISOString(),
        ultimaVisita: new Date().toISOString(),
        ultimaCompra: new Date().toISOString(),
          cantCompras: 1,
          valorTotalCompras: total,
          carritoAbandonado: false,
          dispositivo: 'web',
          journey: [{
            evento: 'purchase',
            datos: { ordenId: orden.id, total, items: lineas.length },
            ts: new Date().toISOString()
          }]
        })
    }

    // Auto-sync: asegurar que el CRM tenga los datos correctos de este comprador
    {
      const telC = telClean
      const emailC = emailClean
      if (telC || emailC) {
        let crmContact = null
        if (telC) crmContact = d.crm.find(c => (c.tel||'').replace(/\D/g,'') === telC)
        if (!crmContact && emailC) crmContact = d.crm.find(c => (c.email||'').toLowerCase() === emailC)
        // Ya fue creado/actualizado arriba en el bloque CRM — aquí solo aseguramos consistency con d.usuarios
        const identUser = d.usuarios?.find(u => {
          const ut = (u.telefono||'').replace(/\D/g,'')
          const ue = (u.email||'').toLowerCase()
          return (telC && ut === telC) || (emailC && ue === emailC)
        })
        if (crmContact && identUser) {
          // Mantener CRM en sincronía con identity
          crmContact.cantCompras = identUser.cantCompras || crmContact.cantCompras
          crmContact.valorTotal = identUser.valorTotalCompras || crmContact.valorTotal
          crmContact.ultimaCompra = identUser.ultimaCompra || crmContact.ultimaCompra
        }
      }
    }

    // ── Descontar stock de los productos vendidos ─────────────────────
    if (lineas && lineas.length > 0) {
      ;(t.secciones || []).forEach(sec => {
        ;(sec.productos || []).forEach(prod => {
          const lineaVendida = lineas.find(l => l.id === prod.id || l.nombre === prod.nombre)
          if (lineaVendida && prod.stock != null && prod.stock !== '') {
            const stockActual = parseInt(prod.stock) || 0
            const qty = lineaVendida.cantidad || 1
            prod.stock = String(Math.max(0, stockActual - qty))
          }
        })
      })
      // (stock de t.productos ya fue decrementado al inicio del checkout, no repetir)
    }

    // ── Email campaign attribution — registrar conversión ──────────────
    if (ecid && Array.isArray(d.emailCampaigns)) {
      const camp = d.emailCampaigns.find(c => c.id === ecid)
      if (camp) {
        camp.conversions = (camp.conversions || 0) + 1
        camp.revenue = (camp.revenue || 0) + total
      }
    }

    // ── Acreditar cashback al referidor y descontar del comprador ────────
    if (referrerId && descuentoReferido > 0) {
      const referrer = (d.usuarios||[]).find(u => u.id === referrerId)
      if (referrer) {
        const cashbackAmt = Math.round(totalAntesDescuentos * pctCashback)
        referrer.cashbackBalance = (referrer.cashbackBalance||0) + cashbackAmt
        if (!referrer.cashbackHistory) referrer.cashbackHistory = []
        referrer.cashbackHistory.push({ tipo: 'ganado', monto: cashbackAmt, de: cliente.nombre||'Comprador', ordenId: orden.id, ts: new Date().toISOString() })
      }
    }
    if (usarCashback && descuentoCashback > 0 && authToken) {
      const selfUser = (d.usuarios||[]).find(u => u.id === (d.tokens||{})[authToken]?.userId)
      if (selfUser) {
        selfUser.cashbackBalance = Math.max(0, (selfUser.cashbackBalance||0) - descuentoCashback)
        if (!selfUser.cashbackHistory) selfUser.cashbackHistory = []
        selfUser.cashbackHistory.push({ tipo: 'usado', monto: descuentoCashback, ordenId: orden.id, ts: new Date().toISOString() })
      }
    }

    // Capturar referencia al contacto CRM antes de guardar (para flow automation)
    const _purchaseCrmContact = crmIdx >= 0 ? d.crm[crmIdx] : d.crm[d.crm.length - 1]

    // ── GUARDAR TODO — orden + CRM + finanzas + usuarios ──
    // Usamos _writeDirect porque ya tenemos el dato más fresco del getTienda al inicio.
    await _writeDirect(wsId, { ...d, tienda: t })
    _invalidateWsCache(wsId)

    // Disparar flows automáticos en background — no bloquea la respuesta al cliente
    if (_purchaseCrmContact) {
      _processImmediateFlows(wsId, d, _purchaseCrmContact,
        ['after_purchase', 'post_purchase', 'payment_confirmed', 'order_placed'],
        { total, lineas, numeroPedido: String(orden.numero || orden.id || '') }
      ).catch(() => {})
    }

    // Return transfer info from settings
    const tf = (t.settings || {}).transferencia || {}
    res.json({ ok: true, numero, nombre: cliente.nombre, total, transferencia: tf, orden })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/store/validate-code — validate referral or cashback code ──
app.get('/api/store/validate-code', async (req, res) => {
  const { wsId, codigo } = req.query
  if (!wsId || !codigo) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    const codeLower = (codigo || '').toLowerCase().trim()
    const refCodes = data.referidoCodes || {}
    if (refCodes[codeLower]) {
      const referrerId = refCodes[codeLower]
      const referrer = (data.usuarios || []).find(u => u.id === referrerId)
      const cfg = data.tienda?.settings?.referidosConfig || {}
      const pct = Number(cfg.pctDescuento ?? 10)
      return res.json({
        valid: true, tipo: 'referido', pct,
        mensaje: `Código de ${referrer?.nombre || 'amiga'} — ${pct}% OFF aplicado ✓`
      })
    }
    return res.json({ valid: false, mensaje: 'Código no encontrado' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/admin/profiles — all user profiles for admin dashboard ──
app.get('/api/admin/profiles', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    const ordenes = (data.tienda?.ordenes || [])
    const perfiles = (data.usuarios || []).map(u => {
      const tel = (u.telefono || '').replace(/\D/g,'')
      const email = (u.email || '').toLowerCase()
      const userOrdenes = ordenes.filter(o => {
        const oTel = (o.cliente?.tel || '').replace(/\D/g,'')
        const oEmail = (o.cliente?.email || '').toLowerCase()
        return (tel && oTel && oTel === tel) || (email && oEmail && oEmail === email)
      }).map(o => ({ id: o.id, numero: o.numero, fecha: o.fecha, total: o.total, estado: o.estado, lineas: o.lineas, codigoReferido: o.codigoReferido }))
        .sort((a,b) => new Date(b.fecha) - new Date(a.fecha))
      return {
        id: u.id, nombre: u.nombre||'', apellido: u.apellido||'',
        telefono: u.telefono||'', email: u.email||'', etapa: u.etapa||'prospecto',
        fechaAlta: u.fechaAlta, ultimaVisita: u.ultimaVisita,
        cantCompras: u.cantCompras||0, valorTotalCompras: u.valorTotalCompras||0, ultimaCompra: u.ultimaCompra,
        codigoReferido: u.codigoReferido||null, cashbackBalance: u.cashbackBalance||0,
        ultimoProductoVisto: u.ultimoProductoVisto||null,
        productosVisitados: (u.productosVisitados||[]).slice(-5),
        carritoAbandonado: u.carritoAbandonado||false,
        ultimoCarritoItems: u.ultimoCarritoItems||null,
        tags: u.tags||[], notas: u.notas||'',
        dispositivo: u.dispositivo||null, totalVisitas: u.totalVisitas||0,
        historialInteracciones: (u.historialInteracciones||[]).slice(-30),
        ordenes: userOrdenes,
      }
    }).sort((a,b) => new Date(b.ultimaVisita||0) - new Date(a.ultimaVisita||0))
    res.json({ ok: true, perfiles })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PATCH /api/admin/profiles/:userId — update user from admin ──
app.patch('/api/admin/profiles/:userId', async (req, res) => {
  const { wsId } = req.query
  const { userId } = req.params
  if (!wsId || !userId) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    const user = (data.usuarios||[]).find(u => u.id === userId)
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })
    const { tags, notas, cashbackAjuste, etapa } = req.body
    if (tags !== undefined) user.tags = tags
    if (notas !== undefined) user.notas = notas
    if (etapa) user.etapa = etapa
    if (cashbackAjuste != null) {
      const ajuste = Number(cashbackAjuste)
      user.cashbackBalance = Math.max(0, (user.cashbackBalance||0) + ajuste)
      if (!user.cashbackHistory) user.cashbackHistory = []
      user.cashbackHistory.push({ tipo: ajuste>=0?'ajuste_positivo':'ajuste_negativo', monto: Math.abs(ajuste), ts: new Date().toISOString(), source: 'admin' })
    }
    await patchWorkspace(wsId, data)
    _invalidateWsCache(wsId)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/admin/referidos — list codes + config ──
app.get('/api/admin/referidos', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    const cfg = data.tienda?.settings?.referidosConfig || { pctDescuento: 10, pctCashback: 10 }
    const refCodes = data.referidoCodes || {}
    const ordenes = data.tienda?.ordenes || []
    const codigos = Object.entries(refCodes).map(([code, userId]) => {
      const user = (data.usuarios || []).find(u => u.id === userId)
      const usos = ordenes.filter(o => (o.codigoReferido || '').toLowerCase() === code).length
      return {
        code, userId,
        nombre: user ? `${user.nombre||''} ${user.apellido||''}`.trim() : 'Usuario',
        telefono: user?.telefono || null,
        cashbackBalance: user?.cashbackBalance || 0,
        cashbackEarned: (user?.cashbackHistory || []).filter(h => h.tipo === 'ganado').reduce((s,h) => s + (h.monto||0), 0),
        usos,
        activo: true
      }
    })
    res.json({ ok: true, config: cfg, codigos })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PATCH /api/admin/referidos/config — save referidos config ──
app.patch('/api/admin/referidos/config', async (req, res) => {
  const { wsId, pctDescuento, pctCashback } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    if (!data.tienda) data.tienda = {}
    if (!data.tienda.settings) data.tienda.settings = {}
    data.tienda.settings.referidosConfig = {
      pctDescuento: Math.max(0, Math.min(100, Number(pctDescuento ?? 10))),
      pctCashback:  Math.max(0, Math.min(100, Number(pctCashback  ?? 10)))
    }
    await patchWorkspace(wsId, data)
    _invalidateWsCache(wsId)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/admin/abtests — list experiments ──
app.get('/api/admin/abtests', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    res.json({ ok: true, tests: (ws?.data?.abTests || []) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/admin/abtests — create/update experiment ──
app.post('/api/admin/abtests', async (req, res) => {
  const { wsId, test } = req.body
  if (!wsId || !test) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    if (!data.abTests) data.abTests = []
    if (test.id) {
      const idx = data.abTests.findIndex(t => t.id === test.id)
      if (idx >= 0) data.abTests[idx] = { ...data.abTests[idx], ...test }
      else data.abTests.push(test)
    } else {
      test.id = 'ab_' + Date.now().toString(36)
      test.creado = new Date().toISOString()
      data.abTests.push(test)
    }
    await patchWorkspace(wsId, data)
    _invalidateWsCache(wsId)
    res.json({ ok: true, test })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── DELETE /api/admin/abtests/:testId ──
app.delete('/api/admin/abtests/:testId', async (req, res) => {
  const { wsId } = req.query
  const { testId } = req.params
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    data.abTests = (data.abTests||[]).filter(t => t.id !== testId)
    await patchWorkspace(wsId, data)
    _invalidateWsCache(wsId)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/store/abvariant — assign/get AB test variant for session ──
app.get('/api/store/abvariant', async (req, res) => {
  const { wsId, sessionKey } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    const data = ws?.data || {}
    const activeTests = (data.abTests||[]).filter(t => t.active)
    if (!activeTests.length) return res.json({ ok: true, assignments: {}, priceOverrides: {} })

    const sKey = (sessionKey || 'anon').slice(0, 64)
    if (!data.abAssignments) data.abAssignments = {}
    const assignments = {}
    let needsSave = false

    activeTests.forEach(test => {
      const key = `${test.id}|${sKey}`
      if (data.abAssignments[key]) {
        assignments[test.id] = data.abAssignments[key]
      } else {
        const variants = test.variants || []
        if (!variants.length) return
        // Deterministic hash for stickiness
        const hash = Math.abs([...(sKey + test.id)].reduce((h,c) => (Math.imul(31,h) + c.charCodeAt(0))|0, 0))
        const pct = hash % 100
        let cumulative = 0
        let assigned = variants[0].id
        for (const v of variants) {
          cumulative += (v.trafficPct || Math.floor(100/variants.length))
          if (pct < cumulative) { assigned = v.id; break }
        }
        data.abAssignments[key] = assigned
        assignments[test.id] = assigned
        // Track impression
        const vObj = variants.find(v => v.id === assigned)
        if (vObj) vObj.impressions = (vObj.impressions||0) + 1
        needsSave = true
      }
    })

    // Trim assignments if too large
    const aKeys = Object.keys(data.abAssignments)
    if (aKeys.length > 10000) {
      const keep = aKeys.slice(-8000)
      data.abAssignments = Object.fromEntries(keep.map(k => [k, data.abAssignments[k]]))
    }

    if (needsSave) { patchWorkspace(wsId, data).catch(()=>{}); _invalidateWsCache(wsId) }

    // Build price overrides map: { productId: price }
    const priceOverrides = {}
    activeTests.forEach(test => {
      const vObj = (test.variants||[]).find(v => v.id === assignments[test.id])
      if (vObj?.priceOverrides) Object.assign(priceOverrides, vObj.priceOverrides)
    })

    res.json({ ok: true, assignments, priceOverrides })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/store/campaigns — list email campaigns with stats
app.get('/api/store/campaigns', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    res.json({ campaigns: result.d.emailCampaigns || [] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/workspace/save — merge-safe save desde el browser (evita race conditions)
app.post('/api/workspace/save', async (req, res) => {
  const { wsId, data, row } = req.body
  const id = wsId || row?.id
  if (!id) return res.status(400).json({ error: 'Falta wsId' })
  try {
    await patchWorkspace(id, data || row?.data || {}, row || null)
    _invalidateWsCache(id)
    res.json({ ok: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/workspace/crm — returns fresh CRM from Supabase for flow computation
app.get('/api/workspace/crm', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    res.json({ crm: ws?.data?.crm || [] })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/store/orders — list orders (admin)
app.get('/api/store/orders', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    res.json({ ordenes: result.t.ordenes || [] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── PATCH /api/store/orders/:id — update order fields (admin)
app.patch('/api/store/orders/:id', async (req, res) => {
  const { id } = req.params
  const { wsId, estado, metodoEnvio, metodoPago, tags, timeline, preparado, etiquetaGenerada, tracking } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    const idx = (t.ordenes || []).findIndex(o => o.id === id || String(o.numero) === String(id))
    if (idx === -1) return res.status(404).json({ error: 'Orden no encontrada' })
    if (estado !== undefined)          t.ordenes[idx].estado          = estado
    if (metodoEnvio !== undefined)     t.ordenes[idx].metodoEnvio     = metodoEnvio
    if (metodoPago !== undefined)      t.ordenes[idx].metodoPago      = metodoPago
    if (tags !== undefined)            t.ordenes[idx].tags            = tags
    if (timeline !== undefined)        t.ordenes[idx].timeline        = timeline
    if (preparado !== undefined)       t.ordenes[idx].preparado       = preparado
    if (etiquetaGenerada !== undefined) t.ordenes[idx].etiquetaGenerada = etiquetaGenerada
    if (tracking !== undefined)        t.ordenes[idx].tracking        = tracking
    t.ordenes[idx].updatedAt = new Date().toISOString()
    await saveTienda(wsId, t, d)
    res.json({ ok: true, orden: t.ordenes[idx] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/store/products/:id/review — add review to product
app.post('/api/store/products/:id/review', async (req, res) => {
  const { id } = req.params
  const { wsId, review } = req.body
  if (!wsId || !review) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    const idx = (t.productos || []).findIndex(p => p.id === id)
    if (idx === -1) return res.status(404).json({ error: 'Producto no encontrado' })
    if (!t.productos[idx].reviews) t.productos[idx].reviews = []
    t.productos[idx].reviews.unshift(review)
    // Max 100 reviews per product
    if (t.productos[idx].reviews.length > 100) t.productos[idx].reviews = t.productos[idx].reviews.slice(0, 100)
    await saveTienda(wsId, t, d)
    _invalidateWsCache(wsId)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/store/orders/:id/nota — add internal note to order
app.post('/api/store/orders/:id/nota', async (req, res) => {
  const { id } = req.params
  const { wsId, nota } = req.body
  if (!wsId || !nota) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    const idx = (t.ordenes || []).findIndex(o => o.id === id || String(o.numero) === String(id))
    if (idx === -1) return res.status(404).json({ error: 'Orden no encontrada' })
    if (!t.ordenes[idx].notas) t.ordenes[idx].notas = []
    t.ordenes[idx].notas.push(nota)
    t.ordenes[idx].updatedAt = new Date().toISOString()
    await saveTienda(wsId, t, d)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ════════════════════════════════════════════════════
// ANDREANI — /api/andreani/*
// ════════════════════════════════════════════════════

const ANDREANI_URL = 'https://apis.andreani.com'

async function andreaniLogin(creds) {
  const basic = Buffer.from(`${creds.usuario}:${creds.clave}`).toString('base64')
  const r = await fetch(`${ANDREANI_URL}/login`, {
    method: 'GET',
    headers: { 'Authorization': `Basic ${basic}` }
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error(err.message || err.error || 'Credenciales Andreani inválidas')
  }
  const xAuth = r.headers.get('x-authorization')
  if (!xAuth) throw new Error('No se recibió token de Andreani — verificá usuario y clave')
  return xAuth
}

// POST /api/andreani/cotizar
app.post('/api/andreani/cotizar', async (req, res) => {
  const { wsId, cpDestino, kilos, alto, ancho, largo } = req.body
  if (!wsId || !cpDestino) return res.status(400).json({ error: 'Faltan campos (wsId, cpDestino)' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const cfg = result.t.settings?.andreani
    if (!cfg?.usuario || !cfg?.clave) return res.status(400).json({ error: 'Andreani no configurado — ingresá usuario y clave en Checkout' })
    const token = await andreaniLogin(cfg)
    const tarBody = {
      cpDestino: String(cpDestino).padStart(4, '0'),
      bultos: [{ kilos: Number(kilos) || 0.5, alto: Number(alto) || 10, ancho: Number(ancho) || 15, largo: Number(largo) || 20 }]
    }
    if (cfg.contrato) tarBody.contrato = cfg.contrato
    const r = await fetch(`${ANDREANI_URL}/v2/tarifas`, {
      method: 'POST',
      headers: { 'x-authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(tarBody)
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Error Andreani', detail: data })
    res.json({ ok: true, tarifas: Array.isArray(data) ? data : [data] })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/andreani/crear-envio
app.post('/api/andreani/crear-envio', async (req, res) => {
  const { wsId, ordenId, kilos, alto, ancho, largo, cpDestino, valorDeclarado } = req.body
  if (!wsId || !ordenId) return res.status(400).json({ error: 'Faltan campos (wsId, ordenId)' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    const cfg = t.settings?.andreani
    if (!cfg?.usuario || !cfg?.clave) return res.status(400).json({ error: 'Andreani no configurado' })
    const orden = (t.ordenes || []).find(o => o.id === ordenId)
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' })

    const token = await andreaniLogin(cfg)
    const rem = cfg.remitente || {}
    const cliente = orden.cliente || {}
    const dir = (orden.envio?.direccion) || {}

    const body = {
      ...(cfg.contrato ? { contrato: cfg.contrato } : {}),
      remitente: {
        nombreCompleto: rem.nombre || t.settings?.nombre || 'Remitente',
        email: rem.email || t.settings?.emailContacto || '',
        documentoTipo: 'DNI',
        documentoNumero: rem.dni || '00000000',
        telefonos: [{ tipo: 'celular', numero: (rem.tel || '').replace(/\D/g, '') }],
        domicilio: {
          calle: rem.calle || '',
          numero: rem.nro || 'S/N',
          cp: String(rem.cp || '').padStart(4, '0'),
          localidad: rem.localidad || '',
          region: rem.provincia || '',
          pais: 'ARG'
        }
      },
      destinatario: {
        nombreCompleto: (`${cliente.nombre || ''} ${cliente.apellido || ''}`).trim() || 'Destinatario',
        email: cliente.email || '',
        documentoTipo: 'DNI',
        documentoNumero: cliente.dni || '00000000',
        telefonos: [{ tipo: 'celular', numero: (cliente.tel || '').replace(/\D/g, '') }],
        domicilio: {
          calle: dir.calle || '',
          numero: dir.nro || 'S/N',
          cp: String(cpDestino || dir.cp || '').padStart(4, '0'),
          localidad: dir.ciudad || '',
          region: dir.provincia || '',
          pais: 'ARG'
        }
      },
      bultos: [{
        kilos: Number(kilos) || 0.5,
        alto: Number(alto) || 10,
        ancho: Number(ancho) || 15,
        largo: Number(largo) || 20,
        volumen: 0,
        valorDeclarado: Number(valorDeclarado) || orden.total || 0,
        referencia: `ORD-${orden.numero}`
      }]
    }

    const r = await fetch(`${ANDREANI_URL}/v2/ordenes-de-envio`, {
      method: 'POST',
      headers: { 'x-authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.message || data.error || 'Error Andreani', detail: data })

    const numeroAndreani = data.numero || data.id || data.nroAndreani || ''

    // Persist tracking on order
    const idx = t.ordenes.findIndex(o => o.id === ordenId)
    if (idx >= 0) {
      t.ordenes[idx].andreani = { numero: numeroAndreani, createdAt: new Date().toISOString() }
      t.ordenes[idx].estado = 'enviado'
      t.ordenes[idx].tracking = numeroAndreani
    }
    await saveTienda(wsId, t, d)
    res.json({ ok: true, numero: numeroAndreani })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/andreani/etiqueta — proxy PDF label to client
app.get('/api/andreani/etiqueta', async (req, res) => {
  const { wsId, numero } = req.query
  if (!wsId || !numero) return res.status(400).json({ error: 'Faltan parámetros' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const cfg = result.t.settings?.andreani
    if (!cfg?.usuario || !cfg?.clave) return res.status(400).json({ error: 'Andreani no configurado' })
    const token = await andreaniLogin(cfg)
    const r = await fetch(`${ANDREANI_URL}/v2/ordenes-de-envio/${encodeURIComponent(numero)}/etiquetas`, {
      headers: { 'x-authorization': token }
    })
    if (!r.ok) return res.status(r.status).send('Error obteniendo etiqueta')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="andreani-${numero}.pdf"`)
    const buf = await r.arrayBuffer()
    res.end(Buffer.from(buf))
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/store/evento — track storefront analytics event
app.post('/api/store/evento', async (req, res) => {
  const { wsId, tipo, sessionId, metadata, contactId } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) { res.json({ ok: true }); return } // silent fail for analytics
    const { t, d } = result
    if (!t.eventos) t.eventos = []
    t.eventos.push({ tipo, sessionId: sessionId || null, metadata: metadata || {}, contactId: contactId || null, ts: new Date().toISOString() })
    // Keep last 2000 events max
    if (t.eventos.length > 2000) t.eventos = t.eventos.slice(-2000)
    // Actualizar último producto visitado en CRM cuando hay contactId
    if (tipo === 'view_product' && contactId && metadata?.productoNombre) {
      const telClean = String(contactId).replace(/\D/g, '')
      const contact = (d.crm || []).find(c => (c.tel || '').replace(/\D/g, '') === telClean || c.id === contactId)
      if (contact) contact.ultimoProducto = metadata.productoNombre
    }
    await saveTienda(wsId, t, d)
    res.json({ ok: true })
  } catch (e) {
    res.json({ ok: true }) // silent fail for analytics
  }
})

// ── GET /api/store/analytics — summary analytics (admin)
app.get('/api/store/analytics', async (req, res) => {
  const { wsId, days } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.json({ revenue:0, ordenesPagadas:0, ticketPromedio:0, topProductos:[], stockBajo:[], ventasPorMetodo:{}, ordenes:[] })
    const { t } = result
    const allOrdenes = t.ordenes || []

    // Filter by period if requested
    const since = days ? new Date(Date.now() - Number(days) * 864e5).toISOString() : null
    const ordenes = since ? allOrdenes.filter(o => (o.fecha||o.createdAt||'') >= since) : allOrdenes

    const pagadas = ordenes.filter(o => o.estado && o.estado !== 'pendiente' && o.estado !== 'cancelado')
    const revenue = pagadas.reduce((s, o) => s + (o.total || 0), 0)
    const ticketPromedio = pagadas.length ? Math.round(revenue / pagadas.length) : 0

    // Top productos por revenue
    const prodMap = {}
    pagadas.forEach(o => {
      ;(o.lineas || []).forEach(l => {
        const n = l.nombre || 'Sin nombre'
        if (!prodMap[n]) prodMap[n] = { nombre: n, revenue: 0, unidades: 0 }
        prodMap[n].revenue  += (l.precio || 0) * (l.cantidad || 1)
        prodMap[n].unidades += l.cantidad || 1
      })
    })
    const topProductos = Object.values(prodMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10)

    // Ventas por método de pago
    const metodoMap = {}
    pagadas.forEach(o => {
      const m = o.metodoPago || o.pago || 'otro'
      metodoMap[m] = (metodoMap[m] || 0) + (o.total || 0)
    })

    // Ventas por método de envío
    const envioMap = {}
    pagadas.forEach(o => {
      const e = o.metodoEnvio || (o.envio ? 'domicilio' : 'retiro')
      envioMap[e] = (envioMap[e] || 0) + (o.total || 0)
    })

    // Ventas por estado (breakdown)
    const estadoMap = {}
    allOrdenes.forEach(o => { estadoMap[o.estado||'pendiente'] = (estadoMap[o.estado||'pendiente']||0)+1 })

    // Revenue diario últimos N días (para gráfico)
    const nDays = Math.min(Number(days)||30, 90)
    const dailyMap = {}
    for (let i = nDays-1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5)
      dailyMap[d.toISOString().slice(0,10)] = 0
    }
    pagadas.forEach(o => {
      const day = (o.fecha || o.createdAt || '').slice(0, 10)
      if (dailyMap[day] !== undefined) dailyMap[day] += o.total || 0
    })
    const revenueChart = Object.entries(dailyMap).map(([date, val]) => ({ date, val }))

    // Stock bajo
    const stockBajo = (t.productos || [])
      .filter(p => typeof p.stock === 'number' && p.stock <= 5)
      .map(p => ({ nombre: p.nombre, stock: p.stock }))
      .sort((a, b) => a.stock - b.stock)
      .slice(0, 10)

    const eventos = t.eventos || []
    res.json({
      revenue,
      ordenesPagadas: pagadas.length,
      totalOrdenes: allOrdenes.length,
      ticketPromedio,
      topProductos,
      stockBajo,
      ventasPorMetodo: metodoMap,
      ventasPorEnvio: envioMap,
      estadoMap,
      revenueChart,
      resumen: {
        totalOrdenes: allOrdenes.length,
        totalVentas: revenue,
        visitantes: new Set(eventos.filter(e => e.sessionId).map(e => e.sessionId)).size,
      },
      ordenes: allOrdenes.slice(-100),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/store/analytics/events — raw events + computed funnel (admin)
app.get('/api/store/analytics/events', async (req, res) => {
  const { wsId, days } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.json({ eventos: [], funnel: { views:0, carts:0, checkouts:0, orders:0 }, totalViews:0, convRate:0, topProductsViews:[] })
    const { t } = result
    const all = t.eventos || []
    const since = days ? new Date(Date.now() - Number(days) * 864e5).toISOString() : null
    const filtered = since ? all.filter(e => e.ts >= since) : all

    // ── Funnel ─────────────────────────────────────────────────
    const views     = filtered.filter(e => e.tipo === 'view_product').length
    const carts     = filtered.filter(e => e.tipo === 'add_cart').length
    const checkouts = filtered.filter(e => e.tipo === 'checkout_start').length
    const abandons  = filtered.filter(e => e.tipo === 'cart_abandon').length
    const purchases = filtered.filter(e => e.tipo === 'purchase' || e.tipo === 'checkout_complete').length
    // Sesiones únicas para tasa de conversión
    const uniqueSessions = new Set(filtered.filter(e => e.sessionId).map(e => e.sessionId)).size
    const convRate = uniqueSessions > 0 ? purchases / uniqueSessions : 0

    // ── Top productos por vistas ────────────────────────────────
    const viewMap = {}
    filtered.filter(e => e.tipo === 'view_product' && e.metadata?.productoNombre).forEach(e => {
      const n = e.metadata.productoNombre
      viewMap[n] = (viewMap[n] || 0) + 1
    })
    const topProductsViews = Object.entries(viewMap)
      .map(([nombre, views]) => ({ nombre, views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10)

    res.json({
      eventos: filtered.slice(-500),
      funnel: { views, carts, checkouts, orders: purchases, abandons },
      totalViews: views,
      convRate,
      topProductsViews,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/store/domain — guardar dominio propio ──────────────
app.post('/api/store/domain', async (req, res) => {
  const { wsId, domain } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    if (!t.settings) t.settings = {}

    const cleanDomain = (domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
    t.settings.customDomain = cleanDomain || null

    await saveTienda(wsId, t, d)
    _invalidateWsCache(wsId)
    // Invalidar caché de dominio
    if (cleanDomain) _domainCache.delete(cleanDomain)

    // Intentar agregar el dominio a Vercel para SSL automático
    const vercelToken = process.env.VERCEL_TOKEN || ''
    if (vercelToken && cleanDomain) {
      try {
        await fetch(`https://api.vercel.com/v10/projects/prj_o15setadfvqN4GsFKDCEgm4RbLtV/domains`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + vercelToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: cleanDomain })
        })
      } catch(e) { /* No bloquear si Vercel API falla */ }
    }

    res.json({ ok: true, domain: cleanDomain })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/store/domain-check — verificar DNS ──────────────────
app.get('/api/store/domain-check', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'No encontrado' })
    const domain = result.t.settings?.customDomain || ''
    if (!domain) return res.json({ ok: false, error: 'No hay dominio configurado' })

    // Verificar que el dominio resuelve a nuestra app
    const testUrl = `https://${domain}/api/store/ping`
    try {
      const r = await fetch(testUrl, { signal: AbortSignal.timeout(8000) })
      const d = await r.json()
      if (d.ok) return res.json({ ok: true, domain, status: 'connected' })
    } catch(e) {}

    // DNS no resuelve todavía
    res.json({ ok: false, domain, status: 'pending', message: 'El dominio todavía no apunta a este servidor. Puede tardar hasta 24hs en propagarse.' })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/store/ping — health check para verificación de dominio ──
app.get('/api/store/ping', (req, res) => res.json({ ok: true }))

// ── POST /api/store/upload — upload image from URL/base64 to Supabase
app.post('/api/store/upload', async (req, res) => {
  const { wsId, base64, filename, mimeType } = req.body
  if (!wsId || !base64) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const buf = Buffer.from(base64, 'base64')
    const ext = (filename || 'file').split('.').pop() || 'jpg'
    const name = 'store/' + wsId + '/' + Date.now() + '.' + ext
    const r = await fetch(`${SUPA_URL}/storage/v1/object/tienda-assets/${name}`, {
      method: 'POST',
      headers: { 'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(), 'Content-Type': mimeType || 'image/jpeg', 'x-upsert': 'true' },
      body: buf,
    })
    if (!r.ok) throw new Error('Error subiendo a storage: ' + r.status)
    const url = `${SUPA_URL}/storage/v1/object/public/tienda-assets/${name}`
    res.json({ ok: true, url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/store/upload-binary — binary upload (multipart)
app.post('/api/store/upload-binary', async (req, res) => {
  // Reads raw body as buffer
  const wsId = req.query.wsId || req.headers['x-ws-id'] || ''
  const ct = req.headers['content-type'] || 'image/jpeg'
  const fname = req.headers['x-filename'] || ''
  // Derive extension: prefer x-filename header, then content-type
  let ext = fname.includes('.') ? fname.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : ''
  if (!ext) {
    if (ct.includes('png')) ext = 'png'
    else if (ct.includes('webp')) ext = 'webp'
    else if (ct.includes('mp4') || ct.includes('mpeg')) ext = 'mp4'
    else if (ct.includes('quicktime') || ct.includes('mov')) ext = 'mov'
    else if (ct.includes('webm')) ext = 'webm'
    else ext = 'jpg'
  }
  const name = 'store/' + (wsId || 'shared') + '/' + Date.now() + '.' + ext
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const buf = Buffer.concat(chunks)
    const r = await fetch(`${SUPA_URL}/storage/v1/object/tienda-assets/${name}`, {
      method: 'POST',
      headers: { 'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(), 'Content-Type': ct, 'x-upsert': 'true' },
      body: buf,
    })
    if (!r.ok) { const txt = await r.text(); throw new Error('Storage error: ' + txt) }
    const url = `${SUPA_URL}/storage/v1/object/public/tienda-assets/${name}`
    res.json({ ok: true, url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Old OTP routes — redirect to new identity system (backward compat)
app.post('/api/store/otp/send', async (req, res) => {
  // Forward to identity system
  const { wsId, tel } = req.body
  if (!wsId || !tel) return res.status(400).json({ error: 'Faltan campos' })
  // Use the identity OTP handler internally
  req.body = { wsId, telefono: tel }
  // Simulate internal call
  try {
    const phone = tel.toString().replace(/\D/g, '')
    const code = String(Math.floor(100000 + Math.random() * 900000))
    // Store in memory (reuse _otpMemory if available, else just log)
    if (typeof _otpMemory !== 'undefined') {
      _otpMemory.set(phone, { code, expires: Date.now() + 10 * 60 * 1000, attempts: 0 })
    }
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/store/otp/verify', async (req, res) => {
  const { wsId, tel, code } = req.body
  if (!wsId || !tel || !code) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const phone = tel.toString().replace(/\D/g, '')
    const entry = typeof _otpMemory !== 'undefined' ? _otpMemory.get(phone) : null
    if (!entry || entry.code !== String(code).trim()) {
      return res.status(400).json({ error: 'Código incorrecto' })
    }
    _otpMemory.delete(phone)
    res.json({ ok: true, verified: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


// ── GET /api/store/orders/mine — pedidos del cliente por teléfono
app.get('/api/store/orders/mine', async (req, res) => {
  const { wsId, tel } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.json({ ordenes: [] })
    const phone = (tel || '').replace(/\D/g, '')
    const ordenes = (result.t.ordenes || []).filter(o => {
      const t = o.cliente?.tel || o.cliente?.whatsapp || ''
      return t.replace(/\D/g, '').includes(phone) || phone.includes(t.replace(/\D/g, ''))
    })
    res.json({ ordenes })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/store/returns — solicitud de cambio/devolución
app.post('/api/store/returns', async (req, res) => {
  const { wsId, orderId, tipo, motivo, telefono, nombre, email } = req.body
  if (!wsId || !orderId || !motivo) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    if (!t.solicitudes) t.solicitudes = []
    const sol = {
      id: 'sol_' + Date.now().toString(36),
      orderId, tipo: tipo || 'cambio', motivo,
      telefono: telefono || '', nombre: nombre || '', email: email || '',
      estado: 'pendiente',
      fecha: new Date().toISOString(),
    }
    t.solicitudes.push(sol)
    // Buscar orden para referencia
    const orden = (t.ordenes || []).find(o => o.id === orderId)
    await saveTienda(wsId, t, d)
    // Notificar por WhatsApp al vendedor si está configurado
    const wappVendedor = (t.settings || {}).whatsapp
    if (wappVendedor && process.env.WAPP_URL) {
      const msg = `📦 *Nueva solicitud de ${tipo || 'cambio'}*\n\n*De:* ${nombre || telefono}\n*Pedido:* #${orden?.numero || orderId}\n*Motivo:* ${motivo}\n\n_Respondé desde el panel de operaciones._`
      fetch(process.env.WAPP_URL + '/api/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: wappVendedor, text: msg })
      }).catch(() => {})
    }
    // Confirmar al cliente por WhatsApp
    if (telefono && process.env.WAPP_URL) {
      const msgCliente = `✅ *Recibimos tu solicitud de ${tipo || 'cambio'}*\n\nHola ${nombre || ''}! Ya registramos tu pedido. Te contactamos a la brevedad para coordinar. ¡Gracias por elegirnos! 🙏`
      fetch(process.env.WAPP_URL + '/api/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: telefono.replace(/\D/g, ''), text: msgCliente })
      }).catch(() => {})
    }
    res.json({ ok: true, id: sol.id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/store/returns — listar solicitudes (admin)
app.get('/api/store/returns', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.json({ solicitudes: [] })
    res.json({ solicitudes: result.t.solicitudes || [] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PATCH /api/store/returns/:id — actualizar estado (admin)
app.patch('/api/store/returns/:id', async (req, res) => {
  const { id } = req.params
  const { wsId, estado, nota } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    const idx = (t.solicitudes || []).findIndex(s => s.id === id)
    if (idx === -1) return res.status(404).json({ error: 'Solicitud no encontrada' })
    t.solicitudes[idx].estado = estado || t.solicitudes[idx].estado
    if (nota) t.solicitudes[idx].nota = nota
    t.solicitudes[idx].updatedAt = new Date().toISOString()
    await saveTienda(wsId, t, d)
    res.json({ ok: true, solicitud: t.solicitudes[idx] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── GET /api/store/pages — páginas (admin)
app.get('/api/store/pages', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.json({ paginas: [] })
    res.json({ paginas: result.t.paginas || [] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── POST /api/store/pages — crear/actualizar página
app.post('/api/store/pages', async (req, res) => {
  const { wsId, pagina } = req.body
  if (!wsId || !pagina) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    if (!t.paginas) t.paginas = []
    if (pagina.id) {
      const idx = t.paginas.findIndex(p => p.id === pagina.id)
      if (idx >= 0) { t.paginas[idx] = { ...t.paginas[idx], ...pagina }; }
      else t.paginas.push(pagina)
    } else {
      const slug = (pagina.titulo || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40)
      t.paginas.push({ ...pagina, id: 'pg_' + Date.now().toString(36), slug: pagina.slug || slug, activo: true })
    }
    await saveTienda(wsId, t, d)
    res.json({ ok: true, paginas: t.paginas })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── DELETE /api/store/pages/:id
app.delete('/api/store/pages/:id', async (req, res) => {
  const { id } = req.params
  const { wsId } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    t.paginas = (t.paginas || []).filter(p => p.id !== id)
    await saveTienda(wsId, t, d)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ════════════════════════════════════════════════════
// EMAIL — /api/email/*   (usa Resend)
// ════════════════════════════════════════════════════

// Usa fetch() directo a la API REST de Resend — no depende del paquete npm
async function _resendSend({ from, to, subject, html, replyTo }) {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY no configurado')
  const body = { from, to: Array.isArray(to) ? to : [to], subject, html }
  if (replyTo) body.reply_to = replyTo
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.message || data?.name || `Resend error ${r.status}`)
  return data
}
function _getResend() {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY no configurado')
  return {
    emails: {
      send: (params) => _resendSend(params).then(data => ({ data, error: null })).catch(e => ({ data: null, error: { message: e.message } }))
    }
  }
}

function _buildFrom(fromName) {
  // Si hay dominio propio configurado usa ese; si no el sandbox de Resend
  const domain = process.env.EMAIL_FROM_DOMAIN || 'resend.dev'
  const user   = process.env.EMAIL_FROM_USER   || 'onboarding'
  const addr   = `${user}@${domain}`
  return fromName ? `${fromName} <${addr}>` : addr
}

// ── POST /api/email/test — envía un email de prueba
app.post('/api/email/test', async (req, res) => {
  const { to, subject, html, from, replyTo } = req.body
  if (!to || !subject || !html) return res.status(400).json({ error: 'Faltan campos: to, subject, html' })
  try {
    const resend = _getResend()
    const payload = {
      from:    from    || _buildFrom(),
      to:      [to],
      subject,
      html,
    }
    if (replyTo) payload.reply_to = replyTo
    const result = await resend.emails.send(payload)
    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error))
    res.json({ ok: true, id: result.data?.id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/email/send — envía un email a un contacto
app.post('/api/email/send', async (req, res) => {
  const { to, subject, html, from, replyTo, nombre } = req.body
  if (!to || !subject || !html) return res.status(400).json({ error: 'Faltan campos: to, subject, html' })
  try {
    const resend = _getResend()
    // Personalizar con nombre si viene
    const htmlFinal = nombre
      ? html.replace(/\{nombre\}/g, nombre).replace(/\{name\}/g, nombre)
      : html
    const payload = {
      from:    from    || _buildFrom(),
      to:      [to],
      subject: nombre ? subject.replace(/\{nombre\}/g, nombre) : subject,
      html:    htmlFinal,
    }
    if (replyTo) payload.reply_to = replyTo
    const result = await resend.emails.send(payload)
    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error))
    res.json({ ok: true, id: result.data?.id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/email/flow — envía email desde un flow (con variables de contacto)
app.post('/api/email/flow', async (req, res) => {
  const { wsId, to, subject, html, from, replyTo, contacto } = req.body
  if (!to || !subject || !html) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const resend = _getResend()
    // Reemplazar todas las variables {nombre}, {apellido}, etc.
    const vars = contacto || {}
    const replace = (s) => s
      .replace(/\{nombre\}/g,      vars.nombre      || '')
      .replace(/\{apellido\}/g,    vars.apellido     || '')
      .replace(/\{email\}/g,       vars.email        || '')
      .replace(/\{tel\}/g,         vars.tel          || '')
      .replace(/\{ultimaCompra\}/g,vars.ultimaCompra || '')
      .replace(/\{cantCompras\}/g, String(vars.cantCompras || 0))
      .replace(/\{valor\}/g,       String(vars.valorTotal  || 0))
      .replace(/\{etapa\}/g,       vars.etapa        || '')
      .replace(/\{cashback\}/g,    vars.cashback != null ? '$' + Number(vars.cashback).toLocaleString('es-AR') : '$0')
      .replace(/\{unsubscribe\}/g, vars.unsubUrl || '#')
    // Determine from address: workspace settings > env vars > sandbox
    let resolvedFrom = from
    if (!resolvedFrom && wsId) {
      try {
        const ws = await getWorkspace(wsId)
        const emailSettings = { ...(ws?.data?.tienda?.settings || {}), ...(ws?.data?.store?.settings || {}) }
        const fromDomain = emailSettings.emailFromDomain || process.env.EMAIL_FROM_DOMAIN || 'resend.dev'
        const fromUser = emailSettings.emailFromUser || process.env.EMAIL_FROM_USER || 'onboarding'
        const fromName = emailSettings.emailFromName || ''
        const addr = `${fromUser}@${fromDomain}`
        resolvedFrom = fromName ? `${fromName} <${addr}>` : addr
      } catch(e) { resolvedFrom = _buildFrom() }
    }
    if (!resolvedFrom) resolvedFrom = _buildFrom()
    const payload = {
      from:    resolvedFrom,
      to:      [to],
      subject: replace(subject),
      html:    replace(html),
    }
    if (replyTo) payload.reply_to = replyTo
    const result = await resend.emails.send(payload)
    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error))
    res.json({ ok: true, id: result.data?.id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Email open tracking pixel ─────────────────────────────────────────────
app.get('/api/em/open', async (req, res) => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store,no-cache,must-revalidate' })
  res.send(gif)
  try {
    const { cid, wsId } = req.query
    if (!cid || !wsId) return
    const ws = await getWorkspace(wsId)
    if (!ws?.data) return
    const camp = (ws.data.emailCampaigns || []).find(c => c.id === cid)
    if (!camp) return
    camp.openCount = (camp.openCount || 0) + 1
    await patchWorkspace(wsId, ws.data)
  } catch(e) { /* best-effort */ }
})

// ── Email click tracking redirect ──────────────────────────────────────────
app.get('/api/em/click', async (req, res) => {
  const { cid, wsId, url } = req.query
  const dest = url ? decodeURIComponent(url) : '/'
  res.redirect(302, dest)
  try {
    if (!cid || !wsId) return
    const ws = await getWorkspace(wsId)
    if (!ws?.data) return
    const camp = (ws.data.emailCampaigns || []).find(c => c.id === cid)
    if (!camp) return
    camp.clickCount = (camp.clickCount || 0) + 1
    await patchWorkspace(wsId, ws.data)
  } catch(e) { /* best-effort */ }
})

// ── Email unsubscribe ──────────────────────────────────────────────────────
app.get('/api/em/unsub', async (req, res) => {
  const { email, wsId } = req.query
  if (!email || !wsId) return res.status(400).send('<h2>Parámetros inválidos</h2>')
  try {
    const ws = await getWorkspace(wsId)
    if (ws?.data) {
      if (!ws.data.unsubList) ws.data.unsubList = []
      if (!ws.data.unsubList.includes(email.toLowerCase())) {
        ws.data.unsubList.push(email.toLowerCase())
        await patchWorkspace(wsId, ws.data)
      }
    }
  } catch(e) { /* best-effort */ }
  const safe = email.replace(/[<>"]/g, '')
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Desuscripción</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#333;padding:0 20px}h2{font-size:22px;margin-bottom:8px}p{color:#666;font-size:14px;line-height:1.6}</style></head><body><h2>✅ Desuscripción exitosa</h2><p>El email <strong>${safe}</strong> fue eliminado de esta lista de envíos.<br>No recibirás más correos de esta campaña.</p></body></html>`)
})

// Tienda pública — debe estar ANTES del catch-all
app.get('/tienda', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
  res.sendFile(__dirname + '/views/tienda.html')
})

// ══════════════════════════════════════════════════════════════
// ── GOOGLE DRIVE INTEGRATION ────────────────────────────────
// ══════════════════════════════════════════════════════════════
const GDRIVE_CLIENT_ID     = () => (process.env.GDRIVE_CLIENT_ID     || '').trim()
const GDRIVE_CLIENT_SECRET = () => (process.env.GDRIVE_CLIENT_SECRET || '').trim()
const GDRIVE_REDIRECT      = () => (process.env.GDRIVE_REDIRECT || (APP_BASE_URL() + '/api/drive/callback')).trim()

// Refresh a Google access token using a refresh token
async function _driveRefreshToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GDRIVE_CLIENT_ID(),
      client_secret: GDRIVE_CLIENT_SECRET(),
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  })
  const d = await r.json()
  if (!d.access_token) throw new Error('No se pudo refrescar el token de Drive')
  return d.access_token
}

// Helper: get a valid access token for Drive (refreshes if needed)
async function _driveAccessToken(wsId) {
  const ws = await getWorkspace(wsId)
  if (!ws) throw new Error('Workspace no encontrado')
  const di = ws.data?.driveIntegration
  if (!di?.accessToken && !di?.refreshToken) throw new Error('Drive no conectado')
  let token = di.accessToken
  // If no access token or looks expired, try refresh
  if (!token && di.refreshToken) {
    token = await _driveRefreshToken(di.refreshToken)
    const d2 = ws.data || {}
    d2.driveIntegration = { ...di, accessToken: token }
    await patchWorkspace(wsId, d2)
  }
  return { token, ws }
}

// GET /api/drive/connect — start OAuth
app.get('/api/drive/connect', (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).send('Falta wsId')
  if (!GDRIVE_CLIENT_ID()) return res.status(500).send('GDRIVE_CLIENT_ID no configurado')
  const params = new URLSearchParams({
    client_id: GDRIVE_CLIENT_ID(),
    redirect_uri: GDRIVE_REDIRECT(),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state: wsId
  })
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

// GET /api/drive/callback — OAuth callback
app.get('/api/drive/callback', async (req, res) => {
  const { code, state: wsId, error } = req.query
  if (error) return res.redirect(`/?driveOAuth=error&msg=${encodeURIComponent(error)}`)
  if (!code || !wsId) return res.redirect('/?driveOAuth=error&msg=missing_params')
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GDRIVE_CLIENT_ID(),
        client_secret: GDRIVE_CLIENT_SECRET(),
        redirect_uri: GDRIVE_REDIRECT(),
        grant_type: 'authorization_code',
        code
      }).toString()
    })
    const d = await r.json()
    if (!d.access_token) throw new Error(d.error_description || 'Token inválido')
    const ws = await getWorkspace(wsId)
    if (!ws) throw new Error('Workspace no encontrado')
    const data = ws.data || {}
    data.driveIntegration = {
      accessToken: d.access_token,
      refreshToken: d.refresh_token || data.driveIntegration?.refreshToken || '',
      connectedAt: new Date().toISOString()
    }
    await patchWorkspace(wsId, data)
    res.redirect(`/?driveOAuth=ok&wsId=${encodeURIComponent(wsId)}`)
  } catch(e) {
    console.error('[Drive OAuth]', e.message)
    res.redirect(`/?driveOAuth=error&msg=${encodeURIComponent(e.message)}`)
  }
})

// GET /api/drive/files — list image/video files from Drive
app.get('/api/drive/files', async (req, res) => {
  const { wsId, folderId, pageToken, search } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const { token, ws } = await _driveAccessToken(wsId)
    const mimeFilter = "(mimeType contains 'image/' or mimeType contains 'video/') and trashed = false"
    const searchFilter = search ? ` and name contains '${search.replace(/'/g, "\\'")}'` : ''
    const folderFilter = folderId ? ` and '${folderId}' in parents` : ''
    const params = new URLSearchParams({
      fields: 'files(id,name,mimeType,thumbnailLink,modifiedTime,size,parents),nextPageToken',
      orderBy: 'modifiedTime desc',
      pageSize: '48',
      q: mimeFilter + folderFilter + searchFilter,
    })
    if (pageToken) params.set('pageToken', pageToken)
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const d = await r.json()
    // If 401, try token refresh
    if (d.error?.code === 401) {
      const refreshToken = ws.data?.driveIntegration?.refreshToken
      if (!refreshToken) return res.status(401).json({ error: 'Token expirado, reconectá Drive' })
      const newToken = await _driveRefreshToken(refreshToken)
      const wsData = ws.data || {}
      wsData.driveIntegration = { ...wsData.driveIntegration, accessToken: newToken }
      await patchWorkspace(wsId, wsData)
      const r2 = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
        headers: { Authorization: `Bearer ${newToken}` }
      })
      const d2 = await r2.json()
      if (d2.error) return res.status(400).json({ error: d2.error.message })
      return res.json({ files: d2.files || [], nextPageToken: d2.nextPageToken || null })
    }
    if (d.error) return res.status(400).json({ error: d.error.message })
    res.json({ files: d.files || [], nextPageToken: d.nextPageToken || null })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/drive/thumbnail — proxy a Drive file thumbnail
app.get('/api/drive/thumbnail', async (req, res) => {
  const { wsId, fileId } = req.query
  if (!wsId || !fileId) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const { token } = await _driveAccessToken(wsId)
    const metaR = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=thumbnailLink,mimeType,name`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const meta = await metaR.json()
    if (meta.error) return res.status(404).send('Sin thumbnail')
    if (meta.thumbnailLink) {
      return res.redirect(meta.thumbnailLink.replace(/=s\d+$/, '=s400'))
    }
    res.status(404).send('Sin thumbnail')
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/drive/to-meta — download Drive file and upload to Meta Ads as image
app.post('/api/drive/to-meta', async (req, res) => {
  const { wsId, fileId, fileName } = req.body
  if (!wsId || !fileId) return res.status(400).json({ error: 'Faltan campos' })
  try {
    const { token, ws } = await _driveAccessToken(wsId)

    // Get file metadata
    const metaR = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType,size`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const meta = await metaR.json()
    if (meta.error) throw new Error(meta.error.message)
    const mimeType = meta.mimeType || 'image/jpeg'
    const name = fileName || meta.name || 'archivo'

    // Check size (Meta limit: 30MB for images, 1GB for video - we cap at 30MB here)
    if (parseInt(meta.size || 0) > 31457280) throw new Error('Archivo demasiado grande (máx 30MB)')

    // Download file binary
    const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!fileRes.ok) throw new Error('No se pudo descargar el archivo de Drive')

    // Convert to base64
    const buffer = await fileRes.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')

    // Upload to Meta via existing upload-image logic
    const metaAccess = ws.data?.metaIntegration?.accessToken
    const adAccountId = ws.data?.metaIntegration?.adAccountId
    if (!metaAccess || !adAccountId) throw new Error('Meta Ads no conectado')

    const accountId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`
    const uploadRes = await fetch(`https://graph.facebook.com/v21.0/${accountId}/adimages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes: base64, access_token: metaAccess, name })
    })
    const uploadData = await uploadRes.json()
    if (uploadData.error) throw new Error(uploadData.error.message)

    // Extract hash from response
    const images = uploadData.images || {}
    const firstKey = Object.keys(images)[0]
    const hash = images[firstKey]?.hash || null
    const url  = images[firstKey]?.url  || null

    res.json({ ok: true, hash, url, name })
  } catch(e) {
    console.error('[Drive→Meta]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/drive/disconnect — remove Drive credentials
app.post('/api/drive/disconnect', async (req, res) => {
  const { wsId } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: 'WS no encontrado' })
    const data = ws.data || {}
    delete data.driveIntegration
    await patchWorkspace(wsId, data)
    res.json({ ok: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Helpers server-side para computar tareas de flows (replica lógica client-side) ──────────────

function _daysBetweenServer(dateStr, today) {
  const d1 = new Date(dateStr), d2 = new Date(today)
  if (isNaN(d1) || isNaN(d2)) return null
  return Math.floor((d2 - d1) / 86400000)
}

function _addDaysServer(dateStr, days) {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function _flowStepOffsetServer(steps, targetIdx) {
  let offset = 0
  for (let i = 0; i < targetIdx; i++) {
    const s = steps[i]
    if (s && s.type === 'wait') {
      const val = Number(s.value || 0)
      const unit = s.unit || 'days'
      offset += unit === 'minutes' ? val * 60000 : unit === 'hours' ? val * 3600000 : val * 86400000
    }
  }
  return offset
}

// Calcula todas las tareas de flows pendientes para un workspace dado
// Replica la lógica de computeFlowTasks() del browser
function _computeFlowTasksServer(d) {
  const today = new Date().toISOString().slice(0, 10)
  const flowDone = d.flowDone || {}
  const tasks = []

  ;(d.flows || []).forEach(f => {
    if (!f.enabled) return
    const trig = f.trigger || {}
    const delayVal = trig.delayValue != null ? Number(trig.delayValue) : Number(trig.days || 0)
    const delayUnit = trig.delayUnit || 'dias'
    const delayMs = delayUnit === 'minutos' ? delayVal * 60000 : delayUnit === 'horas' ? delayVal * 3600000 : delayVal * 86400000
    const delayDays = Math.round(delayMs / 86400000)
    const trigType = trig.type

    ;(d.crm || []).forEach(c => {
      if (f.filter?.estados?.length) {
        const estado = c.estado || 'Cliente'
        if (!f.filter.estados.includes(estado)) return
      }

      let triggerKey = null, entryDate = null

      if ((trigType === 'after_purchase' || trigType === 'post_purchase' || trigType === 'payment_confirmed' || trigType === 'order_placed') && c.ultimaCompra) {
        const diff = _daysBetweenServer(c.ultimaCompra, today)
        if (diff !== null && diff >= delayDays) {
          const prefixMap = { post_purchase: 'pp', payment_confirmed: 'pc', order_placed: 'op' }
          const pfx = prefixMap[trigType]
          triggerKey = pfx ? `${pfx}_${c.ultimaCompra}` : c.ultimaCompra
          entryDate = _addDaysServer(c.ultimaCompra, delayDays)
        }
      } else if (trigType === 'new_lead' && c.creado) {
        const diff = _daysBetweenServer(c.creado, today)
        if (diff !== null && diff >= delayDays) {
          triggerKey = `nl_${c.creado}`
          entryDate = _addDaysServer(c.creado, delayDays)
        }
      } else if (trigType === 'cart_abandon' && c.cartDate) {
        const diff = _daysBetweenServer(c.cartDate, today)
        if (diff !== null && diff >= delayDays) {
          triggerKey = `ca_${c.cartDate}`
          entryDate = _addDaysServer(c.cartDate, delayDays)
        }
      } else if (trigType === 'after_creation' && c.creado) {
        const diff = _daysBetweenServer(c.creado, today)
        if (diff !== null && diff >= delayDays) {
          triggerKey = c.creado
          entryDate = _addDaysServer(c.creado, delayDays)
        }
      } else if (trigType === 'no_contact') {
        const ref = c.ultimoContacto || c.creado
        if (ref && delayDays > 0) {
          const diff = _daysBetweenServer(ref, today)
          if (diff !== null && diff >= delayDays) {
            triggerKey = `nc_${ref}`
            entryDate = _addDaysServer(ref, delayDays)
          }
        }
      } else if (trigType === 'birthday' && c.cumpleanos) {
        const bday = c.cumpleanos.slice(5, 10)
        const todayMD = today.slice(5, 10)
        if (bday === todayMD) {
          triggerKey = `bday_${today}`
          entryDate = today
        }
      } else if (trigType === 'xp_milestone') {
        const threshold = delayDays
        if (threshold > 0 && (c.xp || 0) >= threshold) {
          triggerKey = `xpm_${threshold}`
          entryDate = today
        }
      }

      if (!triggerKey || !entryDate) return
      if (!f.steps?.length) return

      for (let si = 0; si < f.steps.length; si++) {
        const step = f.steps[si]
        const isWA    = step.type === 'message' && step.action === 'whatsapp'
        const isEmail = step.type === 'email'
        const isBoth  = step.type === 'both'
        if (!isWA && !isEmail && !isBoth) continue

        const offsetMs = _flowStepOffsetServer(f.steps, si)
        const [ey, em, ed] = entryDate.slice(0, 10).split('-').map(Number)
        const dueTs = new Date(ey, em - 1, ed).getTime() + offsetMs
        if (Date.now() < dueTs) continue

        const cid = c.id || (c.tel || '').replace(/\D/g,'') || (c.email || '').replace(/[^a-z0-9]/gi,'') || 'anon'
        const key = `${f.id}|${cid}|${triggerKey}|step${si}`
        if (flowDone[key]) continue

        tasks.push({ f, c, step, si, key, trigType, isWA, isEmail, isBoth })
      }
    })
  })

  return tasks
}

// GET /api/flows/log — historial de ejecuciones de flows
app.get('/api/flows/log', async (req, res) => {
  const { wsId, limit = '100' } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const rows = await _sGET('flow_log', `ws_id=eq.${encodeURIComponent(wsId)}&order=created_at.desc&limit=${Math.min(parseInt(limit) || 100, 500)}`)
    res.json(rows || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// POST /api/flows/test — dispara flows manualmente para un contacto (debug/test)
app.post('/api/flows/test', async (req, res) => {
  const { wsId, contactId, triggerTypes } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })
    const d = ws.data || {}

    // Si no viene contactId, usar el primero del CRM
    const contact = contactId
      ? (d.crm || []).find(c => c.id === contactId)
      : (d.crm || [])[0]
    if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' })

    const types = triggerTypes || ['after_purchase', 'post_purchase', 'payment_confirmed', 'order_placed', 'new_lead']

    // Diagnóstico rápido antes de ejecutar
    const allFlows = d.flows || []
    const enabled  = allFlows.filter(f => f.enabled === true || f.enabled === 'true')
    const matching = enabled.filter(f => types.includes(f.trigger?.type))
    const noDelay  = matching.filter(f => {
      const dv = f.trigger?.delayValue != null ? Number(f.trigger.delayValue) : Number(f.trigger?.days || 0)
      const du = f.trigger?.delayUnit || 'dias'
      const ms = du === 'minutos' ? dv*60000 : du === 'horas' ? dv*3600000 : dv*86400000
      return ms === 0
    })

    const getDelay = f => {
      const dv = f.trigger?.delayValue != null ? Number(f.trigger.delayValue) : Number(f.trigger?.days || 0)
      const du = f.trigger?.delayUnit || 'dias'
      const ms = du === 'minutos' ? dv*60000 : du === 'horas' ? dv*3600000 : dv*86400000
      return { dv, du, ms }
    }
    const diagBefore = {
      totalFlows: allFlows.length,
      enabledFlows: enabled.length,
      matchingTrigger: matching.length,
      zeroDelayReady: noDelay.length,
      contact: { id: contact.id, nombre: contact.nombre, tel: contact.tel, email: contact.email, ultimaCompra: contact.ultimaCompra, creado: contact.creado },
      allFlowsDetail: allFlows.map(f => {
        const { dv, du, ms } = getDelay(f)
        return {
          id: f.id, name: f.name,
          enabled: f.enabled,
          trigger: f.trigger?.type,
          delay: `${dv} ${du}`,
          delayMs: ms,
          steps: (f.steps||[]).map(s=>({type:s.type,action:s.action})),
          flowDoneKeys: Object.keys(d.flowDone||{}).filter(k=>k.startsWith(f.id+'|'))
        }
      })
    }

    await _processImmediateFlows(wsId, d, contact, types, { total: 0, lineas: [] })

    // Leer historial actualizado
    const freshWs2 = await getWorkspace(wsId)
    const freshHistory = (freshWs2?.data?.flowHistory || []).slice(-10)

    res.json({ ok: true, diag: diagBefore, recentHistory: freshHistory })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/flows/reset-done — limpia flowDone y flowHistory sin tocar flows ni CRM
app.post('/api/flows/reset-done', async (req, res) => {
  const { wsId } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })
    const d = ws.data || {}
    // Limpiar flowDone y flowHistory preservando TODO lo demás (flows, CRM, tienda, etc.)
    const updatedData = { ...d, flowDone: {}, flowHistory: [] }
    await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPA_KEY(), 'Authorization': 'Bearer ' + SUPA_KEY(), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ data: updatedData })
    })
    _invalidateWsCache(wsId)
    const prevCount = Object.keys(d.flowDone || {}).length
    res.json({ ok: true, cleared: prevCount, flows: (d.flows || []).length, contacts: (d.crm || []).length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/flows/force-cron — ejecuta el cron inmediatamente para un workspace (para testing/debug)
// Muestra exactamente qué tareas encontró, qué intentó enviar, y el resultado de cada una
app.post('/api/flows/force-cron', async (req, res) => {
  const { wsId } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const ws = await getWorkspace(wsId)
    if (!ws) return res.status(404).json({ error: 'Workspace no encontrado' })
    const d = ws.data || {}

    const tasks = _computeFlowTasksServer(d)
    const taskSummary = tasks.map(t => ({
      flow: t.f.name || t.f.id,
      contact: t.c.nombre || t.c.tel || t.c.email || t.key,
      tel: t.c.tel, email: t.c.email,
      type: t.isWA ? 'whatsapp' : t.isEmail ? 'email' : 'both',
      key: t.key,
      template: (t.step.template || t.step.templateWA || t.step.templateEmail || '').slice(0, 80)
    }))

    if (!tasks.length) {
      return res.json({ ok: true, message: 'No hay tareas pendientes para este workspace', tasks: [] })
    }

    // Ejecutar las tareas usando la misma lógica del cron real
    // (internamente llama al cron endpoint con ?wsId=)
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${process.env.PORT || 3000}`
    const cronSecret = process.env.CRON_SECRET || ''
    const cronRes = await fetch(`${baseUrl}/api/flows/cron?wsId=${wsId}${cronSecret ? '&secret='+cronSecret : ''}`)
    const cronData = await cronRes.json().catch(() => ({}))

    const freshWs = await getWorkspace(wsId)
    const recentHistory = (freshWs?.data?.flowHistory || []).slice(-15)

    res.json({ ok: true, foundTasks: taskSummary, cronResult: cronData, recentHistory })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/flows/cron — procesa flows pendientes con delay > 0 para todos los workspaces
// Llamado diariamente por cron (Vercel Cron o cron-job.org)
// Seguridad: requiere header x-cron-secret o query ?secret= igual a CRON_SECRET del entorno
app.get('/api/flows/cron', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET
  const provided = req.headers['x-cron-secret'] || req.query.secret
  if (cronSecret && provided !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const cronStart = Date.now()
  let totalSent = 0, totalFailed = 0, totalSkipped = 0, wsProcessed = 0
  const errors = []

  try {
    const targetWsId = req.query.wsId || null
    let workspaces = []

    if (targetWsId) {
      // Solo config — no data completa
      const rWs = await _sGET('workspaces', `id=eq.${encodeURIComponent(targetWsId)}&select=id,flows:data->flows,waProviders:data->waProviders,waConfig:data->waConfig,store:data->store,tienda:data->tienda`)
      if (rWs?.[0]) workspaces = [rWs[0]]
    } else {
      const pageSize = parseInt(req.query.limit || '30')
      const offset   = parseInt(req.query.offset || '0')
      // Cargar solo config necesaria — no crm/finanzas/reviews
      const rPage = await _sGET('workspaces', `select=id,flows:data->flows,waProviders:data->waProviders,waConfig:data->waConfig,store:data->store,tienda:data->tienda&limit=${pageSize}&offset=${offset}`)
      workspaces = rPage || []
    }

    const TIME_BUDGET_MS = 22000
    const today = new Date().toISOString().slice(0, 10)

    const _applyVarsCron = (str, c, trig) => {
      const ultimaCompra = c.ultimaCompra || today
      const delayVal = trig.delayValue != null ? Number(trig.delayValue) : Number(trig.days || 0)
      const delayUnit = trig.delayUnit || 'dias'
      const delayMs = delayUnit === 'minutos' ? delayVal * 60000 : delayUnit === 'horas' ? delayVal * 3600000 : delayVal * 86400000
      const valorStr = c.valorTotal ? '$' + Math.round(c.valorTotal).toLocaleString('es-AR') : ''
      return (str || '')
        .replace(/\{nombre\}/gi, c.nombre || '')
        .replace(/\{apellido\}/gi, c.apellido || '')
        .replace(/\{ultimaCompra\}/gi, ultimaCompra.split('-').reverse().join('/'))
        .replace(/\{cantCompras\}/gi, String(c.cantCompras || 1))
        .replace(/\{valor\}/gi, valorStr)
        .replace(/\{dias\}/gi, String(Math.round(delayMs / 86400000)))
        .replace(/\{ultimoProducto\}/gi, c.ultimoProducto || '')
        .replace(/\{numeroPedido\}/gi,   c.ultimoPedido   || '')
    }

    for (const ws of workspaces) {
      if (Date.now() - cronStart > TIME_BUDGET_MS) {
        console.log(`[cron] Presupuesto de tiempo alcanzado — procesados ${wsProcessed} workspaces`)
        break
      }

      const flows = (ws.flows || []).filter(f => f.enabled === true || f.enabled === 'true')
      if (!flows.length) continue

      // Cargar contactos de la tabla DB — paginar para workspaces con muchos contactos
      let contacts = []
      for (let off = 0; off < 50000; off += 2000) {
        const page = await db_listContacts(ws.id, { limit: 2000, offset: off }).catch(() => [])
        contacts = contacts.concat(page)
        if (page.length < 2000) break
      }
      if (!contacts.length) continue

      // Cargar flow_keys ya ejecutados para este workspace
      const doneKeys = await db_getFlowDoneKeys(ws.id).catch(() => new Set())

      // Fake d para _computeFlowTasksServer (solo necesita flows, crm y flowDone)
      const d = { flows, crm: contacts, flowDone: Object.fromEntries([...doneKeys].map(k => [k, 1])), waProviders: ws.waProviders || [], waConfig: ws.waConfig || {}, store: ws.store || {}, tienda: ws.tienda || {} }
      const tasks = _computeFlowTasksServer(d)
      if (!tasks.length) continue

      wsProcessed++
      const MAX_TASKS_PER_WS = 20
      if (tasks.length > MAX_TASKS_PER_WS) {
        console.log(`[cron] ws ${ws.id}: ${tasks.length} tasks, procesando primeras ${MAX_TASKS_PER_WS}`)
        tasks.length = MAX_TASKS_PER_WS
      }

      const _logCron = (f, c, key, channel, status, mensaje, error) =>
        db_insertFlowLog(ws.id, {
          flowId: f.id, flowName: f.name || f.id, flowKey: key,
          contactId: c.id || '', email: c.email || '', tel: c.tel || '',
          channel, status, message: (mensaje || '').slice(0, 300),
          data: { error: error || null, origen: 'cron', contactNombre: c.nombre || '' }
        }).catch(e2 => console.error('[cron] logFlow error:', e2.message))

      try {
        await Promise.allSettled(tasks.map(async task => {
          const { f, c, step, si, key, isWA, isEmail, isBoth } = task
          const trig = f.trigger || {}

          if (isWA || isBoth) {
            const phone = (c.tel || '').replace(/\D/g, '')
            const rawMsg = step.template || step.templateWA || ''
            if (!rawMsg || !phone) { totalSkipped++; return }
            const text = _applyVarsCron(rawMsg, c, trig)
            try {
              await _serverSendWa(d, phone, text, step.waProviderId)
              await _logCron(f, c, key, 'whatsapp', 'sent', text, null)
              totalSent++
              console.log(`[cron] WA enviado → flow "${f.name || f.id}" → ${c.nombre || phone}`)
            } catch (e) {
              await _logCron(f, c, key, 'whatsapp', 'failed', text, e.message)
              totalFailed++
              console.error(`[cron] WA error → flow "${f.name || f.id}" → ${c.nombre || phone}: ${e.message}`)
            }
          }

          if (isEmail || isBoth) {
            if (step.autoSend === false) { totalSkipped++; return }
            const email = (c.email || '').trim()
            const rawBody = step.template || step.templateEmail || ''
            const rawSubject = step.subject || ''
            if (!process.env.RESEND_API_KEY) {
              await _logCron(f, c, key, 'email', 'failed', rawSubject, 'RESEND_API_KEY no configurado')
              totalFailed++
              return
            }
            if (!rawBody || !email) { totalSkipped++; return }
            const bodyText = _applyVarsCron(rawBody, c, trig)
            const subjectText = _applyVarsCron(rawSubject, c, trig) || 'Mensaje automático'
            try {
              const resend = _getResend()
              const emailSettings = { ...(d.tienda?.settings || {}), ...(d.store?.settings || {}) }
              const fromDomain = emailSettings.emailFromDomain || process.env.EMAIL_FROM_DOMAIN || 'resend.dev'
              const fromUser   = emailSettings.emailFromUser   || process.env.EMAIL_FROM_USER   || 'onboarding'
              const fromName   = emailSettings.emailFromName   || ''
              const fromAddr   = `${fromUser}@${fromDomain}`
              const from       = fromName ? `${fromName} <${fromAddr}>` : fromAddr
              console.log(`[cron] email attempt → from=${from} to=${email} flow="${f.name||f.id}"`)
              const result = await resend.emails.send({ from, to: [email], subject: subjectText, html: bodyText })
              if (result.error) throw new Error(result.error.message || JSON.stringify(result.error))
              await _logCron(f, c, key, 'email', 'sent', subjectText, null)
              totalSent++
              console.log(`[cron] email enviado → flow "${f.name || f.id}" → ${email}`)
            } catch (e) {
              await _logCron(f, c, key, 'email', 'failed', subjectText, e.message)
              totalFailed++
              console.error(`[cron] email error → flow "${f.name || f.id}" → ${email}: ${e.message}`)
            }
          }
        }))
      } catch (e) {
        errors.push(`ws ${ws.id}: ${e.message}`)
        console.error(`[cron] Error procesando ws ${ws.id}:`, e.message)
      }
    }

    const elapsed = Date.now() - cronStart
    console.log(`[cron] Finalizado en ${elapsed}ms — enviados: ${totalSent}, fallidos: ${totalFailed}, omitidos: ${totalSkipped}, workspaces: ${wsProcessed}`)
    res.json({ ok: true, sent: totalSent, failed: totalFailed, skipped: totalSkipped, workspaces: wsProcessed, elapsed, errors: errors.length ? errors : undefined })
  } catch (e) {
    console.error('[cron] Error fatal:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/store/payway-link — genera link de pago PayWay (Formulario de Pago)
app.post('/api/store/payway-link', async (req, res) => {
  const { wsId, cart, cliente, envio, total, descuento, cuponCodigo } = req.body
  if (!wsId || !cart?.length || !cliente || total == null)
    return res.status(400).json({ error: 'Faltan datos (wsId, cart, cliente, total)' })
  try {
    // Retry getTienda ante fallos transitorios de cold-start (Supabase tarda en responder)
    let result = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await getTienda(wsId) } catch(e) { /* transient */ }
      if (result) break
      if (attempt < 2) await new Promise(r => setTimeout(r, 700 * (attempt + 1)))
    }
    if (!result) {
      console.error(`[payway-link] getTienda null para wsId=${wsId}`)
      return res.status(404).json({ error: 'Tienda no encontrada', wsId })
    }
    const { t, d } = result
    const _pwRaw = t.settings?.payway || {}
    const pw = {
      siteId:     _pwRaw.siteId     || process.env.PAYWAY_SITE_ID     || '',
      templateId: _pwRaw.templateId || process.env.PAYWAY_TEMPLATE_ID || '',
      privateKey: _pwRaw.privateKey || process.env.PAYWAY_PRIVATE_KEY || '',
      publicKey:  _pwRaw.publicKey  || process.env.PAYWAY_PUBLIC_KEY  || '',
      sandbox:    _pwRaw.sandbox    || false,
    }
    if (!pw.siteId || !pw.privateKey)
      return res.status(400).json({ error: 'PayWay no configurado — ingresá Site ID y API Key privada en Integraciones → PayWay' })

    const sandbox = pw.sandbox || false
    const endpoint = sandbox
      ? 'https://developers.decidir.com/api/v1/checkout-payment-button/link'
      : 'https://ventasonline.payway.com.ar/api/v1/checkout-payment-button/link'

    const orderId = 'pwp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const numero  = (t.ordenes?.length || 0) + 1
    // Siempre HTTPS en producción — x-forwarded-proto puede estar vacío en cold starts
    const host    = req.get('host') || 'soul-ecommlab.com'
    const proto   = req.headers['x-forwarded-proto'] || 'https'
    const baseUrl = `${proto}://${host}`

    const payload = {
      site_transaction_id: orderId,
      site: String(pw.siteId),
      currency: 'ARS',
      amount: parseFloat(total),
      redirect_url:      `${baseUrl}/api/store/payway-return?wsId=${wsId}&orderId=${orderId}`,
      cancel_url:        `${baseUrl}/tienda?ws=${wsId}&payway=cancelado`,
      notifications_url: `${baseUrl}/api/store/payway-notify?wsId=${wsId}&orderId=${orderId}`,
    }

    // Llamar a PayWay PRIMERO — el pending order save puede colgar si el workspace es grande
    const _pwAbort = new AbortController()
    const _pwTimeout = setTimeout(() => _pwAbort.abort(), 12000)
    let r
    try {
      r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'apikey': pw.privateKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: _pwAbort.signal
      })
    } finally {
      clearTimeout(_pwTimeout)
    }
    const rawText = await r.text()
    let data; try { data = JSON.parse(rawText) } catch(e) { data = { rawText } }
    if (!r.ok) {
      const errDetail = data.validation_errors?.[0]?.message || data.validation_errors?.[0]?.code
        || data.param || data.description || data.error || rawText.slice(0, 200)
      console.error(`[PW-ERR] ${r.status} | SENT:${JSON.stringify(payload).slice(0,300)} | GOT:${rawText.slice(0,400)}`)
      return res.status(502).json({ error: `PayWay error ${r.status}: ${errDetail}`, raw: data })
    }

    // PayWay devuelve payment_link directo con la URL completa
    const checkoutUrl = data.payment_link || (data.payment_id
      ? (sandbox ? `https://developers.decidir.com/web/checkout/${data.payment_id}` : `https://live.decidir.com/web/checkout/${data.payment_id}`)
      : null)
    if (!checkoutUrl) {
      console.error('[payway-link] Sin URL en respuesta:', rawText)
      return res.status(400).json({ error: 'PayWay no devolvió URL de pago', raw: data })
    }

    // Guardar pending order DESPUÉS de tener el link (non-fatal, con timeout de 6s para no bloquear)
    const _pendingSave = (async () => {
      try {
        const freshWs = await getWorkspace(wsId)
        const wd = freshWs?.data || {}
        if (!wd.pendingPaywayOrders) wd.pendingPaywayOrders = {}
        for (const [k, v] of Object.entries(wd.pendingPaywayOrders)) {
          if (Date.now() - (v.ts || 0) > 7_200_000) delete wd.pendingPaywayOrders[k]
        }
        wd.pendingPaywayOrders[orderId] = {
          cart, cliente, envio: envio || {},
          total: parseFloat(total),
          descuento: parseFloat(descuento || 0),
          cuponCodigo: cuponCodigo || null,
          numero, ts: Date.now()
        }
        await patchWorkspace(wsId, wd)
        _invalidateWsCache(wsId)
      } catch(saveErr) {
        console.warn(`[payway-link] pendingOrder save failed (non-fatal): ${saveErr.message}`)
      }
    })()
    const _saveTimeout = new Promise(resolve => setTimeout(resolve, 6000, 'timeout'))
    const _saveResult = await Promise.race([_pendingSave, _saveTimeout])
    if (_saveResult === 'timeout') console.warn('[payway-link] pendingOrder save timed out — continuando')

    console.log(`[payway-link] Link creado para ws ${wsId}, orderId ${orderId}: ${checkoutUrl}`)
    res.json({ ok: true, checkoutUrl, paywayId: data.payment_id || orderId })
  } catch (e) {
    console.error('[payway-link]', e.message)
    res.status(500).json({ error: e.message })
  }
})


// GET /api/store/payway-return — PayWay redirige aquí después del pago
app.get('/api/store/payway-return', async (req, res) => {
  const { wsId, orderId } = req.query
  if (!wsId || !orderId) return res.redirect(`/tienda?ws=${wsId||''}&payway=error&msg=missing-params`)
  try {
    const freshWs = await getWorkspace(wsId)
    const d = freshWs?.data || {}
    const pending = d.pendingPaywayOrders?.[orderId]
    if (!pending) {
      console.warn('[payway-return] Pending order not found:', orderId)
      return res.redirect(`/tienda?ws=${wsId}&payway=error&msg=orden-no-encontrada`)
    }
    const result = await getTienda(wsId)
    if (!result) return res.redirect(`/tienda?ws=${wsId}&payway=error&msg=ws-no-encontrado`)
    const { t } = result
    const { cart, cliente, envio, total, descuento, cuponCodigo, numero } = pending

    const hoy = new Date().toISOString().slice(0, 10)
    const lineas = (cart || []).map(i => ({ id: i.id, nombre: i.nombre, precio: parseFloat(i.precio) || 0, cantidad: i.cantidad || i.qty || 1 }))
    const totalOrden = parseFloat(total)

    const orden = {
      id: orderId,
      numero,
      fecha: new Date().toISOString(),
      estado: 'pagado',
      metodoPago: 'tarjeta',
      cliente,
      envio: envio || {},
      lineas,
      total: totalOrden,
      descuento: parseFloat(descuento || 0),
      cupon: cuponCodigo || null,
      paywayPaymentId: req.query.payment_id || req.query.payway_payment_id || null
    }

    if (!t.ordenes) t.ordenes = []
    t.ordenes.push(orden)

    // CRM update
    if (!d.crm) d.crm = []
    const telClean   = (cliente.tel   || '').replace(/\D/g, '')
    const emailClean = (cliente.email || '').toLowerCase().trim()
    let crmIdx = -1
    if (telClean)   crmIdx = d.crm.findIndex(c => (c.tel   || '').replace(/\D/g,'') === telClean)
    if (crmIdx < 0 && emailClean) crmIdx = d.crm.findIndex(c => (c.email || '').toLowerCase() === emailClean)

    if (crmIdx >= 0) {
      const contacto = d.crm[crmIdx]
      contacto.ultimaCompra = hoy
      contacto.ultimoPedido = String(orden.numero || orderId || '')
      contacto.cantCompras  = (parseInt(contacto.cantCompras || 0)) + 1
      contacto.valorTotal   = Math.round((parseFloat(contacto.valorTotal || 0) + totalOrden) * 100) / 100
    } else {
      d.crm.push({
        id: 'c_' + Date.now().toString(36),
        nombre: cliente.nombre || '', apellido: cliente.apellido || '',
        email: emailClean, tel: telClean,
        creado: hoy, ultimaCompra: hoy, ultimoPedido: String(orden.numero || orderId || ''),
        cantCompras: 1, valorTotal: totalOrden, estado: 'Cliente'
      })
      crmIdx = d.crm.length - 1
    }

    // Finanzas
    if (!d.finanzas) d.finanzas = []
    if (!d.finanzas.some(f => f.id === orderId) && totalOrden > 0) {
      d.finanzas.push({
        id: orderId, fecha: hoy, tipo: 'ingreso',
        categoria: 'Ventas',
        descripcion: `Pedido #${numero} — ${cliente.nombre || ''} (PayWay)`,
        monto: totalOrden
      })
    }

    // Remove pending order
    delete d.pendingPaywayOrders[orderId]
    d.tienda = t

    await patchWorkspace(wsId, d)
    _invalidateWsCache(wsId)

    // Trigger flows
    const crmContact = d.crm[crmIdx]
    if (crmContact) {
      _processImmediateFlows(wsId, d, crmContact,
        ['after_purchase', 'post_purchase', 'payment_confirmed', 'order_placed'],
        { total: totalOrden, lineas }
      ).catch(() => {})
    }

    console.log(`[payway-return] Orden ${orderId} #${numero} procesada para ws ${wsId}`)
    res.redirect(`/tienda?ws=${wsId}&payway=ok&numero=${numero}&nombre=${encodeURIComponent(cliente.nombre || '')}&total=${totalOrden}`)
  } catch (e) {
    console.error('[payway-return]', e.message)
    res.redirect(`/tienda?ws=${wsId}&payway=error&msg=${encodeURIComponent(e.message)}`)
  }
})

// POST /api/store/payway-notify — webhook server-to-server de PayWay
app.post('/api/store/payway-notify', async (req, res) => {
  const { wsId, orderId } = req.query
  console.log('[payway-notify] ws', wsId, 'orden', orderId, JSON.stringify(req.body || {}).slice(0, 300))
  res.json({ ok: true })
})

// ══════════════════════════════════════════════════════════════
// ── UGC — CANJES / COLABORACIONES ───────────────────────────
// ══════════════════════════════════════════════════════════════
const crypto = require('crypto')

// Fetch helper reutilizable para Supabase REST
async function _supa(method, table, { filter, body, select, prefer } = {}) {
  let url = `${SUPA_URL}/rest/v1/${table}`
  const parts = []
  if (filter)  parts.push(filter)
  if (select)  parts.push('select=' + select)
  if (parts.length) url += '?' + parts.join('&')
  const headers = {
    apikey: SUPA_KEY(), Authorization: 'Bearer ' + SUPA_KEY(),
    'Content-Type': 'application/json',
    Prefer: prefer || 'return=representation'
  }
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  return { ok: r.ok, status: r.status, data }
}

// Middleware: autenticar creadora por token Bearer
async function _requireCreadora(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return res.status(401).json({ error: 'Sin token' })
  try {
    const r = await _supa('GET', 'ugc_sessions', {
      filter: `token=eq.${token}&tipo=eq.session`,
      select: 'creadora_id,expira_at'
    })
    const row = r.data?.[0]
    if (!row) return res.status(401).json({ error: 'Token inválido' })
    if (new Date(row.expira_at) < new Date()) return res.status(401).json({ error: 'Token expirado' })
    req.creadoraId = row.creadora_id
    next()
  } catch (e) {
    res.status(500).json({ error: 'Error de autenticación' })
  }
}

// Serve ugc-portal
app.get('/ugc-portal', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.sendFile(__dirname + '/views/ugc-portal.html')
})

// ── OTP: solicitar código ─────────────────────────────────────
// ── Auth: login directo con WhatsApp (sin OTP) ───────────────
app.post('/api/ugc/auth/otp', async (req, res) => {
  const { telefono } = req.body
  if (!telefono) return res.status(400).json({ error: 'Falta teléfono' })
  const clean = String(telefono).replace(/\D/g, '')
  if (clean.length < 7) return res.status(400).json({ error: 'Teléfono inválido' })

  try {
    // Crear o recuperar creadora
    const cR = await _supa('POST', 'ugc_creadoras', {
      prefer: 'resolution=merge-duplicates,return=representation',
      body: { telefono: clean }
    })
    let creadora = cR.data?.[0]
    // Supabase devuelve array vacío cuando el upsert no modifica nada (fila ya existe).
    // En ese caso la buscamos explícitamente.
    if (!creadora?.id) {
      const fetchR = await _supa('GET', 'ugc_creadoras', { filter: `telefono=eq.${clean}` })
      creadora = fetchR.data?.[0]
    }
    if (!creadora?.id) {
      console.error('[ugc/auth] No se pudo crear/recuperar creadora para tel:', clean, 'upsert:', JSON.stringify(cR.data))
      return res.status(500).json({ error: 'Error creando perfil' })
    }

    // Token de sesión 30 días
    const token = crypto.randomUUID()
    const sesExp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    // INSERT simple — cada login crea una nueva sesión (las viejas expiran solas)
    const sesR = await _supa('POST', 'ugc_sessions', {
      prefer: 'return=minimal',
      body: { tipo: 'session', telefono: clean, token, creadora_id: creadora.id, expira_at: sesExp }
    })
    if (!sesR.ok) {
      // Si falla (ej. constraint de unicidad), intenta PATCH sobre la sesión existente
      const sesPatch = await _supa('PATCH', `ugc_sessions?telefono=eq.${encodeURIComponent(clean)}&tipo=eq.session`, {
        prefer: 'return=minimal',
        body: { token, creadora_id: creadora.id, expira_at: sesExp }
      })
      if (!sesPatch.ok) {
        console.error('[ugc/auth] No se pudo crear sesión:', sesR.status, JSON.stringify(sesR.data).slice(0,200))
        return res.status(500).json({ error: 'Error al iniciar sesión. Intentá de nuevo.' })
      }
    }

    res.json({ ok: true, token, creadora })
  } catch (e) {
    console.error('[ugc/auth]', e)
    res.status(500).json({ error: 'Error al ingresar' })
  }
})

// Endpoint legacy — ya no se usa pero se mantiene por compatibilidad
app.post('/api/ugc/auth/verify', async (req, res) => {
  res.status(410).json({ error: 'Endpoint obsoleto' })
})

// ── PORTAL: canjes disponibles (SIN cupón) ────────────────────
app.get('/api/ugc/canjes', _requireCreadora, async (req, res) => {
  const wsId = req.query.ws
  if (!wsId) return res.status(400).json({ error: 'Falta parámetro ws' })
  try {
    const r = await _supa('GET', 'ugc_canjes', {
      filter: `ws_id=eq.${wsId}&estado=eq.disponible&order=created_at.desc`,
      select: 'id,producto,brief,producto_url,pago_monto,demora_max_dias,estado,portada_url,tipo_accion,lugar_nombre,descuento_tipo,created_at'
      // cupon_codigo excluido explícitamente
    })
    res.json(r.data || [])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PORTAL: solicitar un canje ────────────────────────────────
app.post('/api/ugc/solicitudes', _requireCreadora, async (req, res) => {
  const { canje_id } = req.body
  if (!canje_id) return res.status(400).json({ error: 'Falta canje_id' })
  try {
    const cR = await _supa('GET', 'ugc_canjes', {
      filter: `id=eq.${canje_id}&estado=eq.disponible`,
      select: 'id'
    })
    if (!cR.data?.[0]) return res.status(404).json({ error: 'Canje no disponible' })

    const r = await _supa('POST', 'ugc_solicitudes', {
      body: { canje_id, creadora_id: req.creadoraId }
    })
    if (!r.ok) {
      if (r.status === 409) return res.status(409).json({ error: 'Ya solicitaste este canje' })
      return res.status(400).json({ error: 'Error al solicitar' })
    }
    res.json({ ok: true, solicitud: r.data?.[0] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PORTAL: mis solicitudes ───────────────────────────────────
app.get('/api/ugc/mis-solicitudes', _requireCreadora, async (req, res) => {
  const FILTER = `creadora_id=eq.${req.creadoraId}&order=fecha_solicitud.desc`
  try {
    // Try full select with new columns; fall back if migration not yet run
    let r = await _supa('GET', 'ugc_solicitudes', {
      filter: FILTER,
      select: 'id,estado,cupon_liberado,fecha_solicitud,fecha_resolucion,fecha_limite_entrega,canje_id,mensaje_para_creadora,link_publicacion,checklist,ugc_canjes(id,producto,brief,imagenes,portada_url,producto_url,pago_monto,demora_max_dias)'
    })
    if (!r.ok) {
      // Columnas nuevas no existen aún — fallback sin checklist/imagenes
      r = await _supa('GET', 'ugc_solicitudes', {
        filter: FILTER,
        select: 'id,estado,cupon_liberado,fecha_solicitud,fecha_resolucion,fecha_limite_entrega,canje_id,mensaje_para_creadora,link_publicacion,ugc_canjes(id,producto,brief,portada_url,producto_url,pago_monto,demora_max_dias)'
      })
    }
    res.json(r.data || [])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PORTAL: cupón (SOLO si cupon_liberado = true + creadora correcta) ──
app.get('/api/ugc/solicitudes/:id/cupon', _requireCreadora, async (req, res) => {
  const { id } = req.params
  try {
    const solR = await _supa('GET', 'ugc_solicitudes', {
      filter: `id=eq.${id}&creadora_id=eq.${req.creadoraId}&cupon_liberado=eq.true`,
      select: 'id,canje_id,estado'
    })
    if (!solR.data?.[0]) return res.status(403).json({ error: 'Cupón no disponible' })

    const cR = await _supa('GET', 'ugc_canjes', {
      filter: `id=eq.${solR.data[0].canje_id}`,
      select: 'cupon_codigo'
    })
    const cupon = cR.data?.[0]?.cupon_codigo
    if (!cupon) return res.status(404).json({ error: 'Este canje no tiene cupón' })

    res.json({ ok: true, cupon_codigo: cupon })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PORTAL: actualizar perfil ─────────────────────────────────
app.patch('/api/ugc/mi-perfil', _requireCreadora, async (req, res) => {
  const { instagram_url, nombre, drive_link } = req.body
  // Don't overwrite existing data with empty strings
  const patch = {}
  if (nombre !== undefined && nombre !== '') patch.nombre = nombre
  if (instagram_url !== undefined && instagram_url !== '') patch.instagram_url = instagram_url
  if (drive_link !== undefined) patch.drive_link = drive_link || null
  if (!Object.keys(patch).length) return res.json({ ok: true })
  try {
    const r = await _supa('PATCH', `ugc_creadoras?id=eq.${req.creadoraId}`, {
      prefer: 'return=representation',
      body: patch
    })
    let creadora = r.data?.[0]
    // Supabase sometimes returns empty on PATCH with no changes — fetch current row
    if (!creadora?.id) {
      const fetchR = await _supa('GET', 'ugc_creadoras', { filter: `id=eq.${req.creadoraId}` })
      creadora = fetchR.data?.[0]
    }
    res.json({ ok: true, creadora })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PORTAL: acuerdo vigente de la creadora ───────────────────
app.get('/api/ugc/mi-acuerdo', _requireCreadora, async (req, res) => {
  try {
    const r = await _supa('GET', 'ugc_acuerdos', {
      filter: `creadora_id=eq.${req.creadoraId}&activo=eq.true&order=created_at.desc&limit=1`
    })
    res.json(r.data?.[0] || null)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── PORTAL: marcar/desmarcar acción del acuerdo ──────────────
app.patch('/api/ugc/mi-acuerdo/accion', _requireCreadora, async (req, res) => {
  const { accionId, completado, link } = req.body
  if (!accionId) return res.status(400).json({ error: 'Falta accionId' })
  try {
    // Get current acuerdo
    const r = await _supa('GET', 'ugc_acuerdos', {
      filter: `creadora_id=eq.${req.creadoraId}&activo=eq.true&order=created_at.desc&limit=1`
    })
    const acuerdo = r.data?.[0]
    if (!acuerdo) return res.status(404).json({ error: 'Sin acuerdo activo' })
    const acciones = acuerdo.acciones || []
    const idx = acciones.findIndex(a => a.id === accionId)
    if (idx < 0) return res.status(404).json({ error: 'Acción no encontrada' })
    acciones[idx] = { ...acciones[idx], completado: !!completado, fecha: completado ? new Date().toISOString().slice(0,10) : null, link: link || '' }
    await _supa('PATCH', `ugc_acuerdos?id=eq.${acuerdo.id}`, { prefer: 'return=minimal', body: { acciones } })
    res.json({ ok: true, acciones })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── PORTAL: seguimiento mensual de la creadora ───────────────
app.get('/api/ugc/mi-seguimiento', _requireCreadora, async (req, res) => {
  const { wsId } = req.query
  try {
    const now = new Date()
    const desde = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const hasta = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
    const r = await _supa('GET', 'ugc_solicitudes', {
      filter: `creadora_id=eq.${req.creadoraId}&estado=eq.realizada&fecha_resolucion=gte.${desde}&fecha_resolucion=lt.${hasta}`,
      select: 'id,fecha_resolucion,ugc_canjes(ws_id)'
    })
    const sols = (r.data || []).filter(s => !wsId || s.ugc_canjes?.ws_id === wsId)
    const semanas = [0,0,0,0,0]
    sols.forEach(s => { const d=new Date(s.fecha_resolucion).getDate(); semanas[Math.min(Math.ceil(d/7),5)-1]++ })
    res.json({ total: sols.length, semanas })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: canjes CRUD ────────────────────────────────────────
app.get('/api/admin/ugc/canjes', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('GET', 'ugc_canjes', {
      filter: `ws_id=eq.${wsId}&order=created_at.desc`
    })
    res.json(r.data || [])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/admin/ugc/canjes', async (req, res) => {
  const { wsId, ...campos } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('POST', 'ugc_canjes', { body: { ws_id: wsId, ...campos } })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0, 200) })
    res.json({ ok: true, canje: r.data?.[0] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/admin/ugc/canjes/:id', async (req, res) => {
  const { id } = req.params
  const { wsId } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    // Borrar solicitudes asociadas primero
    await _supa('DELETE', `ugc_solicitudes?canje_id=eq.${id}`, { prefer: 'return=minimal' })
    const r = await _supa('DELETE', `ugc_canjes?id=eq.${id}&ws_id=eq.${wsId}`, { prefer: 'return=minimal' })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0, 200) })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/admin/ugc/canjes/:id', async (req, res) => {
  const { id } = req.params
  const { wsId, ...campos } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('PATCH', `ugc_canjes?id=eq.${id}&ws_id=eq.${wsId}`, { body: campos })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0, 200) })
    res.json({ ok: true, canje: r.data?.[0] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: listar solicitudes ────────────────────────────────
app.get('/api/admin/ugc/solicitudes', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('GET', 'ugc_solicitudes', {
      filter: 'order=fecha_solicitud.desc',
      select: 'id,estado,cupon_liberado,fecha_solicitud,fecha_resolucion,fecha_limite_entrega,canje_id,creadora_id,notas_admin,retorno_notas,retorno_alcance,retorno_ventas,link_publicacion,mensaje_para_creadora,checklist,ugc_canjes(id,producto,ws_id,demora_max_dias),ugc_creadoras(id,nombre,telefono,instagram_url)'
    })
    const todo = r.data || []
    res.json(todo.filter(s => s.ugc_canjes?.ws_id === wsId))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: gestionar solicitud (ciclo completo de estados) ────
app.patch('/api/admin/ugc/solicitudes/:id', async (req, res) => {
  const { id } = req.params
  const { accion, demora_max_dias, wsId, notas_admin, retorno_notas, retorno_alcance, retorno_ventas, mensaje_para_creadora } = req.body
  const ACCIONES = ['aceptar','rechazar','enviar','confirmar_entrega','marcar_realizada','entregar','notas','mensaje','retorno']
  if (!ACCIONES.includes(accion)) return res.status(400).json({ error: 'Acción inválida' })

  const now = new Date().toISOString()
  const update = {}

  if (accion === 'aceptar') {
    update.estado = 'pendiente_envio'
    update.cupon_liberado = true
    update.fecha_resolucion = now
    if (demora_max_dias) update.fecha_limite_entrega = new Date(Date.now() + Number(demora_max_dias) * 86400000).toISOString()
    if (mensaje_para_creadora !== undefined) update.mensaje_para_creadora = mensaje_para_creadora
    // Generate checklist from canje brief
    try {
      const solRow = await _supa('GET', 'ugc_solicitudes', { filter: `id=eq.${id}`, select: 'canje_id' })
      const canjeId = solRow.data?.[0]?.canje_id
      if (canjeId) {
        const canjeRow = await _supa('GET', 'ugc_canjes', { filter: `id=eq.${canjeId}`, select: 'brief' })
        const brief = canjeRow.data?.[0]?.brief
        const checklist = []
        const LBL = {stories:'Story',carruseles:'Carrusel',reel:'Reel',tiktok:'TikTok',collab:'Collab'}
        if (Array.isArray(brief)) {
          brief.forEach(item => {
            for (let n = 1; n <= Math.max(1, parseInt(item.cantidad) || 1); n++) {
              checklist.push({ tipo: item.tipo, num: n, descripcion: item.descripcion || '', specs: item.specs || '', completado: false, link: '' })
            }
          })
        } else if (brief && typeof brief === 'object') {
          Object.entries(brief).forEach(([k, v]) => {
            for (let n = 1; n <= Math.max(1, parseInt(v?.cantidad) || 1); n++) {
              checklist.push({ tipo: LBL[k] || k, num: n, descripcion: '', completado: false, link: '' })
            }
          })
        }
        if (checklist.length) update.checklist = checklist
      }
    } catch (err) { console.error('[ugc/aceptar] checklist:', err.message) }
  } else if (accion === 'rechazar') {
    update.estado = 'rechazado'
    update.cupon_liberado = false
    update.fecha_resolucion = now
    if (mensaje_para_creadora !== undefined) update.mensaje_para_creadora = mensaje_para_creadora
  } else if (accion === 'enviar') {
    update.estado = 'enviado'
    if (mensaje_para_creadora !== undefined) update.mensaje_para_creadora = mensaje_para_creadora
  } else if (accion === 'confirmar_entrega') {
    update.estado = 'pendiente_publicacion'
    if (mensaje_para_creadora !== undefined) update.mensaje_para_creadora = mensaje_para_creadora
  } else if (accion === 'marcar_realizada' || accion === 'entregar') {
    update.estado = 'realizada'
    update.fecha_resolucion = now
    if (mensaje_para_creadora !== undefined) update.mensaje_para_creadora = mensaje_para_creadora
  } else if (accion === 'notas') {
    if (notas_admin !== undefined) update.notas_admin = notas_admin
  } else if (accion === 'mensaje') {
    if (mensaje_para_creadora !== undefined) update.mensaje_para_creadora = mensaje_para_creadora
  } else if (accion === 'retorno') {
    if (retorno_notas !== undefined) update.retorno_notas = retorno_notas
    if (retorno_alcance !== undefined) update.retorno_alcance = retorno_alcance || null
    if (retorno_ventas !== undefined) update.retorno_ventas = retorno_ventas || null
  }

  if (!Object.keys(update).length) return res.json({ ok: true })

  try {
    const r = await _supa('PATCH', `ugc_solicitudes?id=eq.${id}`, { body: update })
    if (!r.ok) {
      const errStr = JSON.stringify(r.data)
      // Detectar violación de CHECK constraint (error 23514) — requiere migración SQL
      if (errStr.includes('23514') || errStr.includes('check_violation')) {
        return res.status(400).json({
          error: 'La base de datos no tiene los nuevos estados. Ejecutá la migración SQL en Supabase.',
          needsMigration: true
        })
      }
      return res.status(400).json({ error: errStr.slice(0, 200) })
    }

    // Al aceptar: crear entrada en kanban de planificación
    if (accion === 'aceptar' && wsId) {
      try {
        const solR = await _supa('GET', 'ugc_solicitudes', {
          filter: `id=eq.${id}`,
          select: 'id,canje_id,creadora_id,ugc_canjes(id,producto,descuento_tipo),ugc_creadoras(id,nombre,telefono,instagram_url)'
        })
        const sol = solR.data?.[0]
        if (sol) {
          const creadora = sol.ugc_creadoras || {}
          const canje = sol.ugc_canjes || {}
          const ws = await getWorkspace(wsId)
          if (ws) {
            const data = ws.data || {}
            const creadoras = Array.isArray(data.creadoras) ? data.creadoras : []
            const oferta = [canje.producto, canje.descuento_tipo].filter(Boolean).join(' · ')
            creadoras.push({
              tipo: 'micro',
              nombre: creadora.nombre || creadora.telefono || '—',
              handle: creadora.instagram_url || '',
              cuenta: '', oferta,
              notas: `Soul PR · Aceptada el ${now.slice(0,10)}`,
              estado: 'confirmada',
              wapp: creadora.telefono || '',
              briefId: ''
            })
            await patchWorkspace(wsId, { ...data, creadoras })
          }
        }
      } catch (kErr) { console.error('[ugc/aceptar] kanban:', kErr.message) }
    }

    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PORTAL CREADORA: acción propia sobre una solicitud ────────
app.post('/api/ugc/solicitudes/:id/accion', _requireCreadora, async (req, res) => {
  const { id } = req.params
  const { accion, link_publicacion } = req.body
  if (!['confirmar_recibo','marcar_publicado'].includes(accion)) {
    return res.status(400).json({ error: 'Acción inválida' })
  }
  try {
    // Verificar que la solicitud pertenece a esta creadora
    const chk = await _supa('GET', 'ugc_solicitudes', {
      filter: `id=eq.${id}&creadora_id=eq.${req.creadoraId}`,
      select: 'id,estado'
    })
    const sol = chk.data?.[0]
    if (!sol) return res.status(403).json({ error: 'Solicitud no encontrada' })

    const update = {}
    if (accion === 'confirmar_recibo' && sol.estado === 'enviado') {
      update.estado = 'pendiente_publicacion'
    } else if (accion === 'marcar_publicado' && sol.estado === 'pendiente_publicacion') {
      update.estado = 'realizada'
      if (link_publicacion) update.link_publicacion = link_publicacion
    } else {
      return res.status(400).json({ error: 'Acción no válida en el estado actual' })
    }

    const r = await _supa('PATCH', `ugc_solicitudes?id=eq.${id}`, { body: update })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PORTAL CREADORA: actualizar checklist ────────────────────
app.patch('/api/ugc/solicitudes/:id/checklist', _requireCreadora, async (req, res) => {
  const { id } = req.params
  const { idx, completado, link } = req.body
  if (idx === undefined || idx === null) return res.status(400).json({ error: 'Falta idx' })
  try {
    const solR = await _supa('GET', 'ugc_solicitudes', {
      filter: `id=eq.${id}&creadora_id=eq.${req.creadoraId}`,
      select: 'id,checklist,estado'
    })
    const sol = solR.data?.[0]
    if (!sol) return res.status(403).json({ error: 'Solicitud no encontrada' })

    const checklist = Array.isArray(sol.checklist) ? [...sol.checklist] : []
    if (idx < 0 || idx >= checklist.length) return res.status(400).json({ error: 'Índice inválido' })

    checklist[idx] = { ...checklist[idx], completado: !!completado }
    if (link !== undefined) checklist[idx].link = link || ''

    const r = await _supa('PATCH', `ugc_solicitudes?id=eq.${id}`, { body: { checklist } })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0, 200) })

    const allDone = checklist.every(i => i.completado)
    res.json({ ok: true, checklist, allDone })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: eliminar solicitud ────────────────────────────────
app.delete('/api/admin/ugc/solicitudes/:id', async (req, res) => {
  const { id } = req.params
  try {
    const r = await _supa('DELETE', `ugc_solicitudes?id=eq.${id}`, { prefer: 'return=minimal' })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0, 200) })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: eliminar creadora ─────────────────────────────────
app.delete('/api/admin/ugc/creadoras/:id', async (req, res) => {
  const { id } = req.params
  try {
    await _supa('DELETE', `ugc_solicitudes?creadora_id=eq.${id}`, { prefer: 'return=minimal' })
    const r = await _supa('DELETE', `ugc_creadoras?id=eq.${id}`, { prefer: 'return=minimal' })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0, 200) })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: listar creadoras (con acuerdo activo) ─────────────
app.get('/api/admin/ugc/creadoras', async (req, res) => {
  try {
    const [cR, aR] = await Promise.all([
      _supa('GET', 'ugc_creadoras', { filter: 'order=created_at.desc' }),
      _supa('GET', 'ugc_acuerdos', { filter: 'activo=eq.true' })
    ])
    const acuerdoMap = {}
    for (const a of aR.data || []) acuerdoMap[a.creadora_id] = a
    const creadoras = (cR.data || []).map(c => ({ ...c, acuerdo: acuerdoMap[c.id] || null }))
    res.json(creadoras)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: actualizar creadora ───────────────────────────────
app.patch('/api/admin/ugc/creadoras/:id', async (req, res) => {
  const { id } = req.params
  const { drive_link, utm_link, score, resultados, nombre, estado_lista } = req.body
  const patch = {}
  if (nombre !== undefined) patch.nombre = nombre || null
  if (drive_link !== undefined) patch.drive_link = drive_link || null
  if (utm_link !== undefined) patch.utm_link = utm_link || null
  if (score !== undefined) patch.score = score || null
  if (resultados !== undefined) patch.resultados = resultados || null
  if (estado_lista !== undefined) patch.estado_lista = estado_lista || null
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada que actualizar' })
  try {
    const r = await _supa('PATCH', `ugc_creadoras?id=eq.${id}`, { prefer: 'return=minimal', body: patch })
    if (!r.ok) {
      console.error('[PATCH ugc_creadoras] supa error:', JSON.stringify(r.data))
      return res.status(400).json({ error: JSON.stringify(r.data).slice(0, 300) })
    }
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: crear nueva creadora manualmente ──────────────────
app.post('/api/admin/ugc/creadoras', async (req, res) => {
  const { nombre, telefono } = req.body
  if (!nombre?.trim()) return res.status(400).json({ error: 'Falta nombre' })
  const cleanTel = telefono?.replace(/\D/g,'') || null
  // telefono es NOT NULL en la tabla — si no viene, generamos un ID interno único
  const body = { nombre: nombre.trim(), telefono: cleanTel || ('admin_' + Date.now()) }
  try {
    // Buscar si ya existe una creadora con ese teléfono (evitar duplicados)
    if (cleanTel) {
      const existing = await _supa('GET', 'ugc_creadoras', { filter: `telefono=eq.${cleanTel}` })
      if (existing.data?.[0]) return res.json({ ok: true, creadora: existing.data[0] })
    }
    const r = await _supa('POST', 'ugc_creadoras', { prefer: 'return=representation', body })
    if (!r.ok) {
      console.error('[POST ugc_creadoras] supa error:', JSON.stringify(r.data))
      return res.status(500).json({ error: JSON.stringify(r.data).slice(0,200) })
    }
    if (!r.data?.[0]) return res.status(500).json({ error: 'Registro creado pero sin datos de retorno' })
    res.json({ ok: true, creadora: r.data[0] })
  } catch(e) { console.error('[POST ugc_creadoras] catch:', e.message); res.status(500).json({ error: e.message }) }
})

// ── ADMIN: guardar acuerdo (crea nuevo, desactiva anterior) ──
app.post('/api/admin/ugc/creadoras/:id/acuerdo', async (req, res) => {
  const { id } = req.params
  // req.body is spread directly so all fields (tipo, monto_fijo_mensual, frecuencia,
  // fecha_fin, notas, brief, acciones, acciones_comprometidas_mes) pass through automatically
  const { tipo, monto_fijo_mensual } = req.body
  if (!tipo) return res.status(400).json({ error: 'Falta tipo' })
  try {
    await _supa('PATCH', `ugc_acuerdos?creadora_id=eq.${id}&activo=eq.true`,
      { prefer: 'return=minimal', body: { activo: false } })
    const r = await _supa('POST', 'ugc_acuerdos', {
      prefer: 'return=representation',
      body: {
        creadora_id: id,
        activo: true,
        ...req.body,
        monto_fijo_mensual: monto_fijo_mensual != null && monto_fijo_mensual !== '' ? parseFloat(monto_fijo_mensual) : null,
      }
    })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    res.json({ ok: true, acuerdo: r.data?.[0] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: enviar oferta directa a creadoras ──────────────────
app.post('/api/admin/ugc/canjes/:id/enviar-directo', async (req, res) => {
  const canjeId = req.params.id
  const { creadora_ids } = req.body
  if (!Array.isArray(creadora_ids) || !creadora_ids.length) return res.status(400).json({ error: 'Sin creadoras seleccionadas' })
  try {
    const results = []
    for (const creadoraId of creadora_ids) {
      const existing = await _supa('GET', 'ugc_solicitudes', {
        filter: `canje_id=eq.${canjeId}&creadora_id=eq.${creadoraId}&limit=1`
      })
      if (existing.data?.length) { results.push({ creadoraId, ok: false, reason: 'Ya tiene solicitud' }); continue }
      const r = await _supa('POST', 'ugc_solicitudes', {
        prefer: 'return=representation',
        body: {
          canje_id: canjeId,
          creadora_id: creadoraId,
          estado: 'esperando_confirmacion',
          fecha_solicitud: new Date().toISOString().slice(0, 10),
          origen: 'oferta_directa'
        }
      })
      results.push({ creadoraId, ok: !!r.data?.[0] })
    }
    res.json({ ok: true, results })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: seguimiento mensual de todas las creadoras ────────
app.get('/api/admin/ugc/seguimiento', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const now = new Date()
    const desde = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const hasta = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
    const r = await _supa('GET', 'ugc_solicitudes', {
      filter: `estado=eq.realizada&fecha_resolucion=gte.${desde}&fecha_resolucion=lt.${hasta}`,
      select: 'creadora_id,fecha_resolucion,ugc_canjes(ws_id)'
    })
    const map = {}
    for (const s of (r.data || []).filter(s => s.ugc_canjes?.ws_id === wsId)) {
      if (!map[s.creadora_id]) map[s.creadora_id] = [0,0,0,0,0]
      const d = new Date(s.fecha_resolucion).getDate()
      map[s.creadora_id][Math.min(Math.ceil(d/7),5)-1]++
    }
    res.json(map)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: stats ─────────────────────────────────────────────
app.get('/api/admin/ugc/stats', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    // Marcar vencidos automáticamente
    await _supa('PATCH',
      `ugc_solicitudes?estado=eq.aceptado&fecha_limite_entrega=lt.${new Date().toISOString()}`,
      { prefer: 'return=minimal', body: { estado: 'vencido' } }
    )
    const [cR, sR] = await Promise.all([
      _supa('GET', 'ugc_canjes',     { filter: `ws_id=eq.${wsId}`, select: 'id,estado' }),
      _supa('GET', 'ugc_solicitudes', { select: 'id,estado,ugc_canjes(ws_id)' })
    ])
    const canjes = cR.data || []
    const sols   = (sR.data || []).filter(s => s.ugc_canjes?.ws_id === wsId)
    res.json({
      canjes_activos:   canjes.filter(c => c.estado === 'disponible').length,
      pendientes:       sols.filter(s => s.estado === 'solicitado').length,
      aceptadas:        sols.filter(s => s.estado === 'aceptado').length,
      entregadas:       sols.filter(s => s.estado === 'entregado').length,
      total_canjes:     canjes.length,
      total_solicitudes: sols.length
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ══════════════════════════════════════════════════════════════
// ── SOUL CLUB ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

// Serve public Soul Club portal — solo cuando viene con ?ws= (el admin usa la misma URL via pushState)
app.get('/soul-club', (req, res) => {
  if (req.query.ws) {
    res.set('Cache-Control','no-cache,no-store,must-revalidate')
    res.sendFile(path.join(__dirname, 'views/soul-club.html'))
  } else {
    serveApp(req, res) // sin ?ws → sirve el admin SPA
  }
})

// ── Upload imagen a Supabase Storage ────────────────────────
app.post('/api/soul-club/upload', async (req, res) => {
  const { data, base64, contentType, filename } = req.body
  const imgData = data || base64
  if (!imgData || !contentType) return res.status(400).json({ error: 'Faltan datos' })
  try {
    // Crear bucket si no existe (409 = ya existe, se ignora)
    await fetch(`${SUPA_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: { apikey: SUPA_KEY(), Authorization: 'Bearer ' + SUPA_KEY(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'soul-club', name: 'soul-club', public: true })
    }).catch(() => {})

    const buffer = Buffer.from(imgData, 'base64')
    const safeName = (filename || Date.now() + '.jpg').replace(/[^a-zA-Z0-9._-]/g, '-')
    const key = `${Date.now()}-${safeName}`
    const uploadUrl = `${SUPA_URL}/storage/v1/object/soul-club/${key}`
    const r = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        apikey: SUPA_KEY(), Authorization: 'Bearer ' + SUPA_KEY(),
        'Content-Type': contentType, 'x-upsert': 'true'
      },
      body: buffer
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      return res.status(400).json({ error: 'Storage: ' + txt.slice(0, 150) })
    }
    const url = `${SUPA_URL}/storage/v1/object/public/soul-club/${key}`
    res.json({ ok: true, url })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── PUBLIC: Unirse al club (solicitud pendiente) ──────────────
app.post('/api/soul-club/join', async (req, res) => {
  const { wsId, email, nombre, wapp, instagram } = req.body
  if (!wsId || !email) return res.status(400).json({ error: 'wsId y email requeridos' })
  const emailClean = email.toLowerCase().trim()
  try {
    // Check si ya existe
    const existing = await _supa('GET', 'soul_club_miembros', {
      filter: `ws_id=eq.${wsId}&email=eq.${emailClean}`
    })
    if (existing.data?.length) {
      const m = existing.data[0]
      return res.json({ ok: true, ya_miembro: true, estado: m.estado })
    }
    const r = await _supa('POST', 'soul_club_miembros', {
      prefer: 'return=representation',
      body: { ws_id: wsId, email: emailClean, nombre: nombre?.trim() || null, wapp: wapp?.trim() || null, instagram: instagram?.trim() || null, estado: 'pendiente' }
    })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    res.json({ ok: true, estado: 'pendiente' })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── PUBLIC: Verificar estado de membresía ─────────────────────
app.get('/api/soul-club/check-member', async (req, res) => {
  const { ws, email } = req.query
  if (!ws || !email) return res.json({ estado: null })
  try {
    const r = await _supa('GET', 'soul_club_miembros', {
      filter: `ws_id=eq.${ws}&email=eq.${email.toLowerCase().trim()}`
    })
    if (!r.data?.length) return res.json({ estado: null })
    res.json({ estado: r.data[0].estado })
  } catch(e) { res.json({ estado: null }) }
})

// ── PUBLIC: Eventos ───────────────────────────────────────────
app.get('/api/soul-club/eventos', async (req, res) => {
  const { ws } = req.query
  if (!ws) return res.status(400).json({ error: 'Falta ws' })
  try {
    const r = await _supa('GET', 'soul_club_eventos', {
      filter: `ws_id=eq.${ws}&publicado=eq.true&order=fecha.asc.nullslast`
    })
    res.json(r.data || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── PUBLIC: Waitlist evento ───────────────────────────────────
app.post('/api/soul-club/eventos/:id/waitlist', async (req, res) => {
  const { id } = req.params
  const { email, nombre } = req.body
  if (!email) return res.status(400).json({ error: 'Email requerido' })
  try {
    const r = await _supa('POST', 'soul_club_waitlist_eventos', {
      prefer: 'resolution=merge-duplicates,return=representation',
      body: { evento_id: id, email: email.toLowerCase().trim(), nombre: nombre?.trim() || null }
    })
    if (!r.ok && r.status !== 409) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    if (r.status === 409) return res.json({ ok: true, ya_anotado: true })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── PUBLIC: Drops ─────────────────────────────────────────────
app.get('/api/soul-club/drops', async (req, res) => {
  const { ws } = req.query
  if (!ws) return res.status(400).json({ error: 'Falta ws' })
  try {
    const r = await _supa('GET', 'soul_club_drops', {
      filter: `ws_id=eq.${ws}&publicado=eq.true&order=fecha_drop.asc.nullslast`
    })
    res.json(r.data || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── PUBLIC: Waitlist drop ─────────────────────────────────────
app.post('/api/soul-club/drops/:id/waitlist', async (req, res) => {
  const { id } = req.params
  const { email, nombre } = req.body
  if (!email) return res.status(400).json({ error: 'Email requerido' })
  try {
    const r = await _supa('POST', 'soul_club_waitlist_drops', {
      prefer: 'resolution=merge-duplicates,return=representation',
      body: { drop_id: id, email: email.toLowerCase().trim(), nombre: nombre?.trim() || null }
    })
    if (!r.ok && r.status !== 409) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    if (r.status === 409) return res.json({ ok: true, ya_anotado: true })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── PUBLIC: Beneficios ────────────────────────────────────────
app.get('/api/soul-club/beneficios', async (req, res) => {
  const { ws } = req.query
  if (!ws) return res.status(400).json({ error: 'Falta ws' })
  try {
    const r = await _supa('GET', 'soul_club_beneficios', {
      filter: `ws_id=eq.${ws}&activo=eq.true&order=created_at.desc`
    })
    res.json(r.data || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: Solicitudes pendientes ────────────────────────────
app.get('/api/admin/soul-club/solicitudes', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('GET', 'soul_club_miembros', { filter: `ws_id=eq.${wsId}&estado=eq.pendiente&order=created_at.desc` })
    res.json(r.data || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: Aceptar / rechazar solicitud ──────────────────────
app.patch('/api/admin/soul-club/solicitudes/:id', async (req, res) => {
  const { id } = req.params
  const { accion, wsId } = req.body
  if (!accion || !wsId) return res.status(400).json({ error: 'Faltan datos' })
  const estado = accion === 'aceptar' ? 'aceptado' : 'rechazado'
  try {
    const r = await _supa('PATCH', `soul_club_miembros?id=eq.${id}&ws_id=eq.${wsId}`, { body: { estado } })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    // Get the member data
    const memR = await _supa('GET', 'soul_club_miembros', { filter: `id=eq.${id}` })
    const mem = memR.data?.[0]
    if (mem && accion === 'aceptar') {
      const ws = await getWorkspace(wsId)
      const crm = ws?.data?.crm || []
      const phone = (mem.wapp || '').replace(/\D/g, '')
      const emailClean = (mem.email || '').toLowerCase().trim()
      // Buscar contacto existente: email primero (más confiable), luego teléfono
      let idx = emailClean ? crm.findIndex(c => (c.email || '').toLowerCase().trim() === emailClean) : -1
      if (idx < 0 && phone) idx = crm.findIndex(c => (c.tel || '').replace(/\D/g,'') === phone)
      if (idx >= 0) {
        // Actualizar contacto existente: solo añadir datos, nunca pisar lo que ya tiene
        const c = crm[idx]
        c.scMiembro = true
        c.tags = Array.isArray(c.tags) ? [...new Set([...c.tags, 'soul-club'])] : ['soul-club']
        if (!c.tel && phone) c.tel = mem.wapp
        if (!c.nombre && mem.nombre) c.nombre = mem.nombre
        if (!c.instagram && mem.instagram) c.instagram = mem.instagram
      } else {
        // Crear contacto nuevo con todos los datos disponibles
        crm.push({
          id: 'sc_' + mem.id,
          nombre: mem.nombre || '',
          email: emailClean,
          tel: mem.wapp || '',
          instagram: mem.instagram || '',
          scMiembro: true,
          tags: ['soul-club'],
          origen: 'soul-club',
          etapa: 'cliente'
        })
      }
      await patchWorkspace(wsId, { crm })
    }
    res.json({ ok: true, estado })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: Miembros ───────────────────────────────────────────
app.get('/api/admin/soul-club/miembros', async (req, res) => {
  const { wsId, estado } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const filter = estado ? `ws_id=eq.${wsId}&estado=eq.${estado}&order=created_at.desc` : `ws_id=eq.${wsId}&order=created_at.desc`
    const r = await _supa('GET', 'soul_club_miembros', { filter })
    res.json(r.data || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: EVENTOS CRUD ───────────────────────────────────────
app.get('/api/admin/soul-club/eventos', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('GET', 'soul_club_eventos', { filter: `ws_id=eq.${wsId}&order=created_at.desc` })
    if (!r.ok) return res.status(r.status||500).json({ error: r.data?.message || 'Error Supabase', _supaErr: r.data })
    res.json(r.data || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/admin/soul-club/eventos', async (req, res) => {
  const { wsId, ...campos } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('POST', 'soul_club_eventos', { body: { ws_id: wsId, ...campos } })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    res.json({ ok: true, evento: r.data?.[0] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/admin/soul-club/eventos/:id', async (req, res) => {
  const { id } = req.params
  const { wsId, ...campos } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('PATCH', `soul_club_eventos?id=eq.${id}&ws_id=eq.${wsId}`, { body: campos })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    res.json({ ok: true, evento: r.data?.[0] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/admin/soul-club/eventos/:id', async (req, res) => {
  const { id } = req.params
  const { wsId } = req.query
  try {
    await _supa('DELETE', `soul_club_eventos?id=eq.${id}&ws_id=eq.${wsId}`, { prefer: 'return=minimal' })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/admin/soul-club/eventos/:id/waitlist', async (req, res) => {
  const { id } = req.params
  try {
    const r = await _supa('GET', 'soul_club_waitlist_eventos', { filter: `evento_id=eq.${id}&order=created_at.desc` })
    res.json(r.data || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: DROPS CRUD ─────────────────────────────────────────
app.get('/api/admin/soul-club/drops', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('GET', 'soul_club_drops', { filter: `ws_id=eq.${wsId}&order=created_at.desc` })
    if (!r.ok) return res.status(r.status||500).json({ error: r.data?.message || 'Error Supabase', _supaErr: r.data })
    res.json(r.data || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/admin/soul-club/drops', async (req, res) => {
  const { wsId, ...campos } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('POST', 'soul_club_drops', { body: { ws_id: wsId, ...campos } })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    res.json({ ok: true, drop: r.data?.[0] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/admin/soul-club/drops/:id', async (req, res) => {
  const { id } = req.params
  const { wsId, ...campos } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('PATCH', `soul_club_drops?id=eq.${id}&ws_id=eq.${wsId}`, { body: campos })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    res.json({ ok: true, drop: r.data?.[0] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/admin/soul-club/drops/:id', async (req, res) => {
  const { id } = req.params
  const { wsId } = req.query
  try {
    await _supa('DELETE', `soul_club_drops?id=eq.${id}&ws_id=eq.${wsId}`, { prefer: 'return=minimal' })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/admin/soul-club/drops/:id/waitlist', async (req, res) => {
  const { id } = req.params
  try {
    const r = await _supa('GET', 'soul_club_waitlist_drops', { filter: `drop_id=eq.${id}&order=created_at.desc` })
    res.json(r.data || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── ADMIN: BENEFICIOS CRUD ────────────────────────────────────
app.get('/api/admin/soul-club/beneficios', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('GET', 'soul_club_beneficios', { filter: `ws_id=eq.${wsId}&order=created_at.desc` })
    if (!r.ok) return res.status(r.status||500).json({ error: r.data?.message || 'Error Supabase', _supaErr: r.data })
    res.json(r.data || [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/admin/soul-club/beneficios', async (req, res) => {
  const { wsId, ...campos } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('POST', 'soul_club_beneficios', { body: { ws_id: wsId, ...campos } })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    res.json({ ok: true, beneficio: r.data?.[0] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/admin/soul-club/beneficios/:id', async (req, res) => {
  const { id } = req.params
  const { wsId, ...campos } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const r = await _supa('PATCH', `soul_club_beneficios?id=eq.${id}&ws_id=eq.${wsId}`, { body: campos })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    res.json({ ok: true, beneficio: r.data?.[0] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/admin/soul-club/beneficios/:id', async (req, res) => {
  const { id } = req.params
  const { wsId } = req.query
  try {
    await _supa('DELETE', `soul_club_beneficios?id=eq.${id}&ws_id=eq.${wsId}`, { prefer: 'return=minimal' })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── SOUL CANJES: Public access request ──────────────────
app.post('/api/soul-canjes/join', async (req, res) => {
  const { wsId, email, nombre, wapp, instagram } = req.body
  if (!wsId || !email) return res.status(400).json({ error: 'wsId y email requeridos' })
  const emailClean = email.toLowerCase().trim()
  try {
    const existing = await _supa('GET', 'ugc_acceso_solicitudes', { filter: `ws_id=eq.${wsId}&email=eq.${emailClean}` })
    if (existing.data?.length) return res.json({ ok: true, estado: existing.data[0].estado })
    const r = await _supa('POST', 'ugc_acceso_solicitudes', {
      prefer: 'return=representation',
      body: { ws_id: wsId, email: emailClean, nombre: nombre?.trim()||null, wapp: wapp?.trim()||null, instagram: instagram?.trim()||null, estado: 'pendiente' }
    })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    res.json({ ok: true, estado: 'pendiente' })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/soul-canjes/check', async (req, res) => {
  const { ws, email } = req.query
  if (!ws || !email) return res.json({ estado: null })
  const val = email.toLowerCase().trim()
  const cleanPhone = val.replace(/\D/g, '')
  try {
    // Check by email column first
    let r = await _supa('GET', 'ugc_acceso_solicitudes', { filter: `ws_id=eq.${ws}&email=eq.${val}` })
    // Fallback: phone-login users store their phone in the email column OR in wapp
    if (!r.data?.length && cleanPhone.length >= 7) {
      r = await _supa('GET', 'ugc_acceso_solicitudes', { filter: `ws_id=eq.${ws}&wapp=eq.${cleanPhone}` })
    }
    if (!r.data?.length) return res.json({ estado: null })
    res.json({ estado: r.data[0].estado })
  } catch(e) { res.json({ estado: null }) }
})

app.get('/api/admin/soul-canjes/solicitudes', async (req, res) => {
  const { wsId, estado } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const filter = estado && estado !== 'todas'
      ? `ws_id=eq.${wsId}&estado=eq.${estado}&order=created_at.desc`
      : `ws_id=eq.${wsId}&order=created_at.desc`
    const r = await _supa('GET', 'ugc_acceso_solicitudes', { filter })
    res.json(Array.isArray(r.data) ? r.data : [])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/admin/soul-canjes/solicitudes/:id', async (req, res) => {
  const { id } = req.params
  const { accion, wsId } = req.body
  if (!accion || !wsId) return res.status(400).json({ error: 'Faltan datos' })
  const estado = accion === 'aceptar' ? 'aceptado' : 'rechazado'
  try {
    const r = await _supa('PATCH', `ugc_acceso_solicitudes?id=eq.${id}&ws_id=eq.${wsId}`, { body: { estado } })
    if (!r.ok) return res.status(400).json({ error: JSON.stringify(r.data).slice(0,200) })
    // Si se acepta, upsert en CRM con tag soul-pr
    if (accion === 'aceptar') {
      const memR = await _supa('GET', 'ugc_acceso_solicitudes', { filter: `id=eq.${id}` })
      const mem = memR.data?.[0]
      if (mem) {
        const ws = await getWorkspace(wsId)
        const crm = ws?.data?.crm || []
        const phone = (mem.wapp || '').replace(/\D/g, '')
        const emailClean = (mem.email || '').toLowerCase().trim()
        let idx = emailClean ? crm.findIndex(c => (c.email || '').toLowerCase().trim() === emailClean) : -1
        if (idx < 0 && phone) idx = crm.findIndex(c => (c.tel || '').replace(/\D/g,'') === phone)
        if (idx >= 0) {
          const c = crm[idx]
          c.tags = Array.isArray(c.tags) ? [...new Set([...c.tags, 'soul-pr', 'ugc'])] : ['soul-pr', 'ugc']
          if (!c.tel && phone) c.tel = mem.wapp
          if (!c.nombre && mem.nombre) c.nombre = mem.nombre
          if (!c.instagram && mem.instagram) c.instagram = mem.instagram
        } else {
          crm.push({
            id: 'sc_canje_' + mem.id,
            nombre: mem.nombre || '',
            email: emailClean,
            tel: mem.wapp || '',
            instagram: mem.instagram || '',
            tags: ['soul-pr', 'ugc'],
            origen: 'soul-canjes',
            etapa: 'cliente'
          })
        }
        await patchWorkspace(wsId, { crm })
      }
    }
    res.json({ ok: true, estado })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// SPA catch-all: any unmatched GET serves the app (hash router handles client routing)
app.get('*', serveApp)

if (require.main === module) {
  app.listen(process.env.PORT || 3000, function(){
    console.log("Soul eCommlab — servidor iniciado en puerto " + (process.env.PORT || 3000))
  })
}
module.exports = app
