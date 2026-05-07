const express = require("express")
const path = require("path")
const app = express()

app.use(express.static(path.join(__dirname, "/public")))
app.use(express.json())

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
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/views/index.html")
})

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
        // Update user subscription in Supabase
        const SUPA_URL = "https://vlkxtrqktdcfqmebrtwa.supabase.co"
        const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY || ""
        const subEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        await fetch(SUPA_URL + "/rest/v1/user_subscriptions?id=eq." + pmt.external_reference, {
          method: "PATCH",
          headers: {
            "apikey": SUPA_SERVICE_KEY,
            "Authorization": "Bearer " + SUPA_SERVICE_KEY,
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
const TN_STORE_ID      = process.env.TN_STORE_ID      || "7669167"
let   TN_TOKEN         = process.env.TN_TOKEN         || "09d8ecb7e8e46f4ad9d786039462e7d0d8bc4f42"

// OAuth callback — Tiendanube redirige acá con el código de autorización
app.get("/api/tn/callback", async (req, res) => {
  const { code } = req.query
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
    if (!data.access_token) return res.send(`<h2>Error: ${JSON.stringify(data)}</h2>`)
    // Update in-memory token so the server uses it immediately
    TN_TOKEN = data.access_token
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:system-ui;max-width:600px;margin:60px auto;padding:0 24px;color:#222}
      .token{background:#f5f5f5;padding:16px;border-radius:8px;word-break:break-all;font-family:monospace;font-size:13px}
      .ok{color:#4db88a;font-size:20px;font-weight:700}
    </style></head><body>
      <div class="ok">✅ Token generado con éxito</div>
      <p>Store ID: <strong>${data.user_id}</strong></p>
      <p>Access token:</p>
      <div class="token">${data.access_token}</div>
      <p style="color:#888;font-size:13px">Copiá este token y pegalo en el chat para que lo configure en el servidor.</p>
      <p style="margin-top:24px"><a href="/">← Volver a VELDOS</a></p>
    </body></html>`)
  } catch(e) {
    res.send(`<h2>Error: ${e.message}</h2>`)
  }
})

app.get("/api/tn/orders", async (req, res) => {
  const { desde, hasta, page = 1 } = req.query
  try {
    const params = new URLSearchParams({
      payment_status: "paid",
      per_page: 200,
      page,
      fields: "id,number,created_at,total,currency,gateway,payment_details,customer,products,shipping_cost_owner,shipping_address"
    })
    if (desde) params.set("created_at_min", new Date(desde).toISOString())
    if (hasta) params.set("created_at_max", new Date(hasta + "T23:59:59").toISOString())

    const r = await fetch(
      `https://api.tiendanube.com/2025-03/${TN_STORE_ID}/orders?${params}`,
      {
        headers: {
          "Authentication": `bearer ${TN_TOKEN}`,
          "User-Agent": "VELDOS (soporte@veldos.app)"
        }
      }
    )
    if (r.status === 404) return res.json([]) // No orders in period
    if (!r.ok) {
      const txt = await r.text()
      return res.status(r.status).json({ error: txt })
    }
    const data = await r.json()
    res.json(Array.isArray(data) ? data : [])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Register TN webhook and store workspace ID
app.post("/api/tn/activate", async (req, res) => {
  const { wsId } = req.body
  if (!wsId) return res.status(400).json({ error: "wsId required" })
  try {
    // Register webhook with TN
    const r = await fetch(`https://api.tiendanube.com/2025-03/${TN_STORE_ID}/webhooks`, {
      method: "POST",
      headers: {
        "Authentication": `bearer ${TN_TOKEN}`,
        "User-Agent": "VELDOS (soporte@veldos.app)",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        event: "order/paid",
        url: (process.env.BASE_URL || "https://veldos-bjvr.vercel.app") + "/api/tn/webhook"
      })
    })
    // Store wsId in Supabase (patch the workspace data)
    const SUPA_URL = "https://vlkxtrqktdcfqmebrtwa.supabase.co"
    const SUPA_KEY = process.env.SUPA_SERVICE_KEY || ""
    // Get current workspace data
    const wsRes = await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${wsId}&select=data`, {
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY }
    })
    const wsRows = await wsRes.json()
    if (wsRows?.[0]) {
      const data = { ...(wsRows[0].data || {}), tnWebhookActive: true, tnWebhookWsId: wsId }
      await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${wsId}`, {
        method: "PATCH",
        headers: {
          "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY,
          "Content-Type": "application/json", "Prefer": "return=minimal"
        },
        body: JSON.stringify({ data })
      })
    }
    res.json({ ok: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// TN webhook — auto-import paid orders
app.post("/api/tn/webhook", async (req, res) => {
  res.sendStatus(200) // Respond immediately to TN
  const { event, id: orderId } = req.body
  if (event !== "order/paid" || !orderId) return
  try {
    // Fetch order from TN API
    const oRes = await fetch(
      `https://api.tiendanube.com/2025-03/${TN_STORE_ID}/orders/${orderId}`,
      { headers: { "Authentication": `bearer ${TN_TOKEN}`, "User-Agent": "VELDOS (soporte@veldos.app)" } }
    )
    if (!oRes.ok) return
    const o = await oRes.json()
    // Find workspace with tnWebhookActive
    const SUPA_URL = "https://vlkxtrqktdcfqmebrtwa.supabase.co"
    const SUPA_KEY = process.env.SUPA_SERVICE_KEY || ""
    const wsRes = await fetch(`${SUPA_URL}/rest/v1/workspaces?select=id,data`, {
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY }
    })
    const allWs = await wsRes.json()
    const target = (allWs || []).find(w => w.data?.tnWebhookActive)
    if (!target) return
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
    data.finanzas.push({
      tipo: "ingreso", fecha,
      concepto: `TN #${o.number} — ${cliente}`,
      categoria: "Ventas tienda",
      monto: parseFloat(o.total) || 0,
      medioPago, cuotas: 1,
      unidades: (o.products || []).reduce((a, p) => a + (p.quantity || 1), 0),
      notas: productos,
      tn_id: o.id,
      tn_envio: parseFloat(o.shipping_cost_owner || 0)
    })
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
    await fetch(`${SUPA_URL}/rest/v1/workspaces?id=eq.${target.id}`, {
      method: "PATCH",
      headers: {
        "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY,
        "Content-Type": "application/json", "Prefer": "return=minimal"
      },
      body: JSON.stringify({ data })
    })
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
