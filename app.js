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
const TN_STORE_ID = process.env.TN_STORE_ID || "7669167"
const TN_TOKEN    = process.env.TN_TOKEN    || "4f3f5efacbde70dc0943a7c43099753fddb04273"

app.get("/api/tn/orders", async (req, res) => {
  const { desde, hasta, page = 1 } = req.query
  try {
    const params = new URLSearchParams({
      payment_status: "paid",
      per_page: 200,
      page,
      fields: "id,number,created_at,total,currency,gateway,payment_details,customer,products"
    })
    if (desde) params.set("created_at_min", new Date(desde).toISOString())
    if (hasta) params.set("created_at_max", new Date(hasta + "T23:59:59").toISOString())

    const r = await fetch(
      `https://api.tiendanube.com/v1/${TN_STORE_ID}/orders?${params}`,
      {
        headers: {
          "Authentication": `bearer ${TN_TOKEN}`,
          "User-Agent": "VELDOS/1.0 (soporte@veldos.app)",
          "Content-Type": "application/json"
        }
      }
    )
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

if (require.main === module) {
  app.listen(process.env.PORT || 3000, function(){
    console.log("VELD OS — servidor iniciado en puerto " + (process.env.PORT || 3000))
  })
}
module.exports = app
