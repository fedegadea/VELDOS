/* ═══════════════════════════════════════════════════════════════════════
   PIPA HUEVOS PASTORILES — cobros con Mercado Pago para pipa-huevos.vercel.app
   (repo ~/pipa, Next). El sitio guarda todo en workspaces.ws_pipa (data.pipa =
   { rev, seq, cfg, clientes }) con CAS por rev; acá se lee y escribe esa misma fila.
   Usa la app de Mercado Pago que ya tiene este proyecto (env MP_ACCESS_TOKEN).

   El sitio llama a estas rutas por un rewrite propio (/api/mp/* → /api/pipa/*), así
   el navegador nunca habla con otro origen:
   - POST /api/pipa/pagar    {token}  suscripción → /preapproval semanal (cada 7 días);
                                      compra única → preferencia de Checkout Pro.
                                      Devuelve { url } para redirigir a Mercado Pago.
   - POST /api/pipa/sync     {token, payment_id?, preapproval_id?}  relee el estado en MP
                                      (vuelta del checkout).
   - POST /api/pipa/ajustar  {token}  deja la suscripción de MP igual al plan del sitio
                                      (pausa, reactivación, baja, cambio de maples).
   - POST /api/pipa/mp-webhook        avisos de MP; nunca se confía en el cuerpo:
                                      todo se relee de la API de MP.
   - GET  /api/pipa/mp-cuenta         qué cuenta de MP cobra (nickname, modo).
   Montaje: require('./pipa')(app, { SUPA_URL, SUPA_KEY })
   ═══════════════════════════════════════════════════════════════════════ */

// Monto de Mercado Pago: precio por maple (precioMapleMP, si no el de transferencia, si no 25000)
// con descuento por cantidad. descuento2Maples aplica a 2 maples; descuento3Maples desde 3.
// El porcentaje se recorta a 0..100; si falta o no es un número, es 0.
function diasCobro (c) {
  return c && c.frecuencia === 'quincenal' ? 14 : 7
}
function cadaTxt (c) {
  return diasCobro(c) === 14 ? 'cada 2 semanas' : 'por semana'
}

function montoMP (cfg, maples) {
  const c = cfg || {}
  const unitMP = c.precioMapleMP || c.precioMaple || 25000
  const n = Number(maples)
  const qty = Number.isFinite(n) ? n : 0
  const crudo = qty === 2 ? c.descuento2Maples : qty >= 3 ? c.descuento3Maples : 0
  const num = Number(crudo)
  const pct = Number.isFinite(num) ? Math.min(100, Math.max(0, num)) : 0
  return Math.round(qty * unitMP * (1 - pct / 100))
}

module.exports = function pipa (app, deps) {
  const { SUPA_URL } = deps
  const KEY = () => (typeof deps.SUPA_KEY === 'function' ? deps.SUPA_KEY() : deps.SUPA_KEY)
  const MP = () => String(process.env.MP_ACCESS_TOKEN || '').trim()
  const SITIO = () => String(process.env.PIPA_SITIO || 'https://pipa-huevos.vercel.app').replace(/\/$/, '')
  const BASE = () => String(process.env.PUBLIC_BASE_URL || 'https://soul-ecommlab.com').replace(/\/$/, '')
  const WS = 'ws_pipa'
  const H = (extra = {}) => ({ apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json', ...extra })
  const ahora = () => new Date().toISOString()
  const log = (...a) => console.log('[pipa]', ...a)

  // ── fila ws_pipa con CAS por rev ─────────────────────────────────────────
  async function leerFila () {
    const r = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${WS}&select=id,data`, { headers: H() })
    const rows = await r.json().catch(() => null)
    if (!Array.isArray(rows) || !rows[0]) throw new Error('No hay datos de Pipa')
    return rows[0].data || {}
  }
  async function leer () {
    const p = (await leerFila()).pipa || {}
    p.clientes = Array.isArray(p.clientes) ? p.clientes : []
    p.cfg = p.cfg || {}
    return p
  }
  async function mutar (fn) {
    for (let i = 0; i < 6; i++) {
      const data = await leerFila()
      const cur = data.pipa || {}
      cur.clientes = Array.isArray(cur.clientes) ? cur.clientes : []
      const rev = Number(cur.rev) || 0
      const out = await fn(cur)
      if (out === false) return cur // nada que guardar
      cur.rev = rev + 1
      const r = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${WS}&data->pipa->>rev=eq.${rev}`, {
        method: 'PATCH', headers: H({ Prefer: 'return=representation' }), body: JSON.stringify({ data: { ...data, pipa: cur } })
      })
      const res = await r.json().catch(() => [])
      if (r.ok && Array.isArray(res) && res.length) return cur
      await new Promise(ok => setTimeout(ok, 80 + Math.random() * 200))
    }
    throw new Error('Conflicto de guardado')
  }
  const porToken = (p, t) => (String(t || '').length > 10 ? p.clientes.find(c => c.token === t) : null)

  // ── Mercado Pago ─────────────────────────────────────────────────────────
  async function mp (ruta, opts = {}) {
    if (!MP()) throw new Error('Mercado Pago no está configurado')
    const r = await fetch('https://api.mercadopago.com' + ruta, {
      method: opts.method || 'GET',
      headers: { Authorization: 'Bearer ' + MP(), 'Content-Type': 'application/json', ...(opts.idem ? { 'X-Idempotency-Key': opts.idem } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(15000)
    })
    const j = await r.json().catch(() => ({}))
    // Límite momentáneo de MP: un reintento corto antes de rendirse.
    if ((r.status === 429 || /rate_limit/.test(JSON.stringify(j))) && !opts.reintento) {
      await new Promise(ok => setTimeout(ok, 1500))
      return mp(ruta, { ...opts, reintento: true })
    }
    if (!r.ok) throw new Error((j && (j.message || j.error)) || ('Mercado Pago respondió ' + r.status))
    return j
  }

  // Fechas en hora argentina, igual que lib/fechas.ts del sitio.
  const isoAR = ms => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10)
  const sumar = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10)
  const dowCliente = c => c && c.franja === 'sabado' ? 6 : c && (c.franja === 'jueves-manana' || c.franja === 'jueves-tarde') ? 4 : 3
  const diaDesde = (s, dow) => sumar(s, (dow - new Date(Date.parse(s + 'T00:00:00Z')).getUTCDay() + 7) % 7)
  /** Entrega que cubre un pago aprobado: la primera del ritmo del cliente (cada 7 o 14) que todavía no se cobró. */
  function entregaCubierta (c, cfg, fechaPagoMs) {
    const fer = cfg.feriados || []
    const paso = diasCobro(c)
    const dow = dowCliente(c)
    let w = diaDesde(isoAR(fechaPagoMs), dow)
    if (c.inicio) {
      const base = diaDesde(c.inicio, dow)
      const diff = Math.round((Date.parse(w + 'T00:00:00Z') - Date.parse(base + 'T00:00:00Z')) / 864e5)
      const resto = ((diff % paso) + paso) % paso
      if (w < base) w = base
      else if (resto) w = sumar(w, paso - resto)
    }
    for (let i = 0; i < 30; i++, w = sumar(w, paso)) {
      if (fer.includes(w) || (c.saltos || []).includes(w) || (c.inicio && w < c.inicio)) continue
      if (!(c.entregas || {})[w] || !c.entregas[w].cobrado) return w
    }
    return null
  }

  /** Registra un pago (dedupe por id) y, si está aprobado, marca cobrado el miércoles que cubre. */
  function registrarPago (p, c, pago) {
    c.pagos = Array.isArray(c.pagos) ? c.pagos : []
    const id = String(pago.id)
    const previo = c.pagos.find(x => x.id === id)
    const yaAprobado = previo && previo.estado === 'approved'
    const reg = { id, estado: pago.status, monto: Number(pago.transaction_amount) || 0, at: pago.date_approved || pago.date_created || ahora(), metodo: pago.payment_method_id || '' }
    if (previo) Object.assign(previo, reg); else c.pagos.unshift(reg)
    c.pagos = c.pagos.slice(0, 80)
    if (pago.status === 'approved' && !yaAprobado) {
      c.entregas = c.entregas || {}
      const w = c.tipo === 'unico' ? c.inicio : entregaCubierta(c, p.cfg || {}, Date.parse(reg.at) || Date.now())
      if (w) { c.entregas[w] = { ...(c.entregas[w] || {}), cobrado: true, mpPago: id }; reg.miercoles = w }
    }
    c.mp = { ...(c.mp || {}), ultimoPago: { id, estado: pago.status, at: reg.at } }
    c.actualizado = ahora()
  }

  /* Plan de suscripción semanal por monto (1 maple, 2 maples…). Se usa cuando MP rechaza
     el débito armado con el email del cliente (por ejemplo "Payer is associated with a
     different site"): con el plan, la persona entra a MP con la cuenta que quiera. */
  async function planPara (monto, maples, dias) {
    const cada = Number(dias) === 14 ? 14 : 7
    const p = await leer()
    const k = monto + 'x' + cada
    const guardado = (p.mpPlanes || {})[k]
    if (guardado && guardado.id && guardado.url) return guardado
    const n = Number(maples) || 1
    const d = await mp('/preapproval_plan', {
      method: 'POST',
      body: {
        reason: `Pipa · ${n} ${n === 1 ? 'maple' : 'maples'} de huevos pastoriles ${cada === 14 ? 'cada 2 semanas' : 'por semana'}`,
        auto_recurring: { frequency: cada, frequency_type: 'days', transaction_amount: monto, currency_id: 'ARS' },
        back_url: `${SITIO()}/mp-vuelta`
      }
    })
    const plan = { id: d.id, url: d.init_point, monto, creado: ahora() }
    await mutar(q => { q.mpPlanes = { ...(q.mpPlanes || {}), [k]: plan } })
    return plan
  }

  async function crearCobro (c, cfg) {
    const n = Number(c.maples) || 1
    const total = montoMP(cfg, n)
    const dias = diasCobro(c)
    const ritmo = cadaTxt(c)
    const back = `${SITIO()}/mi/${c.token}?mp=1`
    const titulo = `Pipa · ${n} ${n === 1 ? 'maple' : 'maples'} de huevos pastoriles`
    if (c.tipo === 'suscripcion') {
      const conPlan = async (motivo) => {
        const plan = await planPara(total, n, dias)
        if (motivo) log('suscripción por plan', c.codigo, motivo)
        return { url: plan.url, plan: true, mp: { tipo: 'plan', planId: plan.id, preapprovalId: null, estado: 'pending', monto: total, cada: dias, creado: ahora() } }
      }
      if (!c.email) return conPlan('sin email')
      let d
      try {
        d = await mp('/preapproval', {
        method: 'POST',
        idem: `pipa-${c.id}-${n}-${total}-${dias}-${Date.now()}`,
        body: {
          reason: `${titulo} ${ritmo}`,
          external_reference: c.id,
          payer_email: c.email,
          back_url: back,
          auto_recurring: { frequency: dias, frequency_type: 'days', transaction_amount: total, currency_id: 'ARS' },
          status: 'pending'
        }
        })
      } catch (e) {
        // Problemas con el pagador (otro país, mismo dueño que el vendedor, email inválido): plan sin email.
        if (/payer|site|email|collector|same user/i.test(e.message)) return conPlan(e.message)
        throw e
      }
      return { url: d.init_point, mp: { tipo: 'preapproval', preapprovalId: d.id, estado: d.status || 'pending', monto: total, cada: dias, creado: ahora() } }
    }
    const d = await mp('/checkout/preferences', {
      method: 'POST',
      body: {
        items: [{ id: 'maple', title: titulo, quantity: 1, unit_price: total, currency_id: 'ARS' }],
        external_reference: c.id,
        payer: c.email ? { email: c.email, name: c.nombre } : { name: c.nombre },
        back_urls: { success: back, pending: back, failure: back },
        auto_return: 'approved',
        notification_url: `${BASE()}/api/pipa/mp-webhook`,
        statement_descriptor: 'PIPA HUEVOS',
        // Sin efectivo (Pago Fácil / Rapipago): solo tarjeta y dinero en cuenta.
        payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
        expires: false
      }
    })
    return { url: d.init_point, mp: { tipo: 'preferencia', preferenciaId: d.id, monto: total, creado: ahora(), sinEfectivo: true } }
  }

  const publico = c => ({ pago: c.pago, mp: c.mp || null, pagos: (c.pagos || []).slice(0, 10), entregas: c.entregas || {} })

  // ── rutas ────────────────────────────────────────────────────────────────
  app.post('/api/pipa/pagar', async (req, res) => {
    try {
      const token = String((req.body || {}).token || '')
      const p = await leer()
      const c = porToken(p, token)
      if (!c) return res.status(404).json({ error: 'No encontramos tu pedido' })
      if (c.pago !== 'mp') return res.status(400).json({ error: 'Este pedido se paga por transferencia' })
      if (c.estado === 'cancelada') return res.status(400).json({ error: 'El pedido está cancelado' })
      if (c.tipo === 'suscripcion' && c.mp && c.mp.estado === 'authorized') return res.json({ ya: true })
      if (c.tipo === 'unico' && c.entregas && c.entregas[c.inicio] && c.entregas[c.inicio].cobrado) return res.json({ ya: true })
      // Reusar el cobro pendiente si es por el mismo monto (no llenar MP de cobros sin pagar).
      const monto = montoMP(p.cfg, Number(c.maples) || 1)
      const dias = diasCobro(c)
      if (c.mp && Number(c.mp.monto) === monto && (Number(c.mp.cada) || 7) === dias) {
        try {
          if (c.tipo === 'suscripcion' && c.mp.tipo === 'plan' && !c.mp.preapprovalId && c.mp.planId) {
            const plan = (p.mpPlanes || {})[monto + 'x' + dias]
            if (plan && plan.id === c.mp.planId) return res.json({ url: plan.url, plan: true })
          }
          if (c.tipo === 'suscripcion' && c.mp.preapprovalId && c.mp.estado === 'pending') {
            const d = await mp('/preapproval/' + encodeURIComponent(c.mp.preapprovalId))
            if (d.status === 'pending' && d.init_point) return res.json({ url: d.init_point })
          }
          if (c.tipo === 'unico' && c.mp.preferenciaId && c.mp.sinEfectivo) {
            const d = await mp('/checkout/preferences/' + encodeURIComponent(c.mp.preferenciaId))
            if (d.init_point) return res.json({ url: d.init_point })
          }
        } catch (e) { log('reusar cobro', e.message) }
      }
      const cobro = await crearCobro(c, p.cfg)
      await mutar(q => {
        const x = porToken(q, token); if (!x) return false
        x.mp = { ...(x.mp || {}), ...cobro.mp }
        x.actualizado = ahora()
      })
      res.json({ url: cobro.url })
    } catch (e) {
      log('pagar', e.message)
      res.status(502).json({ error: 'No pudimos abrir Mercado Pago: ' + e.message })
    }
  })

  async function syncPreapproval (token, id) {
    const d = await mp('/preapproval/' + encodeURIComponent(id))
    await mutar(q => {
      const x = token ? porToken(q, token) : q.clientes.find(y => y.id === d.external_reference || (y.mp && y.mp.preapprovalId === d.id))
      if (!x || (d.external_reference && d.external_reference !== x.id)) return false
      // Hecha por plan: solo se vincula si es del plan que le dimos y no es de otro cliente.
      if (!d.external_reference) {
        const deOtro = q.clientes.some(y => y !== x && y.mp && y.mp.preapprovalId === d.id)
        const planOk = x.mp && (x.mp.preapprovalId === d.id || (x.mp.planId && x.mp.planId === d.preapproval_plan_id))
        if (deOtro || !planOk) return false
      }
      x.mp = { ...(x.mp || {}), tipo: 'preapproval', preapprovalId: d.id, estado: d.status, monto: (d.auto_recurring || {}).transaction_amount, proximoCobro: d.next_payment_date || null, pagador: d.payer_email || (x.mp || {}).pagador }
      x.actualizado = ahora()
    })
    return d
  }
  async function syncPago (token, id, idCliente) {
    const d = await mp('/v1/payments/' + encodeURIComponent(id))
    const preId = (d.metadata && d.metadata.preapproval_id) || (d.point_of_interaction && d.point_of_interaction.transaction_data && d.point_of_interaction.transaction_data.subscription_id) || ''
    await mutar(q => {
      let x = token ? porToken(q, token) : null
      if (!x && idCliente) x = q.clientes.find(y => y.id === idCliente)
      if (!x) x = q.clientes.find(y => y.id === d.external_reference || (preId && y.mp && y.mp.preapprovalId === preId))
      if (!x) return false
      if (!idCliente && d.external_reference && d.external_reference !== x.id && !(preId && x.mp && x.mp.preapprovalId === preId)) return false
      registrarPago(q, x, d)
    })
    return d
  }

  app.post('/api/pipa/sync', async (req, res) => {
    try {
      const b = req.body || {}
      const p = await leer()
      const c = porToken(p, b.token)
      if (!c) return res.status(404).json({ error: 'No encontramos tu pedido' })
      if (b.payment_id) await syncPago(b.token, String(b.payment_id)).catch(e => log('sync pago', e.message))
      const pre = b.preapproval_id || (c.mp && c.mp.preapprovalId)
      if (pre) await syncPreapproval(b.token, String(pre)).catch(e => log('sync pre', e.message))
      const q = await leer()
      res.json(publico(porToken(q, b.token)))
    } catch (e) {
      res.status(502).json({ error: e.message })
    }
  })

  // Deja la suscripción de MP igual al plan del sitio.
  app.post('/api/pipa/ajustar', async (req, res) => {
    try {
      const token = String((req.body || {}).token || '')
      const p = await leer()
      const c = porToken(p, token)
      if (!c) return res.status(404).json({ error: 'No existe' })
      if (c.tipo !== 'suscripcion' || !c.mp || !c.mp.preapprovalId) return res.json({ ok: true, nada: true })
      const d = await mp('/preapproval/' + encodeURIComponent(c.mp.preapprovalId))
      if (d.status === 'cancelled') {
        // Una suscripción cancelada no se reabre en MP: si el plan volvió a estar activo, que pague de nuevo.
        if (c.estado === 'activa') await mutar(q => { const x = porToken(q, token); if (!x) return false; x.mp = { ...(x.mp || {}), estado: 'cancelled', preapprovalId: null, anterior: d.id } })
        return res.json({ ok: true, estado: 'cancelled' })
      }
      const monto = montoMP(p.cfg, Number(c.maples) || 1)
      const dias = diasCobro(c)
      const cambio = {}
      const quiere = c.estado === 'cancelada' ? 'cancelled' : c.estado === 'pausada' ? 'paused' : d.status === 'paused' && c.estado === 'activa' ? 'authorized' : null
      // Una pendiente (sin autorizar) solo se puede cancelar; pausar o reactivar recién cuando está autorizada.
      if (quiere && quiere !== d.status && (d.status !== 'pending' || quiere === 'cancelled')) cambio.status = quiere
      const rec = d.auto_recurring || {}
      if ((Number(rec.transaction_amount) !== monto || Number(rec.frequency) !== dias) && !cambio.status?.startsWith('cancel')) cambio.auto_recurring = { transaction_amount: monto, frequency: dias, frequency_type: 'days', currency_id: 'ARS' }
      let final = d
      if (Object.keys(cambio).length) final = await mp('/preapproval/' + encodeURIComponent(d.id), { method: 'PUT', body: cambio })
      await mutar(q => {
        const x = porToken(q, token); if (!x) return false
        x.mp = { ...(x.mp || {}), estado: final.status, monto: (final.auto_recurring || {}).transaction_amount || monto, proximoCobro: final.next_payment_date || null }
      })
      res.json({ ok: true, estado: final.status, cambio })
    } catch (e) {
      log('ajustar', e.message)
      res.status(502).json({ error: e.message })
    }
  })

  app.post('/api/pipa/mp-webhook', async (req, res) => {
    res.sendStatus(200) // MP reintenta si tardamos; procesamos igual
    try {
      const b = req.body || {}
      const tipo = String(b.type || b.topic || req.query.type || req.query.topic || '')
      const id = String((b.data && b.data.id) || req.query['data.id'] || req.query.id || '')
      if (!id) return
      if (/preapproval/.test(tipo) && !/authorized_payment/.test(tipo)) await syncPreapproval(null, id)
      else if (/authorized_payment/.test(tipo)) {
        const a = await mp('/authorized_payments/' + encodeURIComponent(id))
        if (a.payment && a.payment.id) await syncPago(null, String(a.payment.id))
        if (a.preapproval_id) await syncPreapproval(null, a.preapproval_id)
      } else if (/payment/.test(tipo)) await syncPago(null, id)
    } catch (e) {
      log('webhook', e.message)
    }
  })

  /* Relee de MP todos los cobros de Pipa. Hace falta porque los avisos de suscripciones
     van a la URL de webhook configurada en la app de MP (la usan otros módulos), no acá.
     Lo dispara el panel de Pipa al abrir; como mucho una vez por minuto. */
  let ultimoSyncTodo = 0
  app.post('/api/pipa/sync-todo', async (req, res) => {
    if (Date.now() - ultimoSyncTodo < 60e3) return res.json({ ok: true, salteado: true })
    ultimoSyncTodo = Date.now()
    const out = { pre: 0, pagos: 0, errores: 0 }
    try {
      const p = await leer()
      const viejo = Date.now() - 45 * 864e5
      const lista = p.clientes.filter(c => c.pago === 'mp' && c.mp && !(c.estado === 'cancelada' && Date.parse(c.actualizado || 0) < viejo))
      for (const c of lista.slice(0, 60)) {
        try {
          const aprobados = new Set((c.pagos || []).filter(x => x.estado === 'approved').map(x => x.id))
          if (!c.mp.preapprovalId && c.mp.planId) {
            const busca = await mp('/preapproval/search?preapproval_plan_id=' + encodeURIComponent(c.mp.planId) + '&limit=50')
            const libre = (busca.results || []).find(x => c.email && String(x.payer_email || '').toLowerCase() === c.email.toLowerCase() && !p.clientes.some(y => y.mp && y.mp.preapprovalId === x.id))
            if (libre) { await syncPreapproval(c.token, libre.id); out.pre++ }
            continue
          }
          if (c.mp.preapprovalId) {
            await syncPreapproval(null, c.mp.preapprovalId); out.pre++
            const a = await mp('/authorized_payments/search?preapproval_id=' + encodeURIComponent(c.mp.preapprovalId) + '&limit=20')
            for (const x of a.results || []) {
              const pid = x.payment && x.payment.id && String(x.payment.id)
              if (pid && !aprobados.has(pid)) { await syncPago(null, pid, c.id); out.pagos++ }
            }
          } else {
            const s = await mp('/v1/payments/search?sort=date_created&criteria=desc&limit=10&external_reference=' + encodeURIComponent(c.id))
            for (const x of s.results || []) if (!aprobados.has(String(x.id))) { await syncPago(null, String(x.id), c.id); out.pagos++ }
          }
        } catch (e) { out.errores++; log('sync-todo', c.codigo, e.message) }
      }
      res.json({ ok: true, ...out })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  app.get('/api/pipa/mp-cuenta', async (req, res) => {
    try {
      const u = await mp('/users/me')
      res.json({ ok: true, cuenta: u.nickname || '', nombre: [u.first_name, u.last_name].filter(Boolean).join(' '), pais: u.site_id, modo: MP().startsWith('TEST-') ? 'prueba' : 'real' })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })
}
module.exports.montoMP = montoMP
module.exports.diasCobro = diasCobro
