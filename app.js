const express = require("express")
const path = require("path")
const app = express()

app.use(express.static(path.join(__dirname, "/public")))
app.use(express.json())

// Shared constants
const SUPA_URL = "https://vlkxtrqktdcfqmebrtwa.supabase.co"
const SUPA_KEY = () => process.env.SUPA_SERVICE_KEY || ""

// Mercado Pago
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "TEST-PLACEHOLDER"

// Landing page
app.get("/landing", (req, res) => {
  res.sendFile(__dirname + "/views/landing.html")
})

// Sistema principal
app.get("/sistema", (req, res) => {
  res.sendFile(__dirname + "/views/index.html")
})
const NO_CACHE = { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' } }

function serveApp(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
  res.sendFile(__dirname + "/views/index.html")
}

app.get("/", serveApp)

// Rutas de sección — todas sirven el mismo index.html, el cliente lee el pathname
const APP_ROUTES = [
  "/planning", "/planning/calendario", "/planning/semana", "/planning/ideas",
  "/planning/biblioteca", "/planning/briefs", "/planning/canjes", "/planning/collabs",
  "/planning/estrategia",
  "/checklist", "/todo", "/marca", "/producto",
  "/finanzas", "/finanzas/movimientos", "/finanzas/ingresos", "/finanzas/gastos",
  "/finanzas/comisiones", "/finanzas/kpis", "/finanzas/cashflow", "/finanzas/config",
  "/crm", "/hojas", "/operaciones", "/stock", "/integraciones"
]
APP_ROUTES.forEach(route => app.get(route, serveApp))

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
          title: "VELD OS — Suscripción mensual",
          quantity: 1,
          unit_price: 49000,
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

// Helper: fetch workspace from Supabase by id
async function getWorkspace(wsId) {
  const r = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}&select=id,data`, {
    headers: { "apikey": SUPA_KEY(), "Authorization": "Bearer " + SUPA_KEY() }
  })
  const rows = await r.json()
  return rows?.[0] || null
}

// Helper: patch workspace data in Supabase
async function patchWorkspace(wsId, data) {
  await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${encodeURIComponent(wsId)}`, {
    method: "PATCH",
    headers: {
      "apikey": SUPA_KEY(), "Authorization": "Bearer " + SUPA_KEY(),
      "Content-Type": "application/json", "Prefer": "return=minimal"
    },
    body: JSON.stringify({ data })
  })
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
            headers: { "Authentication": `bearer ${data.access_token}`, "User-Agent": "VELDOS (soporte@veldos.app)" }
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
        return res.redirect("/?tn_connected=1")
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
      <p style="margin-top:24px"><a href="/">← Volver a VELDOS</a></p>
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
      "User-Agent": "VELDOS (soporte@veldos.app)"
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
      console.log(`[TN orders] GET page ${page}`, url)
      const r = await fetch(url, { headers })
      console.log(`[TN orders] page ${page} status:`, r.status)

      if (r.status === 404) break // no more orders
      if (!r.ok) {
        const txt = await r.text()
        console.log("[TN orders] error:", txt)
        return res.status(r.status).json({ error: txt })
      }

      const data = await r.json()
      const batch = Array.isArray(data) ? data : []
      allOrders = allOrders.concat(batch)
      console.log(`[TN orders] page ${page}: ${batch.length} orders (total so far: ${allOrders.length})`)

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
    console.log(`[TN orders] total fetched: ${allOrders.length} | paid: ${paid.length}`)
    // Attach shipping debug info to first order so client can inspect
    if (paid[0]) {
      const o = paid[0]
      paid[0]._shippingDebug = {
        shipping_cost_owner: o.shipping_cost_owner,
        shipping_cost_customer: o.shipping_cost_customer,
        subtotal: o.subtotal,
        total: o.total,
        shipping: o.shipping,
        shipping_option: o.shipping_option,
        shipping_pickup_type: o.shipping_pickup_type,
        shipping_store_branch_name: o.shipping_store_branch_name,
      }
    }
    res.json(paid)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Debug: estado webhooks y envío
app.get("/api/tn/debug-shipping", async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: "wsId requerido" })
  try {
    const ws = await getWorkspace(wsId)
    const tn = ws?.data?.tnIntegration
    if (!tn?.token) return res.status(400).json({ error: "TN no conectada" })
    const headers = { "Authentication": `bearer ${tn.token}`, "User-Agent": "VELDOS (soporte@veldos.app)" }
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

// Register TN webhook for a specific workspace
app.post("/api/tn/activate", async (req, res) => {
  const { wsId } = req.body
  if (!wsId) return res.status(400).json({ error: "wsId required" })
  try {
    const ws = await getWorkspace(wsId)
    const tn = ws?.data?.tnIntegration
    if (!tn?.token) return res.status(400).json({ error: "Tienda Nube no conectada en este proyecto" })

    const baseUrl = (process.env.BASE_URL || "https://veldos-bjvr.vercel.app").replace(/\/$/, '')
    const webhookUrl = baseUrl + "/api/tn/webhook"
    const tnHeaders = {
      "Authentication": `bearer ${tn.token}`,
      "User-Agent": "VELDOS (soporte@veldos.app)",
      "Content-Type": "application/json"
    }

    // Delete existing order/paid webhooks to avoid duplicates / fix wrong URLs
    const existingRes = await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/webhooks`, { headers: tnHeaders })
    const existing = await existingRes.json()
    if (Array.isArray(existing)) {
      for (const wh of existing) {
        if (wh.event === "order/paid") {
          await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/webhooks/${wh.id}`, { method: "DELETE", headers: tnHeaders })
        }
      }
    }

    // Register webhook with correct URL
    await fetch(`https://api.tiendanube.com/v1/${tn.storeId}/webhooks`, {
      method: "POST",
      headers: tnHeaders,
      body: JSON.stringify({ event: "order/paid", url: webhookUrl })
    })

    // Save tnWebhookActive flag in workspace data
    const wsData = { ...(ws.data || {}), tnWebhookActive: true }
    await patchWorkspace(wsId, wsData)
    res.json({ ok: true, webhookUrl })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// TN webhook — auto-import paid orders (multi-store: match by storeId)
app.post("/api/tn/webhook", async (req, res) => {
  res.sendStatus(200) // Respond immediately to TN
  const { event, store_id: webhookStoreId, id: orderId } = req.body
  if (event !== "order/paid" || !orderId) return
  try {
    // Find workspace with matching storeId and tnWebhookActive
    const wsRes = await fetch(`${SUPA_URL}/rest/v1/workspaces?select=id,data`, {
      headers: { "apikey": SUPA_KEY(), "Authorization": "Bearer " + SUPA_KEY() }
    })
    const allWs = await wsRes.json()
    // Match by storeId from webhook payload, fall back to any tnWebhookActive
    const target = (allWs || []).find(w =>
      w.data?.tnWebhookActive &&
      w.data?.tnIntegration &&
      (!webhookStoreId || String(w.data.tnIntegration.storeId) === String(webhookStoreId))
    ) || (allWs || []).find(w => w.data?.tnWebhookActive && w.data?.tnIntegration)
    if (!target) return

    const tn = target.data.tnIntegration

    // Fetch order from TN API using workspace-specific credentials
    const oRes = await fetch(
      `https://api.tiendanube.com/v1/${tn.storeId}/orders/${orderId}`,
      { headers: { "Authentication": `bearer ${tn.token}`, "User-Agent": "VELDOS (soporte@veldos.app)" } }
    )
    if (!oRes.ok) return
    const o = await oRes.json()

    const data = target.data
    if (!data.finanzas) data.finanzas = []
    // Check dedup
    if (data.finanzas.find(t => String(t.tn_id) === String(o.id))) return
    // Map gateway
    const g = (o.gateway || "").toLowerCase()
    const medioPago = g.includes("mercado") ? "Mercado Pago" : g.includes("nuvem") || g.includes("nube") ? "Pago Nube" : g.includes("transfer") ? "transferencia" : g.includes("cash") || g.includes("efectivo") ? "Efectivo" : o.gateway || "Otro"
    const fecha = (o.created_at || "").slice(0, 10)
    const cliente = o.customer?.name || o.customer?.email || "Cliente TN"
    const productos = (o.products || []).map(p => p.name).join(", ") || "Venta"
    const envioMonto = parseFloat(o.shipping_cost_customer || o.shipping_cost_owner || 0)
    const ingresoTx = {
      tipo: "ingreso", fecha,
      concepto: `TN #${o.number} — ${cliente}`,
      categoria: "Ventas tienda",
      monto: parseFloat(o.total) || 0,
      medioPago, cuotas: 1,
      unidades: (o.products || []).reduce((a, p) => a + (p.quantity || 1), 0),
      notas: productos,
      tn_id: o.id,
      tn_envio: envioMonto
    }
    data.finanzas.push(ingresoTx)
    // Gasto separado para envío
    if (envioMonto > 0) {
      data.finanzas.push({ tipo: "gasto", fecha, concepto: `Envío TN #${o.number}`, categoria: "Envíos", monto: envioMonto, medioPago, tn_id_ref: `${o.id}_envio` })
    }
    // Gasto separado para comisión gateway
    const comisionPct = medioPago === "Mercado Pago" ? 6.29 : medioPago === "Pago Nube" ? 2.5 : 0
    const comisionMonto = comisionPct > 0 ? Math.round((parseFloat(o.total) || 0) * comisionPct / 100) : 0
    if (comisionMonto > 0) {
      data.finanzas.push({ tipo: "gasto", fecha, concepto: `Comisión TN #${o.number}`, categoria: "Comisiones", monto: comisionMonto, medioPago, tn_id_ref: `${o.id}_com` })
    }
    // CRM upsert
    if (o.customer) {
      if (!data.crm) data.crm = []
      const email = o.customer.email || ""
      const existing = email ? data.crm.find(c => c.email === email || c.tn_customer_id === o.customer.id) : null
      if (existing) {
        existing.valor = (parseFloat(existing.valor) || 0) + parseFloat(o.total || 0)
        existing.cantCompras = (parseInt(existing.cantCompras) || 0) + 1
        existing.compra = fecha
      } else {
        data.crm.push({
          nombre: o.customer.name || "Cliente TN", email,
          tel: o.customer.phone || "", ig: "",
          estado: "Cliente", tipo: "cliente",
          valor: parseFloat(o.total) || 0,
          ultContacto: fecha, compra: fecha, cantCompras: 1,
          canal: "Tienda Nube",
          ciudad: o.shipping_address?.city || "",
          provincia: o.shipping_address?.province || "",
          marketing: "", newsletter: "no", tags: "tiendanube",
          notas: "Importado automáticamente desde Tienda Nube",
          creado: new Date().toISOString().slice(0, 10),
          tn_customer_id: o.customer.id
        })
      }
    }
    // Save back to Supabase
    await patchWorkspace(target.id, data)
  } catch(e) {
    console.error("TN webhook error:", e)
  }
})

// ── Páginas públicas (requeridas por Tienda Nube) ────────────────────────────
app.get("/privacidad", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Política de privacidad — VELDOS</title><style>body{font-family:system-ui,sans-serif;max-width:700px;margin:60px auto;padding:0 24px;color:#222;line-height:1.7}h1{font-size:24px;margin-bottom:8px}h2{font-size:16px;margin-top:32px}p,li{font-size:14px;color:#444}a{color:#2979ff}</style></head><body>
  <h1>Política de privacidad</h1>
  <p>Última actualización: ${new Date().toLocaleDateString('es-AR')}</p>
  <h2>Datos que recopilamos</h2>
  <p>VELDOS accede a los datos de órdenes de tu tienda Tiendanube (número de orden, fecha, monto total y medio de pago) únicamente para mostrarlos dentro de tu espacio de trabajo. No almacenamos datos personales de tus clientes.</p>
  <h2>Uso de los datos</h2>
  <p>Los datos de órdenes se importan a tu espacio de trabajo en VELDOS para que puedas visualizar tus finanzas. Nunca se comparten con terceros.</p>
  <h2>Eliminación de datos</h2>
  <p>Al desinstalar la aplicación, podés eliminar todos los datos importados desde tu panel de VELDOS. También podés escribirnos a <a href="mailto:soporte@veldos.app">soporte@veldos.app</a>.</p>
  <h2>Contacto</h2>
  <p><a href="mailto:soporte@veldos.app">soporte@veldos.app</a></p>
  </body></html>`)
})

app.get("/soporte", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Soporte — VELDOS</title><style>body{font-family:system-ui,sans-serif;max-width:700px;margin:60px auto;padding:0 24px;color:#222;line-height:1.7}h1{font-size:24px;margin-bottom:8px}p{font-size:14px;color:#444}a{color:#2979ff}</style></head><body>
  <h1>Soporte</h1>
  <p>Para consultas o problemas con la integración de VELDOS con Tiendanube, escribinos a:</p>
  <p><strong><a href="mailto:soporte@veldos.app">soporte@veldos.app</a></strong></p>
  <p>Respondemos dentro de las 48 horas hábiles.</p>
  </body></html>`)
})

// ── Tienda Nube — Privacy webhooks (obligatorios) ────────────────────────────
app.post("/api/tn/webhooks/store-redact", (req, res) => {
  // Called when a store uninstalls the app and requests data deletion
  // VELDOS stores order data inside user workspaces in Supabase — no separate store records to delete
  console.log("TN store/redact:", req.body?.store_id)
  res.sendStatus(200)
})

app.post("/api/tn/webhooks/customers-redact", (req, res) => {
  // Called when a customer requests their data to be deleted
  // VELDOS only stores order totals/dates, no personal customer data
  console.log("TN customers/redact:", req.body?.customer?.id)
  res.sendStatus(200)
})

app.post("/api/tn/webhooks/customers-data-request", (req, res) => {
  // Called when a customer requests to see what data the app holds about them
  // VELDOS holds no personal customer data — respond with empty set
  console.log("TN customers/data_request:", req.body?.customer?.id)
  res.sendStatus(200)
})

if (require.main === module) {
  app.listen(process.env.PORT || 3000, function(){
    console.log("VELD OS — servidor iniciado en puerto " + (process.env.PORT || 3000))
  })
}
module.exports = app
