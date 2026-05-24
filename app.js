require("dotenv").config()
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

// Meta OAuth
const META_APP_ID     = () => (process.env.META_APP_ID     || "").trim()
const META_APP_SECRET = () => (process.env.META_APP_SECRET || "").trim()
const APP_BASE_URL    = () => (process.env.APP_BASE_URL    || "http://localhost:3000").trim()

// Landing page
app.get("/landing", (req, res) => {
  res.sendFile(__dirname + "/views/landing.html")
})

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
          unit_price: 39000,
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
    // Compactar payload: solo lo necesario para el cost-mapping
    const compact = all.map(p => ({
      id: p.id,
      name: typeof p.name === "object" ? (p.name.es || p.name.pt || Object.values(p.name||{})[0] || "") : (p.name || ""),
      variants: (p.variants || []).map(v => ({
        id: v.id,
        sku: v.sku || "",
        cost: v.cost != null ? Number(v.cost) : null,
        price: v.price != null ? Number(v.price) : null,
        stock: v.stock != null ? Number(v.stock) : null
      }))
    }))
    res.json(compact)
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
      "User-Agent": "Soul eCommlab (soporte@veldos.app)",
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
      { headers: { "Authentication": `bearer ${tn.token}`, "User-Agent": "Soul eCommlab (soporte@veldos.app)" } }
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

// Get a single workspace by ID (used to refresh S after OAuth callback)
app.get("/api/workspace/:wsId", async (req, res) => {
  const ws = await getWorkspace(req.params.wsId)
  if (!ws) return res.status(404).json({ error: "not found" })
  res.json({ id: ws.id, data: ws.data })
})

// ── Meta OAuth 2.0 ──────────────────────────────────────────────────────────

// Step 1 — redirect user to Facebook consent screen
app.get("/api/meta/oauth/start", (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).send("wsId requerido")
  if (!META_APP_ID()) return res.status(500).send("META_APP_ID no configurado en el servidor")
  const redirectUri = encodeURIComponent(`${APP_BASE_URL()}/api/meta/oauth/callback`)
  const scope = encodeURIComponent("ads_read,ads_management,business_management,pages_show_list")
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

    // Get their ad accounts (only proper ad accounts — numeric IDs, active status)
    const accsRes = await fetch(`https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name,account_status,currency,account_id&limit=100&access_token=${accessToken}`)
    const accsData = await accsRes.json()
    const adAccounts = (accsData.data || []).filter(a => {
      if (a.account_status !== 1) return false // only ACTIVE
      const rawId = a.account_id || (a.id || "").replace("act_", "")
      return rawId && /^\d+$/.test(rawId) // must have numeric account_id
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
app.get("/api/meta/adaccounts", async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: "wsId requerido" })
  try {
    const ws = await getWorkspace(wsId)
    const meta = ws?.data?.metaIntegration
    if (!meta?.accessToken) return res.status(400).json({ error: "Meta no conectado" })

    // Helper: filter to only proper ad accounts (must have numeric account_id or act_xxx id)
    const filterAdAccounts = (list) => (list || []).filter(a => {
      // Must be active (status 1)
      if (a.account_status !== 1) return false
      // Must have a proper ad account ID (act_xxx or numeric account_id)
      const rawId = a.account_id || (a.id || "").replace("act_", "")
      if (!rawId || !/^\d+$/.test(rawId)) return false
      return true
    })

    // Return pending accounts if already fetched (filtered)
    if (meta.pendingAdAccounts?.length) {
      return res.json({ accounts: filterAdAccounts(meta.pendingAdAccounts) })
    }
    // Fresh fetch from Meta API — only ad accounts endpoint
    const r = await fetch(`https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name,account_status,currency,account_id&limit=100&access_token=${meta.accessToken}`)
    const data = await r.json()
    if (data.error) return res.status(400).json({ error: data.error.message })
    res.json({ accounts: filterAdAccounts(data.data) })
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

// Create a new ad (creative + ad) — supports manual image or existing IG post
app.post("/api/meta/ad/create", async (req, res) => {
  const {
    wsId, adsetId, name, pageId,
    ctaType = "SHOP_NOW", status = "PAUSED", destinationUrl = "",
    creativeType = "manual",
    // Manual fields
    imageUrl = "", primaryText = "", headline = "", description = "",
    // IG post fields
    igMediaId = "", igUserId = ""
  } = req.body

  if (!wsId || !adsetId || !name || !pageId) {
    return res.status(400).json({ error: "Faltan campos requeridos: adsetId, name, pageId" })
  }
  if (creativeType === "manual" && (!imageUrl || !primaryText || !headline || !destinationUrl)) {
    return res.status(400).json({ error: "Para creativo manual: imageUrl, primaryText, headline y destinationUrl son requeridos" })
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
        ...(igUserId ? { instagram_actor_id: igUserId } : {}),
        access_token: token
      }
    } else {
      // Manual image/video creative
      creativeBody = {
        name: `${name} — creative`,
        object_story_spec: {
          page_id: pageId,
          link_data: {
            image_url: imageUrl,
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

// SPA catch-all: any unmatched GET serves the app (hash router handles client routing)
app.get('*', serveApp)

if (require.main === module) {
  app.listen(process.env.PORT || 3000, function(){
    console.log("Soul eCommlab — servidor iniciado en puerto " + (process.env.PORT || 3000))
  })
}
module.exports = app
