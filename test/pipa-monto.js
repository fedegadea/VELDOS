// Verifica el monto de Mercado Pago de Pipa. No llama a la API de MP.
const assert = require('assert')
const http = require('http')
const express = require('express')
const pipa = require('../pipa')
const { montoMP } = pipa

const cfg = { precioMapleMP: 28000, descuento2Maples: 10, descuento3Maples: 15 }

assert.strictEqual(montoMP(cfg, 1), 28000)
assert.strictEqual(montoMP(cfg, 2), 50400)
assert.strictEqual(montoMP(cfg, 3), 71400)
assert.strictEqual(montoMP(cfg, 4), 95200)

assert.strictEqual(montoMP({ precioMapleMP: 28000 }, 2), 56000)
assert.strictEqual(montoMP({ precioMaple: 28000 }, 1), 28000)
assert.strictEqual(montoMP({}, 1), 25000)

assert.strictEqual(montoMP({ precioMapleMP: 28000, descuento2Maples: 150 }, 2), 0)
assert.strictEqual(montoMP({ precioMapleMP: 28000, descuento3Maples: 150 }, 3), 0)
assert.strictEqual(montoMP({ precioMapleMP: 28000, descuento2Maples: -5 }, 2), 56000)
assert.strictEqual(montoMP({ precioMapleMP: 28000, descuento3Maples: -5 }, 4), 112000)
assert.strictEqual(montoMP({ precioMapleMP: 28000, descuento2Maples: 'no' }, 2), 56000)

const token = 'tok_pipa_test_01'
const cliente = {
  id: 'cli_1',
  token,
  codigo: 'P1',
  nombre: 'Ana',
  email: 'ana@example.com',
  tipo: 'suscripcion',
  maples: 2,
  pago: 'mp',
  estado: 'activa'
}

process.env.MP_ACCESS_TOKEN = 'TEST-pipa-monto-no-real'
const calls = []
const realFetch = global.fetch
global.fetch = async (url, opts = {}) => {
  const u = String(url)
  calls.push({ url: u, method: opts.method || 'GET', body: opts.body })
  const json = (data, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data })
  if (u.includes('/rest/v1/workspaces') && (opts.method || 'GET') === 'GET') {
    return json([{ id: 'ws_pipa', data: { pipa: { rev: 1, cfg, clientes: [cliente] } } }])
  }
  if (u.includes('/rest/v1/workspaces') && opts.method === 'PATCH') return json([{ id: 'ws_pipa' }])
  if (u.includes('api.mercadopago.com/preapproval') && opts.method === 'POST') {
    return json({ id: 'pre_1', init_point: 'https://mp.test/pre', status: 'pending' })
  }
  if (u.includes('api.mercadopago.com/checkout/preferences') && opts.method === 'POST') {
    return json({ id: 'pref_1', init_point: 'https://mp.test/pref' })
  }
  if (u.includes('api.mercadopago.com/preapproval/') && (opts.method || 'GET') === 'GET') {
    return json({ id: 'pre_1', status: 'authorized', auto_recurring: { transaction_amount: 99999 } })
  }
  if (u.includes('api.mercadopago.com/preapproval/') && opts.method === 'PUT') {
    const b = JSON.parse(opts.body)
    return json({ id: 'pre_1', status: 'authorized', auto_recurring: b.auto_recurring, next_payment_date: null })
  }
  throw new Error('fetch inesperado: ' + (opts.method || 'GET') + ' ' + u)
}

function post (app, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address()
      const data = JSON.stringify(body)
      const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          server.close()
          resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') })
        })
      })
      req.on('error', err => { server.close(); reject(err) })
      req.end(data)
    })
  })
}

async function main () {
  const app = express()
  app.use(express.json())
  pipa(app, { SUPA_URL: 'https://supabase.test', SUPA_KEY: 'test-key' })

  calls.length = 0
  const sub = await post(app, '/api/pipa/pagar', { token })
  assert.strictEqual(sub.status, 200)
  const pre = calls.find(c => c.url.includes('/preapproval') && c.method === 'POST')
  assert.ok(pre, 'tiene que crear la suscripción en el mock, no en Mercado Pago')
  assert.strictEqual(JSON.parse(pre.body).auto_recurring.transaction_amount, 50400)

  cliente.tipo = 'unico'
  cliente.maples = 3
  delete cliente.mp
  calls.length = 0
  const unica = await post(app, '/api/pipa/pagar', { token })
  assert.strictEqual(unica.status, 200)
  const pref = calls.find(c => c.url.includes('/checkout/preferences') && c.method === 'POST')
  const item = JSON.parse(pref.body).items[0]
  assert.strictEqual(item.quantity, 1)
  assert.strictEqual(item.unit_price, 71400)
  assert.ok(item.title.includes('3 maples'), item.title)

  cliente.tipo = 'suscripcion'
  cliente.maples = 2
  cliente.mp = { preapprovalId: 'pre_1', estado: 'authorized' }
  calls.length = 0
  const aj = await post(app, '/api/pipa/ajustar', { token })
  assert.strictEqual(aj.status, 200)
  const put = calls.find(c => c.method === 'PUT')
  assert.strictEqual(JSON.parse(put.body).auto_recurring.transaction_amount, 50400)

  global.fetch = realFetch
  console.log('ok pipa montoMP: 1→28000 2→50400 3→71400 4→95200; sin descuento 2→56000; 150→0; -5→precio lleno')
}

main().catch(err => {
  global.fetch = realFetch
  console.error(err)
  process.exit(1)
})
