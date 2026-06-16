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

// ── GET /api/store/public — public store data for storefront
app.get('/api/store/public', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const { t } = await getTienda(wsId).then(r => r || {}).catch(() => ({}))
    if (!t) return res.status(404).json({ error: 'Tienda no encontrada' })
    res.json({
      settings:  t.settings  || {},
      productos: (t.productos || []).filter(p => p.activo !== false),
      secciones: t.secciones || [],
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

// ── POST /api/store/checkout — submit order from storefront
app.post('/api/store/checkout', async (req, res) => {
  const { wsId, items, cliente, envio } = req.body
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

    // Save order
    if (!t.ordenes) t.ordenes = []
    const numero = (t.ordenes.length || 0) + 1
    const orden = {
      id: 'o_' + Date.now().toString(36),
      numero,
      cliente,
      envio: envio || null,
      lineas,
      total,
      estado: 'pendiente',
      fecha: new Date().toISOString(),
    }
    t.ordenes.push(orden)
    await saveTienda(wsId, t, d)

    // Return transfer info from settings
    const tf = (t.settings || {}).transferencia || {}
    res.json({ ok: true, numero, nombre: cliente.nombre, total, transferencia: tf, orden })
  } catch (e) {
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

// ── PATCH /api/store/orders/:id — update order status (admin)
app.patch('/api/store/orders/:id', async (req, res) => {
  const { id } = req.params
  const { wsId, estado } = req.body
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.status(404).json({ error: 'Workspace no encontrado' })
    const { t, d } = result
    const idx = (t.ordenes || []).findIndex(o => o.id === id || String(o.numero) === String(id))
    if (idx === -1) return res.status(404).json({ error: 'Orden no encontrada' })
    t.ordenes[idx].estado = estado
    t.ordenes[idx].updatedAt = new Date().toISOString()
    await saveTienda(wsId, t, d)
    res.json({ ok: true, orden: t.ordenes[idx] })
  } catch (e) {
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
    await saveTienda(wsId, t, d)
    res.json({ ok: true })
  } catch (e) {
    res.json({ ok: true }) // silent fail for analytics
  }
})

// ── GET /api/store/analytics — summary analytics (admin)
app.get('/api/store/analytics', async (req, res) => {
  const { wsId } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.json({ eventos: [], ordenes: [], resumen: {} })
    const { t } = result
    const eventos = t.eventos || []
    const ordenes = t.ordenes || []
    const totalVentas = ordenes.reduce((s, o) => s + (o.total || 0), 0)
    res.json({
      resumen: {
        totalEventos: eventos.length,
        totalOrdenes: ordenes.length,
        totalVentas,
        visitantes: new Set(eventos.filter(e => e.sessionId).map(e => e.sessionId)).size,
      },
      ordenes: ordenes.slice(-50),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/store/analytics/events — raw events (admin)
app.get('/api/store/analytics/events', async (req, res) => {
  const { wsId, days } = req.query
  if (!wsId) return res.status(400).json({ error: 'Falta wsId' })
  try {
    const result = await getTienda(wsId)
    if (!result) return res.json({ eventos: [] })
    const { t } = result
    const all = t.eventos || []
    const since = days ? new Date(Date.now() - Number(days) * 864e5).toISOString() : null
    const filtered = since ? all.filter(e => e.ts >= since) : all
    res.json({ eventos: filtered.slice(-500) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

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
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('mp4') ? 'mp4' : 'jpg'
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
    console.log('[OTP legacy] code for', phone, ':', code)
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

