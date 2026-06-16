
// ═══════════════════════════════
// INIT
// ═══════════════════════════════
const P = new URLSearchParams(location.search)
const WS = P.get('ws') || ''

// Analytics session
const SESSION_ID = (() => {
  let id = sessionStorage.getItem('_tid_sess_' + WS)
  if (!id) { id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2); sessionStorage.setItem('_tid_sess_' + WS, id) }
  return id
})()

function trackEvent(tipo, extra = {}) {
  if (!WS) return
  const payload = { wsId: WS, tipo, sessionId: SESSION_ID, ...extra }
  if (_idUser?.whatsapp) payload.contactId = _idUser.whatsapp
  if (_idUser?.nombre) { if (!payload.metadata) payload.metadata = {}; payload.metadata.nombre = _idUser.nombre }
  // Also track in identity system
  trackWithId(tipo, extra)
  fetch('/api/store/evento', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }).catch(()=>{})
}

let settings   = {}
let productos  = []
let cart       = JSON.parse(localStorage.getItem('cart_' + WS) || '[]')
let _likes     = new Set(JSON.parse(localStorage.getItem('likes_' + WS) || '[]'))
let activeFilter = 'todos'
let searchQ    = ''
let pmProd     = null
let pmQtyVal   = 1
let pmTalla    = ''
// Identity state (replaces old loggedUser)
let _idUser  = null
let _idToken = localStorage.getItem('vlid_tok') || null
let _idRequired = false
let _idCallback = null
let _idNombre = ''
let _idWA = ''

// ═══════════════════════════════
// CARGA TIENDA
// ═══════════════════════════════
async function loadStore() {
  if (!WS) { showError('URL inválida — falta el ID de tienda'); return }
  try {
    const r = await fetch('/api/store/public?wsId=' + WS)
    if (!r.ok) throw new Error('Tienda no encontrada')
    const data = await r.json()
    settings  = data.settings || {}
    productos = data.productos || []
    applySettings()
    buildFilters()
    renderGrid()
    renderStoreSections(data.secciones || [])
    _renderFooter(data.paginas || [])
    checkRefParam()
    updateCartCount()
  } catch(e) { showError(e.message) }
}

function applySettings() {
  const s = settings
  document.title = s.nombre || 'Tienda'
  document.getElementById('hero-title').textContent = s.heroTitulo || s.nombre || 'Nueva Colección'
  document.getElementById('hero-sub').textContent = s.heroSub || ''
  document.getElementById('hero-label').textContent = s.heroLabel || 'Colección'
  document.getElementById('catalog-title').textContent = s.catalogoTitulo || 'Catálogo'
  if (s.colorPrimario) document.documentElement.style.setProperty('--accent', s.colorPrimario)

  // ── Logo ──
  const logoWrap = document.getElementById('store-logo-wrap')
  const logoPic  = document.getElementById('store-logo-pic')
  const logoImg  = document.getElementById('store-logo-img')
  const logoName = document.getElementById('store-logo-name')

  // Tamaño del logo
  const size = s.logoTamano || 'md'
  logoWrap.className = 'store-logo logo-' + size

  if (s.logoImagen) {
    // Imagen de logo subida
    logoPic.src = s.logoImagen
    logoPic.style.display = 'block'
    logoImg.style.display  = 'none'
    logoName.style.display = 'none'
  } else if (s.logoText) {
    // Texto/letra del logo
    logoPic.style.display  = 'none'
    logoImg.style.display  = 'flex'
    logoImg.textContent    = s.logoText.slice(0,2).toUpperCase()
    logoName.style.display = 'none'
  } else {
    // Fallback: nombre de la tienda como texto
    logoPic.style.display  = 'none'
    logoImg.style.display  = 'none'
    logoName.style.display = ''
    logoName.textContent   = s.nombre || 'Tienda'
  }

  if (s.heroImagen) {
    const heroImg = document.getElementById('hero-img')
    heroImg.innerHTML = `<img src="${s.heroImagen}" alt="hero">`
  }
  if (s.nombre) document.getElementById('hero-wrap').style.display = ''

  // Envío
  const costo = Number(s.costoEnvio) || 0
  const gratis = Number(s.envioGratis) || 0
  const envioLabel = document.getElementById('envio-precio-label')
  if (envioLabel) {
    if (costo === 0) envioLabel.textContent = 'Gratis'
    else if (gratis > 0) envioLabel.textContent = `$${fmt(costo)} · Gratis en compras +$${fmt(gratis)}`
    else envioLabel.textContent = `$${fmt(costo)}`
  }

  // Announce bar
  if (s.announceBar) {
    const bar = document.getElementById('announce-bar')
    if (s.announceBarColor) bar.style.background = s.announceBarColor
    if (s.announceBarTextColor) bar.style.color = s.announceBarTextColor
    // Scroll si el texto es largo
    if (s.announceBar.length > 60) {
      bar.classList.add('scrolling')
      bar.innerHTML = '<span>' + s.announceBar + ' &nbsp;&nbsp;—&nbsp;&nbsp; ' + s.announceBar + '</span>'
    } else {
      bar.classList.remove('scrolling')
      bar.textContent = s.announceBar
    }
    bar.style.display = ''
  }
}

// ═══════════════════════════════
// FILTROS Y GRID
// ═══════════════════════════════
function buildFilters() {
  const cats = [...new Set(productos.map(p => p.categoria).filter(Boolean))]
  const wrap = document.getElementById('filters-wrap')
  if (cats.length < 2) return
  const chips = ['todos', ...cats].map(c => {
    return `<button class="filter-chip ${c==='todos'?'active':''}" onclick="setFilter('${c}',this)">${c === 'todos' ? 'Todo' : c}</button>`
  }).join('')
  wrap.insertAdjacentHTML('afterbegin', chips)
  // Categorías en header nav
  const nav = document.getElementById('header-cats')
  if (cats.length <= 5) {
    nav.innerHTML = cats.map(c => `<button onclick="setFilter('${c}',null)">${c}</button>`).join('')
  }
}

function setFilter(cat, btn) {
  activeFilter = cat
  document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'))
  if (btn) btn.classList.add('active')
  renderGrid()
}

function filterProducts() {
  searchQ = (document.getElementById('search-input')?.value || '').toLowerCase()
  renderGrid()
}

function renderGrid() {
  let list = productos.filter(p => {
    if (activeFilter !== 'todos' && p.categoria !== activeFilter) return false
    if (searchQ && ![(p.nombre||''),(p.descripcion||''),(p.categoria||'')].join(' ').toLowerCase().includes(searchQ)) return false
    return true
  })
  const grid = document.getElementById('products-grid')
  document.getElementById('catalog-sub').textContent = `${list.length} producto${list.length !== 1 ? 's' : ''}`
  if (!list.length) {
    grid.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><div style="font-weight:700;color:var(--text);margin-bottom:6px">Sin resultados</div><div>Probá con otro término</div></div>`
    return
  }
  grid.innerHTML = list.map(p => {
    const img = p.imagenes?.[0]
    const canBuy = p.stock == null || p.stock > 0
    const sale = p.precioOriginal && p.precioOriginal > p.precio
    const isNew = p.nuevo === true
    return `
    <div class="prod-card" data-prod-id="${p.id}" onclick="openProduct('${p.id}')">
      <div class="prod-img-wrap" style="position:relative">
        ${img ? `<img src="${img}" alt="${p.nombre}" loading="lazy">` : `<div class="prod-img-placeholder">${p.emoji||'👗'}</div>`}
        ${sale ? `<div class="prod-tag sale">−${Math.round((1-p.precio/p.precioOriginal)*100)}%</div>` : ''}
        ${isNew && !sale ? `<div class="prod-tag nuevo">NUEVO</div>` : ''}
        ${!canBuy ? `<div class="prod-tag" style="background:var(--muted)">Agotado</div>` : ''}
        <button class="like-btn ${_likes.has(p.id)?'liked':''}" onclick="event.stopPropagation();toggleLike('${p.id}',this)" aria-label="Me gusta">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="${_likes.has(p.id)?'#ef4444':'none'}" stroke="${_likes.has(p.id)?'#ef4444':'#555'}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
        </button>
      </div>
      <div class="prod-body">
        ${p.categoria ? `<div class="prod-cat">${p.categoria}</div>` : ''}
        <div class="prod-name">${p.nombre}</div>
        <div class="prod-foot">
          <div>
            <div class="prod-price">$${fmt(p.precio)}</div>
            ${sale ? `<div class="prod-price-old">$${fmt(p.precioOriginal)}</div>` : ''}
            ${p.stock != null && p.stock <= 5 && p.stock > 0 ? `<div class="prod-stock-badge stock-low">¡Últimas ${p.stock}!</div>` : ''}
          </div>
          ${canBuy ? `<button class="prod-add-btn" onclick="event.stopPropagation();quickAdd('${p.id}')">+</button>` : ''}
        </div>
      </div>
    </div>`
  }).join('')
}

function showError(msg) {
  document.getElementById('products-grid').innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><div style="font-weight:700;color:var(--text);margin-bottom:6px">Error</div><div>${msg}</div></div>`
}

// ═══════════════════════════════
// PRODUCT MODAL
// ═══════════════════════════════
function openProductModal(id) { openProduct(id) } // alias
function openProduct(id) {
  pmProd = productos.find(p => p.id === id)
  if (!pmProd) return
  // Track product view + save last viewed
  trackEvent('view_product', { productoId: pmProd.id, productoNombre: pmProd.nombre })
  try { localStorage.setItem('last_viewed_' + WS, pmProd.id) } catch(e) {}
  pmQtyVal = 1; pmTalla = ''
  const p = pmProd
  document.getElementById('pm-cat').textContent = p.categoria || ''
  document.getElementById('pm-name').textContent = p.nombre
  document.getElementById('pm-desc').textContent = p.descripcion || ''
  document.getElementById('pm-price').textContent = '$' + fmt(p.precio)
  const priceOld = document.getElementById('pm-price-old')
  if (p.precioOriginal && p.precioOriginal > p.precio) {
    priceOld.textContent = '$' + fmt(p.precioOriginal); priceOld.style.display = ''
  } else priceOld.style.display = 'none'
  document.getElementById('pm-qty').textContent = 1
  // Imagen
  const imgWrap = document.getElementById('pm-img-wrap')
  imgWrap.innerHTML = p.imagenes?.[0]
    ? `<img src="${p.imagenes[0]}" alt="${p.nombre}">`
    : `<span style="font-size:80px">${p.emoji||'👗'}</span>`
  // Talles
  const tallasWrap = document.getElementById('pm-tallas-wrap')
  const tallasGrid = document.getElementById('pm-tallas-grid')
  if (p.talles?.length) {
    tallasGrid.innerHTML = p.talles.map(t => `<button class="talla-btn" onclick="selectTalla('${t}',this)">${t}</button>`).join('')
    tallasWrap.style.display = ''
  } else tallasWrap.style.display = 'none'
  // Stock
  const canBuy = p.stock == null || p.stock > 0
  const stockEl = document.getElementById('pm-stock-txt')
  if (p.stock == null) stockEl.textContent = ''
  else if (p.stock <= 0) stockEl.innerHTML = '<span style="color:var(--red);font-weight:700">Sin stock</span>'
  else if (p.stock <= 5) stockEl.innerHTML = `<span style="color:var(--gold);font-weight:700">¡Solo quedan ${p.stock}!</span>`
  else stockEl.innerHTML = `<span style="color:var(--green);font-weight:700">✓ En stock</span>`
  const addBtn = document.getElementById('pm-add-btn')
  addBtn.disabled = !canBuy
  addBtn.textContent = canBuy ? 'Agregar a la bolsa' : 'Sin stock'
  // Sync like state in modal
  const likeBtn = document.getElementById('pm-like-btn')
  if (likeBtn) _applyLikeState(likeBtn, _likes.has(p.id), true)
  document.getElementById('pm-overlay').classList.add('open')
  document.getElementById('pm-modal').classList.add('open')
  document.body.style.overflow = 'hidden'
}

function closePM() {
  document.getElementById('pm-overlay').classList.remove('open')
  document.getElementById('pm-modal').classList.remove('open')
  document.body.style.overflow = ''
}

function selectTalla(t, btn) {
  pmTalla = t
  document.querySelectorAll('.talla-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
}

function pmQty(delta) {
  const max = pmProd?.stock != null ? pmProd.stock : 99
  pmQtyVal = Math.max(1, Math.min(pmQtyVal + delta, max))
  document.getElementById('pm-qty').textContent = pmQtyVal
}

function pmAdd() {
  if (!pmProd) return
  if (pmProd.talles?.length && !pmTalla) { toast('Seleccioná un talle primero'); return }
  addToCart(pmProd.id, pmQtyVal, pmTalla)
  closePM()
}

function quickAdd(id) {
  const p = productos.find(x => x.id === id)
  if (!p) return
  if (p.talles?.length) { openProduct(id); return } // Necesita talle
  addToCart(id, 1, '')
}

// ═══════════════════════════════
// CART
// ═══════════════════════════════
function addToCart(id, qty, talla) {
  const p = productos.find(x => x.id === id)
  if (!p) return
  // Track add to cart
  trackEvent('add_cart', { productoId: p.id, productoNombre: p.nombre })
  const key = id + (talla ? '_' + talla : '')
  const existing = cart.find(x => x.key === key)
  if (existing) {
    existing.qty = Math.min(existing.qty + qty, p.stock != null ? p.stock : 99)
  } else {
    cart.push({ key, id: p.id, nombre: p.nombre + (talla ? ` (${talla})` : ''), precio: p.precio, qty, imagen: p.imagenes?.[0] || '', emoji: p.emoji || '👗' })
  }
  saveCart()
  toast('✅ ' + p.nombre + (talla ? ` talle ${talla}` : '') + ' agregado')
  openCart()
}

function removeFromCart(key) { cart = cart.filter(x => x.key !== key); saveCart(); renderCart() }
function updateQty(key, d) {
  const item = cart.find(x => x.key === key)
  if (!item) return
  const p = productos.find(x => x.id === item.id)
  item.qty = Math.max(1, Math.min(item.qty + d, p?.stock != null ? p.stock : 99))
  saveCart(); renderCart()
}
function saveCart() { localStorage.setItem('cart_' + WS, JSON.stringify(cart)); updateCartCount() }

// ═══════════════════════════════
// LIKES / FAVORITOS
// ═══════════════════════════════
function _saveLikes() { localStorage.setItem('likes_' + WS, JSON.stringify([..._likes])) }

function toggleLike(id, btn, isModal) {
  if (!id) return
  const liked = _likes.has(id)
  if (liked) _likes.delete(id); else _likes.add(id)
  _saveLikes()
  // Update SVG fill on the clicked button
  _applyLikeState(btn, !liked)
  // Also sync the card button on the grid
  const cardBtn = document.querySelector(`.prod-card[data-prod-id="${id}"] .like-btn`)
  if (cardBtn && cardBtn !== btn) _applyLikeState(cardBtn, !liked)
  // Sync modal like btn if open
  const modalBtn = document.getElementById('pm-like-btn')
  if (modalBtn && modalBtn !== btn) _applyLikeState(modalBtn, !liked, true)
  trackWithId(!liked ? 'like_product' : 'unlike_product', { productoId: id })
  if (!liked) toast('❤️ Guardado en favoritos')
}

function _applyLikeState(btn, liked, isModal) {
  if (!btn) return
  const svg = btn.querySelector('svg')
  if (!svg) return
  if (liked) {
    btn.classList.add('liked')
    svg.setAttribute('fill', '#ef4444')
    svg.setAttribute('stroke', '#ef4444')
    if (isModal) { const lbl = document.getElementById('pm-like-label'); if(lbl) lbl.textContent = '❤ En tus favoritos' }
  } else {
    btn.classList.remove('liked')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', '#555')
    if (isModal) { const lbl = document.getElementById('pm-like-label'); if(lbl) lbl.textContent = 'Guardar en favoritos' }
  }
}
function updateCartCount() {
  const n = cart.reduce((a, x) => a + x.qty, 0)
  const el = document.getElementById('cart-count')
  el.textContent = n; el.classList.toggle('zero', n === 0)
}
function cartSubtotal() { return cart.reduce((a, x) => a + x.precio * x.qty, 0) }
function getEnvio() {
  if (document.getElementById('opt-retiro')?.checked) return 0
  const sub = cartSubtotal()
  const costo = Number(settings.costoEnvio) || 0
  const gratis = Number(settings.envioGratis) || 0
  if (gratis > 0 && sub >= gratis) return 0
  return costo
}

function openCart() { renderCart(); document.getElementById('cart-overlay').classList.add('open'); document.getElementById('cart-drawer').classList.add('open'); document.body.style.overflow='hidden' }
function closeCart() { document.getElementById('cart-overlay').classList.remove('open'); document.getElementById('cart-drawer').classList.remove('open'); document.body.style.overflow='' }

function renderCart() {
  const list = document.getElementById('cart-items-list')
  const footer = document.getElementById('cart-footer')
  if (!cart.length) {
    list.innerHTML = `<div class="cart-empty"><div class="cart-empty-icon">🛍️</div><div style="font-weight:700;color:var(--text);margin-bottom:6px">Tu bolsa está vacía</div><div style="font-size:13px">¡Explorá el catálogo!</div></div>`
    footer.style.display = 'none'; return
  }
  list.innerHTML = cart.map(i => `
    <div class="cart-item">
      <div class="cart-item-img">${i.imagen ? `<img src="${i.imagen}" alt="">` : i.emoji}</div>
      <div class="cart-item-info">
        <div class="cart-item-name">${i.nombre}</div>
        <div class="cart-item-price">$${fmt(i.precio)} × ${i.qty} = <strong>$${fmt(i.precio*i.qty)}</strong></div>
        <div class="qty-ctrl">
          <button class="qty-btn" onclick="updateQty('${i.key}',-1)">−</button>
          <span class="qty-num">${i.qty}</span>
          <button class="qty-btn" onclick="updateQty('${i.key}',+1)">+</button>
        </div>
      </div>
      <button class="cart-item-del" onclick="removeFromCart('${i.key}')">🗑</button>
    </div>
  `).join('')
  const sub = cartSubtotal()
  const gratis = Number(settings.envioGratis) || 0
  const falta = gratis > sub ? gratis - sub : 0
  document.getElementById('cart-subtotal').textContent = '$' + fmt(sub)
  document.getElementById('cart-total').textContent = '$' + fmt(sub)
  const freeEl = document.getElementById('envio-free-badge')
  const noteEl = document.getElementById('cart-envio-note-line')
  if (gratis > 0 && sub >= gratis) { freeEl.style.display=''; noteEl.textContent='' }
  else if (falta > 0) { freeEl.style.display='none'; noteEl.textContent=`Agregá $${fmt(falta)} más y el envío es gratis 🎁` }
  else { freeEl.style.display='none'; noteEl.textContent='' }
  footer.style.display = ''
}

function goToCheckout() {
  if (!cart.length) return
  closeCart()
  if (!_idUser) {
    showAuthModal(function() {
      renderCheckoutSummary()
      trackEvent('checkout_start')
      document.getElementById('view-catalog').style.display = 'none'
      document.getElementById('view-checkout').style.display = ''
      document.getElementById('view-success').style.display = 'none'
      window.scrollTo(0,0)
    }, true)
    return
  }
  renderCheckoutSummary()
  trackEvent('checkout_start')
  document.getElementById('view-catalog').style.display = 'none'
  document.getElementById('view-checkout').style.display = ''
  document.getElementById('view-success').style.display = 'none'
  window.scrollTo(0,0)
}

function showCatalog() {
  document.getElementById('view-catalog').style.display = ''
  document.getElementById('view-checkout').style.display = 'none'
  document.getElementById('view-success').style.display = 'none'
  window.scrollTo(0,0)
}

function selectEnvio(tipo) {
  document.getElementById('opt-envio').checked = tipo === 'envio'
  document.getElementById('opt-retiro').checked = tipo === 'retiro'
  document.getElementById('opt-envio-wrap').classList.toggle('active', tipo === 'envio')
  document.getElementById('opt-retiro-wrap').classList.toggle('active', tipo === 'retiro')
  document.getElementById('dir-fields').style.display = tipo === 'envio' ? '' : 'none'
  updateCheckoutTotals()
}

function renderCheckoutSummary() {
  // Aplicar config de checkout
  const chkCfg = settings.checkout || {}
  const envioHab  = chkCfg.envioHabilitado  !== false
  const retiroHab = chkCfg.retiroHabilitado !== false
  const envioWrap  = document.getElementById('opt-envio-wrap')
  const retiroWrap = document.getElementById('opt-retiro-wrap')
  if (envioWrap)  envioWrap.style.display  = envioHab  ? '' : 'none'
  if (retiroWrap) retiroWrap.style.display = retiroHab ? '' : 'none'
  // Si solo hay retiro, seleccionarlo
  if (!envioHab && retiroHab) selectEnvio('retiro')
  else selectEnvio('envio')
  // Dirección local en retiro
  if (chkCfg.direccionLocal) {
    const retiroSpan = retiroWrap?.querySelector('span')
    if (retiroSpan) retiroSpan.textContent = 'Gratis — ' + chkCfg.direccionLocal
  }
  const el = document.getElementById('ch-summary-items')
  el.innerHTML = cart.map(i => `
    <div class="si-row">
      <span class="si-name">${i.imagen ? `<img src="${i.imagen}" style="width:28px;height:28px;border-radius:6px;object-fit:cover;vertical-align:middle;margin-right:6px">` : (i.emoji||'👗')+' '}${i.nombre} ×${i.qty}</span>
      <span class="si-val">$${fmt(i.precio*i.qty)}</span>
    </div>
  `).join('')
  // Pre-fill from identity user + show banner
  if (_idUser) {
    const f = (id, v) => { const el = document.getElementById(id); if(el && v) el.value = v }
    const parts = (_idUser.nombre || '').split(' ')
    f('ch-nombre', parts[0] || ''); f('ch-apellido', parts.slice(1).join(' ') || '')
    f('ch-email', _idUser.email); f('ch-tel', _idUser.telefono)
    // Show user banner
    const banner = document.getElementById('ch-user-banner')
    if (banner) {
      const initials = (_idUser.nombre||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()
      document.getElementById('ch-user-initials').textContent = initials
      document.getElementById('ch-user-name-display').textContent = _idUser.nombre || '—'
      document.getElementById('ch-user-tel-display').textContent = _idUser.telefono ? '+' + _idUser.telefono : (_idUser.email || '—')
      banner.style.display = 'flex'
    }
  }
  updateCheckoutTotals()
}

function updateCheckoutTotals() {
  const sub = cartSubtotal()
  const envio = getEnvio()
  const total = sub + envio
  document.getElementById('ch-total').textContent = '$' + fmt(total)
  const noteEl = document.getElementById('ch-envio-note')
  if (noteEl) noteEl.textContent = envio === 0 && document.getElementById('opt-envio')?.checked && Number(settings.envioGratis) > 0 ? '✅ Envío gratis' : envio > 0 ? `+ Envío: $${fmt(envio)}` : ''
  // Actualizar label de precio en la opción de envío
  const priceLabel = document.getElementById('envio-precio-label')
  if (priceLabel) {
    const costo = Number(settings.costoEnvio) || 0
    const gratis = Number(settings.envioGratis) || 0
    if (costo === 0) priceLabel.textContent = 'Gratis'
    else if (gratis > 0 && sub >= gratis) priceLabel.textContent = '✅ Envío gratis'
    else priceLabel.textContent = '$' + fmt(costo)
  }
}

// ═══════════════════════════════
// CHECKOUT
// ═══════════════════════════════
async function submitCheckout() {
  const nombre = document.getElementById('ch-nombre')?.value?.trim()
  const tel    = document.getElementById('ch-tel')?.value?.trim()
  const email  = document.getElementById('ch-email')?.value?.trim()
  const errEl  = document.getElementById('ch-error')

  if (!nombre) { errEl.textContent = 'El nombre es obligatorio'; errEl.style.display=''; return }
  if (!tel && !email) { errEl.textContent = 'Ingresá tu WhatsApp o email'; errEl.style.display=''; return }
  errEl.style.display = 'none'

  const envioTipo = document.getElementById('opt-retiro')?.checked ? 'retiro' : 'envio'
  const envio = getEnvio()
  const cliente = {
    nombre, apellido: document.getElementById('ch-apellido')?.value?.trim() || '',
    email, tel, envioTipo,
    referralCode: document.getElementById('ch-referral')?.value?.trim().toUpperCase() || '',
    direccion: envioTipo === 'envio' ? {
      calle: document.getElementById('ch-dir')?.value || '',
      ciudad: document.getElementById('ch-ciudad')?.value || '',
      provincia: document.getElementById('ch-prov')?.value || ''
    } : null
  }

  const btn = document.getElementById('ch-submit')
  btn.disabled = true; btn.textContent = 'Procesando...'

  try {
    const r = await fetch('/api/store/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsId: WS, items: cart.map(i => ({ id: i.id, cantidad: i.qty })), cliente, envio })
    })
    const data = await r.json()
    if (!data.ok) throw new Error(data.error || 'Error al procesar')
    // Track checkout complete
    trackEvent('checkout_complete', { metadata: { total: data.total, nombre: cliente.nombre } })
    // Limpiar carrito
    cart = []; saveCart()
    showTransferSuccess(data)
  } catch(e) {
    errEl.textContent = e.message; errEl.style.display=''
    btn.disabled=false; btn.textContent='Confirmar pedido →'
  }
}

function showTransferSuccess(data) {
  document.getElementById('view-catalog').style.display = 'none'
  document.getElementById('view-checkout').style.display = 'none'
  document.getElementById('view-success').style.display = ''
  document.getElementById('success-num').textContent = '#' + data.numero
  document.getElementById('success-nombre').textContent = data.nombre || ''
  document.getElementById('transfer-total-val').textContent = '$' + fmt(data.total)
  // Datos de transferencia
  const tf = data.transferencia || {}
  const fieldsEl = document.getElementById('transfer-fields')
  const rows = []
  if (tf.titular) rows.push(['Titular', tf.titular, false])
  if (tf.banco)   rows.push(['Banco', tf.banco, false])
  if (tf.cbu)     rows.push(['CBU', tf.cbu, true])
  if (tf.alias)   rows.push(['Alias', tf.alias, true])
  if (tf.cuit)    rows.push(['CUIT', tf.cuit, false])
  if (!rows.length) {
    fieldsEl.innerHTML = '<div style="font-size:13px;color:#92400e">Te enviamos los datos de transferencia por WhatsApp/email.</div>'
  } else {
    fieldsEl.innerHTML = rows.map(([label, value, copyable]) => `
      <div class="transfer-row">
        <span class="transfer-label">${label}</span>
        <span class="transfer-value">
          <span>${value}</span>
          ${copyable ? `<button class="copy-btn" onclick="copyText('${value}','${label} copiado')">Copiar</button>` : ''}
        </span>
      </div>
    `).join('')
  }
  // Link WA con monto
  const waNum = (settings.whatsapp || '').replace(/\D/g,'')
  const waLink = document.getElementById('wa-comprobante-link')
  const msgWA = `Hola! Acabo de hacer el pedido #${data.numero} por $${fmt(data.total)}. Te mando el comprobante de la transferencia 🧾`
  waLink.href = waNum ? `https://wa.me/${waNum}?text=${encodeURIComponent(msgWA)}` : '#'
  waLink.style.display = waNum ? '' : 'none'
  window.scrollTo(0,0)
}

function copyText(text, msg) {
  navigator.clipboard.writeText(text).then(() => toast('📋 ' + msg)).catch(() => prompt('Copiá:', text))
}

// ═══════════════════════════════
// OTP CHECKOUT
// ═══════════════════════════════
async function sendOTP() {
  const tel = document.getElementById('otp-tel')?.value?.trim()
  if (!tel) return
  const btn = document.getElementById('otp-send-btn')
  btn.disabled=true; btn.textContent='Enviando...'
  try {
    await fetch('/api/store/otp/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ wsId:WS, tel }) })
    document.getElementById('otp-code-row').style.display=''
    btn.textContent='Reenviar'
  } catch(e) { toast('Error al enviar') }
  btn.disabled=false
}
async function verifyOTP() {
  const tel = document.getElementById('otp-tel')?.value?.trim()
  const code = document.getElementById('otp-code')?.value?.trim()
  try {
    const r = await fetch('/api/store/otp/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ wsId:WS, tel, code }) })
    const d = await r.json()
    if (!d.ok) { toast('Código incorrecto'); return }
    document.getElementById('otp-ok').style.display=''
    document.getElementById('otp-code-row').style.display='none'
    if (d.contact) {
      loggedUser = d.contact
      const f = (id,v) => { const el=document.getElementById(id); if(el&&v) el.value=v }
      f('ch-nombre',d.contact.nombre); f('ch-apellido',d.contact.apellido)
      f('ch-email',d.contact.email); f('ch-tel',d.contact.tel)
    }
  } catch(e) { toast('Error al verificar') }
}

// ═══════════════════════════════
// IDENTITY SYSTEM
// ═══════════════════════════════
async function initIdentity() {
  if (!_idToken || !WS) return
  try {
    const r = await fetch('/api/identity/me?wsId=' + WS, { headers: { 'Authorization': 'Bearer ' + _idToken } })
    if (!r.ok) { localStorage.removeItem('vlid_tok'); _idToken = null; return }
    const d = await r.json()
    if (d.ok && d.user) { _idUser = d.user; _updateLoginBtn() }
  } catch(e) {}
}

function _updateLoginBtn() {
  const btn = document.getElementById('login-btn')
  if (!btn) return
  if (_idUser) {
    const initials = (_idUser.nombre || '').split(' ').map(function(w){return w[0]}).join('').slice(0,2).toUpperCase() || '?'
    const nivelEmoji = _idUser.nivelEmoji || '👋'
    const nivelNombre = _idUser.nivel || 'Visitante'
    btn.innerHTML = '<span style="width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;margin-right:6px">' + initials + '</span>' + ((_idUser.nombre || '').split(' ')[0] || 'Mi cuenta')
    btn.onclick = openProfilePanel
  } else {
    btn.textContent = 'Mi cuenta'
    btn.onclick = function(){ showAuthModal() }
  }
}

function openProfilePanel() {
  if (!_idUser) return
  // Populate panel
  const u = _idUser
  const initials = (u.nombre || '?').split(' ').map(function(w){return w[0]}).join('').slice(0,2).toUpperCase() || '?'
  const av = document.getElementById('prof-avatar')
  if (av) av.textContent = initials
  const pn = document.getElementById('prof-name')
  if (pn) pn.textContent = u.nombre || 'Sin nombre'
  const pt = document.getElementById('prof-tel')
  if (pt) pt.textContent = u.telefono ? '+' + u.telefono : (u.email || '—')
  const plb = document.getElementById('prof-level-badge')
  if (plb) plb.textContent = (u.nivelEmoji || '👋') + ' ' + (u.nivel || 'Visitante')
  // XP bar
  const xp = u.xp || 0
  const minXp = u.nivelMinXp || 0
  const nextXp = u.nivelNextXp
  const pct = nextXp ? Math.min(100, Math.round(((xp - minXp) / (nextXp - minXp)) * 100)) : 100
  const xpBar = document.getElementById('prof-xp-bar')
  if (xpBar) xpBar.style.width = pct + '%'
  const xpText = document.getElementById('prof-xp-text')
  if (xpText) xpText.textContent = xp + ' XP'
  const nextText = document.getElementById('prof-next-text')
  if (nextText) nextText.textContent = nextXp ? (nextXp - xp) + ' XP para el siguiente nivel' : '¡Nivel máximo! 👑'
  const nivAct = document.getElementById('prof-nivel-actual')
  if (nivAct) nivAct.textContent = (u.nivelEmoji || '') + ' ' + (u.nivel || 'Visitante')
  const NIVELES = ['Visitante','Explorador','Conocedor','Miembro','VIP']
  const idx = NIVELES.indexOf(u.nivel || 'Visitante')
  const nivNext = document.getElementById('prof-nivel-next')
  if (nivNext) nivNext.textContent = idx < NIVELES.length - 1 ? NIVELES[idx + 1] : ''
  // Badges
  const badges = u.badges || []
  const bg = document.getElementById('prof-badges-grid')
  if (bg) bg.innerHTML = badges.length ? badges.map(function(b){ return '<span class="prof-badge-chip">' + b.emoji + ' ' + b.label + '</span>' }).join('') : '<span style="font-size:12px;color:var(--muted)">Seguí explorando para desbloquear logros ✨</span>'
  // Cargar pedidos del usuario
  _loadMyOrders()
  // Open
  document.getElementById('prof-overlay').classList.add('open')
  document.body.style.overflow = 'hidden'
}

function closeProfilePanel() {
  document.getElementById('prof-overlay').classList.remove('open')
  document.body.style.overflow = ''
}

function logoutIdentity() {
  _idUser = null
  _idToken = null
  localStorage.removeItem('vlid_tok')
  _updateLoginBtn()
  closeProfilePanel()
  toast('Sesión cerrada')
}

// ── Mis pedidos ──────────────────────────────────────
async function _loadMyOrders() {
  if (!_idUser || !WS) return
  const phone = _idUser.telefono || ''
  const el = document.getElementById('prof-orders-list')
  if (!el) return
  try {
    const r = await fetch('/api/store/orders/mine?wsId=' + WS + '&tel=' + encodeURIComponent(phone))
    const d = await r.json()
    const orders = d.ordenes || []
    if (!orders.length) { el.innerHTML = '<div style="font-size:12px;color:var(--muted)">Aún no tenés pedidos 😊</div>'; return }
    el.innerHTML = orders.slice().reverse().slice(0, 5).map(function(o) {
      const fecha = o.fecha ? new Date(o.fecha).toLocaleDateString('es-AR', { day:'numeric', month:'short' }) : ''
      const st = o.estado || 'pendiente'
      return '<div class="prof-order-card">'
        + '<div class="prof-order-num">Pedido #' + o.numero + ' <span style="font-weight:400;color:var(--muted)">' + fecha + '</span></div>'
        + '<div style="margin-top:4px"><span class="prof-order-status ' + st + '">' + st + '</span></div>'
        + '<div style="margin-top:8px;font-size:12px;color:var(--muted)">' + (o.lineas||[]).map(function(l){ return l.nombre + ' ×' + l.cantidad }).join(', ') + '</div>'
        + '<div style="margin-top:6px;font-size:13px;font-weight:700">$' + fmt(o.total) + '</div>'
        + '</div>'
    }).join('')
  } catch(e) { el.innerHTML = '<div style="font-size:12px;color:var(--muted)">No se pudieron cargar los pedidos</div>' }
}

// ── Autogestión (cambio/devolución) ────────────────
var _ssOrderId = null
function openSelfService() {
  if (!_idUser) return
  document.getElementById('ss-step-select').style.display = ''
  document.getElementById('ss-step-form').style.display = 'none'
  document.getElementById('ss-step-done').style.display = 'none'
  _loadSSOrders()
  document.getElementById('ss-overlay').classList.add('open')
}
function closeSelfService() {
  document.getElementById('ss-overlay').classList.remove('open')
}
async function _loadSSOrders() {
  const phone = _idUser ? _idUser.telefono || '' : ''
  const el = document.getElementById('ss-orders-list')
  if (!el) return
  try {
    const r = await fetch('/api/store/orders/mine?wsId=' + WS + '&tel=' + encodeURIComponent(phone))
    const d = await r.json()
    const orders = (d.ordenes || []).filter(function(o){ return o.estado !== 'cancelado' })
    if (!orders.length) { el.innerHTML = '<div style="font-size:13px;color:var(--muted)">No tenés pedidos para gestionar.</div>'; return }
    el.innerHTML = orders.slice().reverse().map(function(o) {
      const fecha = o.fecha ? new Date(o.fecha).toLocaleDateString('es-AR', { day:'numeric', month:'short' }) : ''
      return '<div onclick="_selectSSOrder(\'' + o.id + '\',\'#' + o.numero + ' — ' + fecha + '\')" style="padding:14px;border:1.5px solid var(--border);border-radius:12px;cursor:pointer;margin-bottom:8px;transition:border-color .15s" onmouseover="this.style.borderColor=\'var(--accent)\'" onmouseout="this.style.borderColor=\'var(--border)\'">'
        + '<div style="font-weight:700;font-size:13px">Pedido #' + o.numero + ' <span style="font-weight:400;color:var(--muted);font-size:12px">' + fecha + '</span></div>'
        + '<div style="font-size:12px;color:var(--muted);margin-top:3px">' + (o.lineas||[]).map(function(l){ return l.nombre }).join(', ') + '</div>'
        + '</div>'
    }).join('')
  } catch(e) { el.innerHTML = '<div style="font-size:13px;color:var(--muted)">Error cargando pedidos</div>' }
}
function _selectSSOrder(orderId, label) {
  _ssOrderId = orderId
  document.getElementById('ss-form-order-label').textContent = 'Pedido ' + label
  document.getElementById('ss-step-select').style.display = 'none'
  document.getElementById('ss-step-form').style.display = ''
  document.getElementById('ss-motivo').value = ''
  document.getElementById('ss-form-err').style.display = 'none'
}
async function submitSelfService() {
  const motivo = document.getElementById('ss-motivo').value.trim()
  const tipo = document.getElementById('ss-tipo').value
  const errEl = document.getElementById('ss-form-err')
  if (!motivo) { errEl.textContent = 'Por favor describí el motivo'; errEl.style.display = ''; return }
  const btn = document.getElementById('ss-submit-btn')
  btn.disabled = true; btn.textContent = 'Enviando...'
  try {
    const r = await fetch('/api/store/returns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wsId: WS, orderId: _ssOrderId, tipo, motivo, telefono: _idUser.telefono, nombre: _idUser.nombre, email: _idUser.email })
    })
    const d = await r.json()
    if (!d.ok) throw new Error(d.error || 'Error')
    document.getElementById('ss-step-form').style.display = 'none'
    document.getElementById('ss-step-done').style.display = ''
  } catch(e) { errEl.textContent = 'Error al enviar. Intentá de nuevo.'; errEl.style.display = '' }
  btn.disabled = false; btn.textContent = 'Enviar solicitud →'
}

// ── Páginas ─────────────────────────────────────────
var _storePaginas = []
function openPageModal(slug) {
  const page = _storePaginas.find(function(p){ return p.slug === slug })
  if (!page) return
  document.getElementById('page-modal-title').textContent = page.titulo
  document.getElementById('page-modal-body').innerHTML = (page.contenido || '').replace(/\n/g, '<br>')
  document.getElementById('page-overlay').classList.add('open')
}
function closePageModal() {
  document.getElementById('page-overlay').classList.remove('open')
}
function _renderFooter(paginas) {
  _storePaginas = (paginas || []).filter(function(p){ return p.activo !== false })
  if (!_storePaginas.length) return
  const footer = document.getElementById('store-footer')
  const links = document.getElementById('footer-links')
  const brand = document.getElementById('footer-brand')
  if (!footer || !links) return
  links.innerHTML = _storePaginas.map(function(p) {
    return '<button onclick="openPageModal(\'' + p.slug + '\')" style="background:none;border:none;font-size:12px;color:var(--muted);cursor:pointer;padding:4px 8px;border-radius:6px;transition:color .15s" onmouseover="this.style.color=\'var(--accent)\'" onmouseout="this.style.color=\'var(--muted)\'">' + p.titulo + '</button>'
  }).join('')
  if (settings.nombre) brand.textContent = '© ' + settings.nombre
  footer.style.display = ''
}

function _showWelcomeBack() {
  if (!_idUser) return
  const nombre = (_idUser.nombre || '').split(' ')[0]
  const nivel = _idUser.nivel || 'Visitante'
  const nivelEmoji = _idUser.nivelEmoji || '👋'
  const isNew = !_idUser.historial || _idUser.historial.filter(function(e){ return e.evento === 'page_view' }).length <= 1
  const msg = isNew
    ? '¡Bienvenida! 🌟 Explorá el catálogo'
    : '¡Bienvenida de vuelta' + (nombre ? ', ' + nombre : '') + '! ' + nivelEmoji
  toast(msg, 3500)
}

function _maybeShowLastViewed() {
  const lastId = localStorage.getItem('last_viewed_' + WS)
  if (!lastId || !productos.length) return
  const p = productos.find(function(x){ return x.id === lastId })
  if (!p) return
  const banner = document.createElement('div')
  banner.style.cssText = 'position:fixed;bottom:80px;left:16px;right:16px;max-width:340px;margin:0 auto;background:var(--bg,#fff);border:1.5px solid rgba(37,99,235,.25);border-radius:16px;padding:12px 16px;box-shadow:0 8px 30px rgba(0,0,0,.15);z-index:300;display:flex;align-items:center;gap:12px;animation:tpIn .2s ease'
  const img = p.imagen ? '<img src="' + p.imagen + '" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0">' : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(37,99,235,.1);flex-shrink:0"></div>'
  banner.innerHTML = img + '<div style="min-width:0;flex:1"><div style="font-size:11px;color:var(--accent,#2563eb);font-weight:700;margin-bottom:2px">Seguí donde lo dejaste</div><div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + p.nombre + '</div></div><button onclick="openProductModal(\'' + p.id + '\');this.closest(\'div\').remove()" style="background:var(--accent,#2563eb);color:#fff;border:none;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0">Ver</button><button onclick="this.closest(\'div\').remove()" style="position:absolute;top:8px;right:8px;background:none;border:none;font-size:16px;cursor:pointer;color:var(--muted,#999);padding:2px 6px">×</button>'
  banner.style.position = 'fixed'
  document.body.appendChild(banner)
  setTimeout(function(){ banner.remove() }, 8000)
}

function showAuthModal(cb, required) {
  _idCallback = cb || null
  _idRequired = !!required
  if (_idUser) { if (cb) cb(_idUser); return }
  _goToIdStep(0)
  document.getElementById('id-overlay').classList.add('open')
}

function hideAuthModal() {
  document.getElementById('id-overlay').classList.remove('open')
  _idRequired = false
}

function _goToIdStep(n) {
  document.querySelectorAll('.id-step').forEach(function(el,i){ el.classList.toggle('active', i===n) })
  document.querySelectorAll('.id-dot').forEach(function(el,i){ el.classList.toggle('active', i<=n && n<4) })
  document.getElementById('id-back-btn').style.display = (n>0 && n<4) ? '' : 'none'
  var inputs = ['id-nombre','id-wa','id-email','otp-0']
  if (inputs[n]) setTimeout(function(){ var el=document.getElementById(inputs[n]); if(el) el.focus() }, 120)
  var errEl = document.getElementById('id-err-' + n)
  if (errEl) { errEl.textContent=''; errEl.style.display='none' }
}

function idBack() {
  var current = -1
  document.querySelectorAll('.id-step').forEach(function(el,i){ if(el.classList.contains('active')) current=i })
  if (current > 0 && current < 4) _goToIdStep(current - 1)
}

async function idNext(step, skip) {
  if (step === 0) {
    var val = document.getElementById('id-nombre')?.value?.trim()
    if (!val) { _showIdErr(0, 'Ingresá tu nombre'); return }
    _idNombre = val
    _goToIdStep(1)
  } else if (step === 1) {
    var raw = document.getElementById('id-wa')?.value?.trim() || ''
    var phone = raw.replace(/\D/g, '')
    if (phone.length < 8) { _showIdErr(1, 'Ingresá un número válido'); return }
    _idWA = phone
    var btn = document.getElementById('id-wa-btn')
    btn.disabled=true; btn.textContent='Enviando...'
    try {
      var r = await fetch('/api/identity/request-otp', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ wsId:WS, telefono:_idWA, nombre:_idNombre, utm:_getUTM() })
      })
      var d = await r.json()
      if (d.bypass && d.token) {
        // Sin OTP: login directo
        _idUser  = d.user
        _idToken = d.token
        localStorage.setItem('vlid_tok', d.token)
        _updateLoginBtn()
        if (_idCallback) {
          // Hay callback (ej: checkout) → cerrar modal y continuar
          hideAuthModal()
          var cb = _idCallback; _idCallback = null; cb(_idUser)
        } else {
          document.getElementById('id-welcome-msg').textContent = '¡Hola, ' + ((_idUser.nombre||'').split(' ')[0]||'!') + '! 👋'
          _goToIdStep(4)
        }
        trackWithId('identity_created', {})
        setTimeout(function(){ _showWelcomeBack() }, 800)
      } else {
        _goToIdStep(2)
      }
    } catch(e) { _showIdErr(1, 'Error al enviar. Intentá de nuevo') }
    btn.disabled=false; btn.textContent='Enviar código →'
  } else if (step === 2) {
    var email = skip ? '' : (document.getElementById('id-email')?.value?.trim() || '')
    if (!skip && email && !/\S+@\S+\.\S+/.test(email)) { _showIdErr(2, 'Email inválido'); return }
    window._idEmail = email
    document.getElementById('id-otp-sub').textContent = 'Ingresá el código que te enviamos al +' + _idWA
    // Re-send OTP now with email included
    fetch('/api/identity/request-otp', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ wsId:WS, telefono:_idWA, nombre:_idNombre, email:email, utm:_getUTM() })
    }).catch(function(){})
    _goToIdStep(3)
  }
}

async function idVerify() {
  var code = ''
  for (var i=0;i<6;i++) { code += (document.getElementById('otp-'+i)?.value || '') }
  if (code.length < 6) { _showIdErr(3, 'Ingresá los 6 dígitos'); return }
  var btn = document.getElementById('id-verify-btn')
  btn.disabled=true; btn.textContent='Verificando...'
  try {
    var r = await fetch('/api/identity/verify-otp', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ wsId:WS, telefono:_idWA, codigo:code })
    })
    var d = await r.json()
    if (!d.ok) { _showIdErr(3, d.error || 'Código incorrecto'); btn.disabled=false; btn.textContent='Verificar →'; return }
    _idUser  = d.user
    _idToken = d.token
    localStorage.setItem('vlid_tok', d.token)
    _updateLoginBtn()
    document.getElementById('id-welcome-msg').textContent = '¡Hola, ' + ((_idUser.nombre||'').split(' ')[0]) + '! 👋'
    _goToIdStep(4)
    if (_idCallback) { _idCallback(_idUser); _idCallback = null }
    trackWithId('identity_created', {})
    setTimeout(function(){ _showWelcomeBack() }, 800)
  } catch(e) { _showIdErr(3, 'Error de red. Intentá de nuevo') }
  btn.disabled=false; btn.textContent='Verificar →'
}

function otpIn(input, idx) {
  input.value = input.value.replace(/\D/g,'').slice(-1)
  if (input.value && idx < 5) document.getElementById('otp-' + (idx+1))?.focus()
  if (idx === 5 && input.value) idVerify()
}

function otpKey(event, idx) {
  if (event.key === 'Backspace' && !event.target.value && idx > 0) document.getElementById('otp-' + (idx-1))?.focus()
  if (event.key === 'Enter') idVerify()
}

async function idResend() {
  await fetch('/api/identity/request-otp', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ wsId:WS, telefono:_idWA, nombre:_idNombre, email:window._idEmail||'', utm:_getUTM() })
  }).catch(function(){})
  toast('Código reenviado ✓')
  for (var i=0;i<6;i++) { var el=document.getElementById('otp-'+i); if(el) el.value='' }
  document.getElementById('otp-0')?.focus()
}

function _showIdErr(step, msg) {
  var el = document.getElementById('id-err-' + step)
  if (!el) return
  el.textContent = msg; el.style.display = ''
}

function _getUTM() {
  var P2 = new URLSearchParams(location.search)
  return { source: P2.get('utm_source')||P2.get('ref')||'', medium: P2.get('utm_medium')||'', campaign: P2.get('utm_campaign')||'', ref: P2.get('ref')||'' }
}

function trackWithId(evento, datos) {
  if (!WS || !_idToken) return
  fetch('/api/identity/track', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+_idToken},
    body: JSON.stringify({ wsId:WS, evento:evento, datos:datos||{} })
  }).catch(function(){})
}

// ═══════════════════════════════
// REFERRAL
// ═══════════════════════════════
function checkRefParam() {
  const ref = P.get('ref')
  if (!ref) return
  toast('🎁 Código de referido aplicado: ' + ref.toUpperCase(), 3000)
  const inp = document.getElementById('ch-referral')
  if (inp) inp.value = ref.toUpperCase()
}

// ═══════════════════════════════
// UTILS
// ═══════════════════════════════
function fmt(n) { return Number(n||0).toLocaleString('es-AR',{maximumFractionDigits:0}) }
function toast(msg, ms=2500) {
  const t = document.getElementById('toast')
  t.textContent=msg; t.classList.add('show')
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'), ms)
}

// ═══════════════════════════════
// SECTION RENDERER
// ═══════════════════════════════
let _storeSecciones = []
const _carState = {}

function renderStoreSections(secciones) {
  _storeSecciones = secciones || []
  const mainEl = document.getElementById('sections-main')
  const defEl  = document.getElementById('default-layout')
  const isPreview = P.get('preview') === '1'

  if (!_storeSecciones.length) {
    if (mainEl) mainEl.style.display = 'none'
    if (defEl)  defEl.style.display  = ''
    return
  }
  if (defEl)  defEl.style.display  = 'none'
  if (mainEl) {
    mainEl.style.display = ''
    mainEl.innerHTML = _storeSecciones
      .filter(s => s.visible !== false)
      .map((s, i) => {
        const c = s.config || {}
        // Padding: explicit 0 must be written as "0px" — use hasOwnProperty-style check
        const hasPT = c.paddingTop != null && c.paddingTop !== ''
        const hasPB = c.paddingBottom != null && c.paddingBottom !== ''
        const hasPH = c.paddingH != null && c.paddingH !== ''
        const ws = [
          c.fontFamily ? `font-family:'${c.fontFamily}',sans-serif` : '',
          c.colorFondo ? `background:${c.colorFondo}` : '',
          hasPT ? `padding-top:${c.paddingTop}px` : '',
          hasPB ? `padding-bottom:${c.paddingBottom}px` : '',
          hasPH ? `padding-left:${c.paddingH}px;padding-right:${c.paddingH}px` : '',
          c.borderRadius ? `border-radius:${c.borderRadius}px;overflow:hidden` : '',
          'position:relative',
          isPreview ? 'cursor:pointer' : ''
        ].filter(Boolean).join(';')
        const colorTag = (c.colorTitulo || c.colorTexto) ? `<style>
          [data-sec-idx="${i}"] h1,[data-sec-idx="${i}"] h2,[data-sec-idx="${i}"] h3{${c.colorTitulo ? 'color:'+c.colorTitulo+'!important;' : ''}${c.fontFamily ? "font-family:'"+c.fontFamily+"',sans-serif!important;" : ''}}
          [data-sec-idx="${i}"] p,[data-sec-idx="${i}"] em,[data-sec-idx="${i}"] .sec-body{${c.colorTexto ? 'color:'+c.colorTexto+'!important;' : ''}}
        </style>` : ''
        const click = isPreview ? `onclick="selSec(${i})"` : ''
        return `<div data-sec-idx="${i}" ${click} style="${ws}">${colorTag}${buildSectionHTML(s, i)}</div>`
      }).join('')
    // Start carousels
    setTimeout(() => {
      _storeSecciones.filter(s => s.tipo === 'carousel' && s.config?.autoplay).forEach(s => {
        const interval = s.config.interval || 4000
        const id = 'car_' + s.id
        if (document.getElementById(id + '_track')) setInterval(() => carMove(id, 1), interval)
      })
    }, 500)
  }
}

function buildSectionHTML(s, i) {
  const c = s.config || {}
  const fmt2 = n => Number(n||0).toLocaleString('es-AR', {maximumFractionDigits:0})
  // Ratio efectivo: ratioLibre sobreescribe los ratios específicos de cada sección
  const R = r => c.ratioLibre || r

  switch(s.tipo) {
    case 'hero': return `
      <div style="position:relative;min-height:${c.altoMin||'72vh'};display:flex;align-items:center;justify-content:${c.alineacion==='right'?'flex-end':c.alineacion==='left'?'flex-start':'center'};overflow:hidden;border-radius:16px;margin-bottom:48px;background:#111">
        ${c.imagen?`<img src="${c.imagen}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block">`:c.video?`<video src="${c.video}" autoplay muted loop playsinline style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`:''}
        <div style="position:absolute;inset:0;background:rgba(0,0,0,${c.overlay||0.35})"></div>
        <div style="position:relative;z-index:1;text-align:${c.alineacion||'center'};padding:56px 40px;color:#fff;max-width:720px">
          <h1 style="font-size:clamp(30px,5.5vw,60px);font-weight:800;letter-spacing:-.05em;line-height:1.02;margin-bottom:18px">${c.titulo||''}</h1>
          <p style="font-size:clamp(15px,2vw,20px);opacity:.82;margin-bottom:32px;font-weight:300;line-height:1.55">${c.subtitulo||''}</p>
          ${c.ctaTexto?`<button onclick="document.getElementById('catalogo-anchor')?.scrollIntoView({behavior:'smooth'})" style="background:#fff;color:#000;border:none;padding:16px 36px;border-radius:50px;font-size:15px;font-weight:700;cursor:pointer;transition:opacity .2s" onmouseover="this.style.opacity='.88'" onmouseout="this.style.opacity='1'">${c.ctaTexto}</button>`:''}
        </div>
      </div>`

    case 'productos': {
      const prods = productos.filter(p => {
        if (c.filtro === 'destacados') return p.tags?.includes('destacado')
        if (c.filtro === 'nuevos') return p.tags?.includes('nuevo')
        if (c.filtro === 'sale') return p.precioOriginal && p.precioOriginal > p.precio
        return true
      }).slice(0, c.cantidad || 8)
      const cols = c.columnas || 4
      return `
      <div style="margin-bottom:48px" id="catalogo-anchor">
        ${c.titulo?`<div style="text-align:center;margin-bottom:28px"><h2 style="font-size:clamp(22px,3vw,32px);font-weight:800;letter-spacing:-.04em">${c.titulo}</h2></div>`:''}
        <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:16px">
          ${prods.map(p => buildProdCard(p)).join('')}
        </div>
      </div>`
    }

    case 'carousel': {
      const slides = c.slides || []
      const id = 'car_' + s.id
      const ratio = R(c.ratio || '16/9')
      return slides.length ? `
      <div style="position:relative;margin-bottom:48px" id="${id}">
        <div style="overflow:hidden;border-radius:16px">
          <div id="${id}_track" style="display:flex;transition:transform .48s cubic-bezier(.25,.46,.45,.94)">
            ${slides.map(sl => `
              <div style="min-width:100%;position:relative;flex-shrink:0">
                ${sl.imagen?`<img src="${sl.imagen}" alt="${sl.titulo||''}" style="width:100%;display:block;object-fit:cover;aspect-ratio:${ratio}">`:
                  sl.video?`<video src="${sl.video}" style="width:100%;display:block;object-fit:cover;aspect-ratio:${ratio}" autoplay muted loop playsinline></video>`:
                  `<div style="aspect-ratio:${ratio};background:#222;display:flex;align-items:center;justify-content:center;color:#555;font-size:14px">Slide</div>`}
                ${sl.titulo||sl.ctaTexto?`<div style="position:absolute;bottom:0;left:0;right:0;padding:40px 36px;background:linear-gradient(transparent,rgba(0,0,0,.58));color:#fff">
                  <h2 style="font-size:clamp(22px,3.5vw,40px);font-weight:800;letter-spacing:-.04em;margin-bottom:8px">${sl.titulo||''}</h2>
                  <p style="font-size:16px;opacity:.8;margin-bottom:18px">${sl.subtitulo||''}</p>
                  ${sl.ctaTexto&&sl.ctaLink?`<a href="${sl.ctaLink}" style="display:inline-block;background:#fff;color:#000;padding:12px 28px;border-radius:50px;font-size:14px;font-weight:700;text-decoration:none">${sl.ctaTexto}</a>`:''}
                </div>`:''}
              </div>`).join('')}
          </div>
        </div>
        ${slides.length>1?`
        <button onclick="carMove('${id}',-1)" style="position:absolute;top:50%;left:14px;transform:translateY(-50%);background:rgba(255,255,255,.92);border:none;border-radius:50%;width:44px;height:44px;font-size:20px;cursor:pointer;z-index:2;display:flex;align-items:center;justify-content:center">‹</button>
        <button onclick="carMove('${id}',1)" style="position:absolute;top:50%;right:14px;transform:translateY(-50%);background:rgba(255,255,255,.92);border:none;border-radius:50%;width:44px;height:44px;font-size:20px;cursor:pointer;z-index:2;display:flex;align-items:center;justify-content:center">›</button>
        <div style="position:absolute;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:7px;z-index:2" id="${id}_dots">
          ${slides.map((_,j)=>`<div onclick="carGoTo('${id}',${j})" id="${id}_dot_${j}" style="width:8px;height:8px;border-radius:50%;background:${j===0?'#fff':'rgba(255,255,255,.45)'};cursor:pointer;transition:background .2s"></div>`).join('')}
        </div>`:''}
      </div>` : ''
    }

    case 'banner': return `
      <div style="position:relative;border-radius:16px;overflow:hidden;margin-bottom:48px;${c.link?'cursor:pointer':''}" ${c.link?`onclick="location.href='${c.link}'"`:''}>
        ${c.imagen?`<img src="${c.imagen}" alt="${c.titulo||''}" style="width:100%;display:block;object-fit:cover;${c.alturaImg?'height:'+c.alturaImg+'px':''}">`:`<div style="height:340px;background:#e8e8e8;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:14px">Sin imagen</div>`}
        ${c.titulo||c.cta?`<div style="position:absolute;bottom:0;left:0;right:0;padding:36px 40px;background:linear-gradient(transparent,rgba(0,0,0,${c.overlay||0.45}));color:#fff">
          <h3 style="font-size:clamp(18px,3vw,30px);font-weight:800;letter-spacing:-.04em;margin-bottom:8px">${c.titulo||''}</h3>
          ${c.cta?`<span style="display:inline-block;background:#fff;color:#000;padding:9px 22px;border-radius:50px;font-size:13px;font-weight:700;margin-top:6px">${c.cta}</span>`:''}
        </div>`:''}
      </div>`

    case 'banner_doble': {
      const panels = c.paneles||[{},{}]
      const ratio = R(c.ratio || '3/4')
      return `
      <div class="sec-banner-dbl" style="display:grid;grid-template-columns:1fr 1fr;gap:${c.gap||12}px;margin-bottom:48px">
        ${panels.map(p=>`
          <div style="position:relative;border-radius:14px;overflow:hidden;${p.link?'cursor:pointer':''}" ${p.link?`onclick="location.href='${p.link}'"`:''}>
            ${p.imagen?`<img src="${p.imagen}" alt="${p.titulo||''}" style="width:100%;display:block;object-fit:cover;aspect-ratio:${ratio}">`:`<div style="aspect-ratio:${ratio};background:#e8e8e8;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:13px">Sin imagen</div>`}
            <div style="position:absolute;bottom:0;left:0;right:0;padding:22px 20px;background:linear-gradient(transparent,rgba(0,0,0,.52));color:#fff">
              <h3 style="font-size:18px;font-weight:800;letter-spacing:-.03em;margin-bottom:3px">${p.titulo||''}</h3>
              ${p.cta?`<span style="font-size:12px;font-weight:600;opacity:.85">${p.cta} →</span>`:''}
            </div>
          </div>`).join('')}
      </div>`
    }

    case 'texto': return `
      <div style="margin-bottom:48px;padding:${c.padding||'40px 20px'};text-align:${c.alineacion||'center'};background:${c.colorFondo||'transparent'};border-radius:${c.colorFondo?'16px':'0'}">
        <div style="max-width:700px;margin:0 auto;font-size:${c.fontSize||16}px;color:var(--text);line-height:1.8;font-weight:${c.fontWeight||300}">${(c.contenido||'').replace(/\n/g,'<br>')}</div>
      </div>`

    case 'galeria': {
      const imgs = c.imagenes || []
      const cols = c.columnas || 3
      const ratio = R(c.ratio || '1/1')
      return imgs.length ? `
      <div style="margin-bottom:48px">
        ${c.titulo?`<h2 style="font-size:26px;font-weight:800;text-align:center;margin-bottom:22px;letter-spacing:-.04em">${c.titulo}</h2>`:''}
        <div class="sec-galeria-grid" style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:${c.gap||6}px">
          ${imgs.map(img=>`<div style="overflow:hidden;border-radius:${c.radius||8}px"><img src="${img}" alt="" style="width:100%;aspect-ratio:${ratio};object-fit:cover;display:block;transition:transform .35s" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'"></div>`).join('')}
        </div>
      </div>` : ''
    }

    case 'testimonios': {
      const items = c.items || []
      return items.length ? `
      <div style="margin-bottom:48px;padding:${c.padding||'48px 0'}">
        ${c.titulo?`<h2 style="font-size:28px;font-weight:800;text-align:center;margin-bottom:32px;letter-spacing:-.04em">${c.titulo}</h2>`:''}
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px">
          ${items.map(t=>`
            <div style="background:var(--s1);border:1px solid var(--border);border-radius:16px;padding:24px;display:flex;flex-direction:column">
              <div style="color:#f59e0b;font-size:15px;margin-bottom:12px;letter-spacing:1px">${'★'.repeat(Math.min(5,t.estrellas||5))}</div>
              <p style="font-size:14px;color:var(--text);line-height:1.7;margin-bottom:16px;font-style:italic;flex:1">"${t.texto||''}"</p>
              <div style="display:flex;align-items:center;gap:10px;margin-top:auto">
                ${t.foto
                  ? `<img src="${t.foto}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;border:2px solid var(--border)">`
                  : `<div style="width:40px;height:40px;border-radius:50%;background:var(--s2);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">👤</div>`}
                <div>
                  <div style="font-size:13px;font-weight:700">${t.nombre||''}</div>
                  ${t.cargo?`<div style="font-size:11px;color:var(--muted);margin-top:1px">${t.cargo}</div>`:''}
                </div>
              </div>
            </div>`).join('')}
        </div>
      </div>` : ''
    }

    case 'newsletter': return `
      <div style="margin-bottom:48px;padding:56px 24px;text-align:center;background:${c.colorFondo||'var(--s1)'};border:1px solid var(--border);border-radius:20px">
        <h2 style="font-size:28px;font-weight:800;letter-spacing:-.04em;margin-bottom:10px">${c.titulo||'Suscribite'}</h2>
        <p style="font-size:15px;color:var(--muted);margin-bottom:26px;max-width:440px;margin-left:auto;margin-right:auto">${c.subtitulo||''}</p>
        <div style="display:flex;gap:8px;max-width:400px;margin:0 auto">
          <input type="email" placeholder="${c.placeholder||'Tu email'}" style="flex:1;padding:13px 18px;border:1.5px solid var(--border);border-radius:50px;font-size:14px;font-family:inherit;outline:none;background:var(--bg)">
          <button onclick="toast('✅ ¡Gracias por suscribirte!')" style="background:${c.colorBoton||'var(--accent)'};color:#fff;border:none;padding:13px 22px;border-radius:50px;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap">${c.ctaTexto||'Suscribirme'}</button>
        </div>
      </div>`

    case 'video': {
      const url = c.url || ''
      if (!url) return ''
      let embed = url
      let isFile = false

      if (url.includes('youtube.com/watch')) {
        try { embed='https://www.youtube.com/embed/'+new URL(url).searchParams.get('v')+(c.autoplay?'?autoplay=1&mute=1':'') } catch(e){}
      } else if (url.includes('youtu.be/')) {
        embed='https://www.youtube.com/embed/'+(url.split('youtu.be/')[1]?.split('?')[0])+(c.autoplay?'?autoplay=1&mute=1':'')
      } else if (url.includes('vimeo.com/')) {
        const vid = url.split('vimeo.com/')[1]?.split('?')[0]
        embed='https://player.vimeo.com/video/'+vid+(c.autoplay?'?autoplay=1&muted=1':'')
      } else if (url.includes('instagram.com/reel/') || url.includes('instagram.com/p/')) {
        // Instagram Reel o Post embed
        const match = url.match(/instagram\.com\/(reel|p)\/([A-Za-z0-9_-]+)/)
        if (match) embed = 'https://www.instagram.com/'+match[1]+'/'+match[2]+'/embed/'
      } else if (url.match(/\.(mp4|webm|mov|m4v)(\?|$)/i) || url.includes('supabase.co/storage')) {
        isFile = true
      }

      return `
      <div style="margin-bottom:48px;border-radius:16px;overflow:hidden;aspect-ratio:${R(c.ratio||'16/9')}">
        ${isFile
          ? `<video src="${url}" style="width:100%;height:100%;object-fit:cover" controls ${c.autoplay?'autoplay':''} ${c.muted||c.autoplay?'muted':''}></video>`
          : `<iframe src="${embed}" style="width:100%;height:100%;border:none" allow="autoplay;encrypted-media;fullscreen" allowfullscreen loading="lazy"></iframe>`}
      </div>`
    }

    case 'combo': {
      const p1 = productos.find(p => p.id === c.producto1)
      const p2 = productos.find(p => p.id === c.producto2)
      if (!p1 || !p2) return `<div style="padding:40px 24px;text-align:center;color:var(--muted);font-size:13px">✦ Configurá los dos productos del combo en el panel</div>`
      const desc = Number(c.descuento||0)
      const precioBase = (Number(p1.precio)||0) + (Number(p2.precio)||0)
      const precioCombo = Math.round(precioBase * (1 - desc/100))
      const ahorro = precioBase - precioCombo
      return `
      <div style="padding:56px 24px;max-width:860px;margin:0 auto;text-align:center">
        ${c.titulo ? `<h2 style="font-size:32px;font-weight:800;letter-spacing:-.05em;margin-bottom:8px">${c.titulo}</h2>` : ''}
        ${desc ? `<p style="color:var(--muted);font-size:14px;margin-bottom:40px">Llevá los dos y ahorrás un <strong>${desc}%</strong></p>` : '<div style="margin-bottom:40px"></div>'}
        <div style="display:grid;grid-template-columns:1fr 60px 1fr;gap:12px;align-items:center;margin-bottom:36px">
          ${_comboProdCard(p1)}
          <div style="font-size:36px;font-weight:200;color:var(--muted)">+</div>
          ${_comboProdCard(p2)}
        </div>
        <div style="margin-bottom:28px">
          ${ahorro>0 ? `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(52,199,123,.12);color:#16a34a;font-size:13px;font-weight:700;padding:5px 18px;border-radius:20px;margin-bottom:12px">🎉 Ahorrás $${fmt(ahorro)}</div>` : ''}
          <div style="display:flex;align-items:baseline;justify-content:center;gap:14px">
            ${ahorro>0 ? `<span style="font-size:17px;color:var(--muted);text-decoration:line-through">$${fmt(precioBase)}</span>` : ''}
            <span style="font-size:40px;font-weight:900;letter-spacing:-.04em">$${fmt(precioCombo)}</span>
          </div>
        </div>
        <button onclick="addComboToCart('${c.producto1}','${c.producto2}',${desc})" style="background:var(--accent);color:#fff;border:none;border-radius:50px;padding:17px 44px;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer;letter-spacing:-.01em;transition:all .2s" onmouseover="this.style.opacity='.85';this.style.transform='translateY(-2px)'" onmouseout="this.style.opacity='1';this.style.transform=''">${c.ctaTexto||'¡Llevame el combo!'}</button>
      </div>`
    }

    case 'shoppable': {
      if (!c.imagen) return ''
      const sId = 'sh_' + (s.id||i)
      const pts = c.touchPoints || []
      const dotsHtml = pts.map(function(tp, ti) {
        if (!tp.producto1) return ''
        const p1 = productos.find(function(p){ return p.id === tp.producto1 })
        if (!p1) return ''
        const isCombo = tp.tipo === 'combo' && tp.producto2
        const p2 = isCombo ? productos.find(function(p){ return p.id === tp.producto2 }) : null
        const pid = sId + '_tp' + ti
        // Positioning transforms based on quadrant
        const tx = tp.x < 25 ? '0%' : tp.x > 75 ? '-100%' : '-50%'
        const ty = tp.y > 55 ? 'calc(-100% - 20px)' : '20px'
        const price1 = Number(p1.precio||0)
        const price2 = p2 ? Number(p2.precio||0) : 0
        const desc = Number(tp.descuento||0)
        const comboTotal = price1 + price2
        const comboPrice = Math.round(comboTotal * (1 - desc/100))
        const ahorro = comboTotal - comboPrice

        let popupBody = ''
        if (isCombo && p2) {
          const img1 = p1.imagenes && p1.imagenes[0] ? '<img src="'+p1.imagenes[0]+'" alt="'+p1.nombre+'">' : '<div class="tp-combo-ph">'+(p1.emoji||'👗')+'</div>'
          const img2 = p2.imagenes && p2.imagenes[0] ? '<img src="'+p2.imagenes[0]+'" alt="'+p2.nombre+'">' : '<div class="tp-combo-ph">'+(p2.emoji||'👗')+'</div>'
          popupBody = '<div class="tp-combo-imgs">' + img1 + img2 + '</div>'
            + (tp.titulo ? '<div class="tp-prod-name">'+tp.titulo+'</div>' : '<div class="tp-prod-name">' + p1.nombre + ' + ' + p2.nombre + '</div>')
            + (ahorro>0 ? '<div class="tp-badge-saving">🎉 Ahorrás $'+fmt(ahorro)+'</div>' : '')
            + '<div class="tp-prod-price">$'+fmt(comboPrice)+(ahorro>0?'<s>$'+fmt(comboTotal)+'</s>':'')+'</div>'
            + '<button class="tp-add-btn" onclick="event.stopPropagation();addComboToCart(\''+tp.producto1+'\',\''+tp.producto2+'\','+desc+')">'+(tp.ctaTexto||'Agregar el look →')+'</button>'
        } else {
          const img = p1.imagenes && p1.imagenes[0]
          popupBody = (img ? '<img class="tp-prod-img" src="'+img+'" alt="'+p1.nombre+'">' : '<div class="tp-prod-ph">'+(p1.emoji||'👗')+'</div>')
            + (p1.categoria ? '<div class="tp-prod-cat">'+p1.categoria+'</div>' : '')
            + '<div class="tp-prod-name">'+p1.nombre+'</div>'
            + '<div class="tp-prod-price">$'+fmt(p1.precio)+(p1.precioOriginal&&p1.precioOriginal>p1.precio?'<s>$'+fmt(p1.precioOriginal)+'</s>':'')+'</div>'
            + '<button class="tp-add-btn" onclick="event.stopPropagation();addToCart(\''+p1.id+'\',1,\'\')">'+(tp.ctaTexto||'Agregar →')+'</button>'
            + '<button class="tp-detail-btn" onclick="event.stopPropagation();_closeAllTP();openProduct(\''+p1.id+'\')">Ver detalles</button>'
        }

        const dotIcon = isCombo
          ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>'
          : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'

        return '<button class="tp-dot" style="left:'+tp.x+'%;top:'+tp.y+'%" onclick="event.stopPropagation();_toggleTP(\''+pid+'\',this)" aria-label="Ver producto">'+dotIcon+'</button>'
          + '<div class="tp-popup" id="'+pid+'" style="left:'+tp.x+'%;top:'+tp.y+'%;transform:translate('+tx+','+ty+')" onclick="event.stopPropagation()">'
          + '<button class="tp-close" onclick="event.stopPropagation();_closeAllTP()">✕</button>'
          + popupBody
          + '</div>'
      }).join('')

      return '<div style="margin-bottom:48px">'
        + (c.titulo ? '<div style="text-align:center;margin-bottom:28px"><h2 style="font-size:clamp(22px,3vw,32px);font-weight:800;letter-spacing:-.04em">'+c.titulo+'</h2></div>' : '')
        + '<div class="shoppable-wrap" id="'+sId+'" onclick="_closeAllTP()">'
        + '<img src="'+c.imagen+'" alt="'+(c.titulo||'Look')+'">'
        + dotsHtml
        + '</div></div>'
    }

    case 'separador': return `<div style="height:${c.altura||40}px;${c.color?'background:'+c.color:''}"></div>`
    case 'espaciado': return `<div style="height:${c.altura||24}px"></div>`

    default: return `<div style="padding:20px;border:1px dashed #ddd;border-radius:10px;text-align:center;color:#aaa;margin-bottom:20px">Sección: ${s.tipo}</div>`
  }
}

function buildProdCard(p) {
  const sale = p.precioOriginal && p.precioOriginal > p.precio
  const fmt2 = n => Number(n||0).toLocaleString('es-AR',{maximumFractionDigits:0})
  return `
    <div onclick="openProduct('${p.id}')" style="cursor:pointer;background:var(--s1);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:all .2s" onmouseover="this.style.boxShadow='0 8px 24px rgba(0,0,0,.12)';this.style.transform='translateY(-2px)'" onmouseout="this.style.boxShadow='';this.style.transform=''">
      <div style="aspect-ratio:3/4;background:#f0f0f0;overflow:hidden;position:relative">
        ${p.imagenes?.[0]?`<img src="${p.imagenes[0]}" alt="${p.nombre}" style="width:100%;height:100%;object-fit:cover;transition:transform .35s" onmouseover="this.style.transform='scale(1.04)'" onmouseout="this.style.transform='scale(1)'">`:`<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:52px">${p.emoji||'👗'}</div>`}
        ${sale?`<div style="position:absolute;top:10px;left:10px;background:#ef4444;color:#fff;font-size:9px;font-weight:800;padding:3px 9px;border-radius:20px;letter-spacing:.06em">SALE</div>`:''}
        ${p.tags?.includes('nuevo')?`<div style="position:absolute;top:10px;right:10px;background:#000;color:#fff;font-size:9px;font-weight:800;padding:3px 9px;border-radius:20px;letter-spacing:.06em">NUEVO</div>`:''}
        ${p.stock===0?`<div style="position:absolute;inset:0;background:rgba(255,255,255,.65);display:flex;align-items:center;justify-content:center"><span style="font-size:12px;font-weight:700;color:#888;border:1.5px solid #ddd;padding:6px 16px;border-radius:20px">Agotado</span></div>`:''}
      </div>
      <div style="padding:12px 14px">
        ${p.categoria?`<div style="font-size:10px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">${p.categoria}</div>`:''}
        <div style="font-size:13px;font-weight:600;line-height:1.3;margin-bottom:6px">${p.nombre}</div>
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="font-size:15px;font-weight:700">$${fmt2(p.precio)}</span>
          ${sale?`<span style="font-size:11px;color:var(--muted);text-decoration:line-through">$${fmt2(p.precioOriginal)}</span>`:''}
        </div>
      </div>
    </div>`
}

function _comboProdCard(p) {
  const fmt2 = n => Number(n||0).toLocaleString('es-AR',{maximumFractionDigits:0})
  return `<div style="background:var(--s1);border:1px solid var(--border);border-radius:16px;overflow:hidden;text-align:left">
    <div style="aspect-ratio:3/4;background:var(--s2);overflow:hidden;position:relative">
      ${p.imagenes?.[0] ? `<img src="${p.imagenes[0]}" alt="${p.nombre}" style="width:100%;height:100%;object-fit:cover">` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:52px">${p.emoji||'👗'}</div>`}
    </div>
    <div style="padding:14px 16px">
      ${p.categoria?`<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:4px">${p.categoria}</div>`:''}
      <div style="font-size:13px;font-weight:700;line-height:1.3;margin-bottom:6px">${p.nombre}</div>
      <div style="font-size:15px;font-weight:800">$${fmt2(p.precio)}</div>
    </div>
  </div>`
}

function addComboToCart(id1, id2, descuento) {
  const p1 = productos.find(x => x.id === id1)
  const p2 = productos.find(x => x.id === id2)
  if (!p1 || !p2) { toast('❌ Productos no encontrados'); return }
  const d = Number(descuento||0)/100
  const key1 = id1 + '_combo'
  const key2 = id2 + '_combo'
  const precio1 = Math.round((p1.precio||0)*(1-d))
  const precio2 = Math.round((p2.precio||0)*(1-d))
  const ex1 = cart.find(x=>x.key===key1)
  const ex2 = cart.find(x=>x.key===key2)
  if (ex1) ex1.qty = Math.min(ex1.qty+1, p1.stock!=null?p1.stock:99)
  else cart.push({ key:key1, id:p1.id, nombre:p1.nombre+' (combo)', precio:precio1, qty:1, imagen:p1.imagenes?.[0]||'', emoji:p1.emoji||'👗' })
  if (ex2) ex2.qty = Math.min(ex2.qty+1, p2.stock!=null?p2.stock:99)
  else cart.push({ key:key2, id:p2.id, nombre:p2.nombre+' (combo)', precio:precio2, qty:1, imagen:p2.imagenes?.[0]||'', emoji:p2.emoji||'👗' })
  saveCart()
  trackEvent('combo_add', { productos:[id1,id2], descuento })
  toast(`🛍 Combo agregado${descuento>0?' — ahorrás '+descuento+'%':''}`)
  openCart()
}

function carMove(id, dir) {
  const track = document.getElementById(id + '_track')
  if (!track) return
  const total = track.children.length
  if (!_carState[id]) _carState[id] = 0
  _carState[id] = (_carState[id] + dir + total) % total
  track.style.transform = `translateX(-${_carState[id] * 100}%)`
  for (let i = 0; i < total; i++) {
    const d = document.getElementById(id + '_dot_' + i)
    if (d) d.style.background = i === _carState[id] ? '#fff' : 'rgba(255,255,255,.45)'
  }
}
function carGoTo(id, idx) { _carState[id] = idx; carMove(id, 0) }

function selSec(idx) {
  document.querySelectorAll('[data-sec-idx]').forEach(el => el.classList.remove('sec-selected'))
  const el = document.querySelector(`[data-sec-idx="${idx}"]`)
  if (el) { el.classList.add('sec-selected'); el.scrollIntoView({behavior:'smooth',block:'nearest'}) }
  window.parent?.postMessage({ type: 'sectionClicked', idx }, '*')
}

// ── PostMessage preview mode ──────────────────────────────────
if (P.get('preview') === '1') {
  document.body.style.cursor = 'default'
  window.addEventListener('message', (e) => {
    if (!e.data?.type) return
    if (e.data.type === 'updateSections') {
      renderStoreSections(e.data.secciones || [])
    }
    if (e.data.type === 'updateSettings') {
      settings = { ...settings, ...e.data.settings }
      applySettings()
    }
    if (e.data.type === 'highlightSection') {
      document.querySelectorAll('[data-sec-idx]').forEach(el => el.classList.remove('sec-selected'))
      if (e.data.idx != null) {
        const el = document.querySelector(`[data-sec-idx="${e.data.idx}"]`)
        if (el) { el.classList.add('sec-selected'); el.scrollIntoView({behavior:'smooth',block:'nearest'}) }
      }
    }
  })
}

// ═══════════════════════════════
// TOUCH POINTS (shoppable)
// ═══════════════════════════════
function _toggleTP(id, btn) {
  const popup = document.getElementById(id)
  if (!popup) return
  const isOpen = popup.classList.contains('open')
  _closeAllTP()
  if (!isOpen) {
    popup.classList.add('open')
    btn.classList.add('active')
  }
}
function _closeAllTP() {
  document.querySelectorAll('.tp-popup.open').forEach(function(p){ p.classList.remove('open') })
  document.querySelectorAll('.tp-dot.active').forEach(function(b){ b.classList.remove('active') })
}
document.addEventListener('keydown', function(e){ if(e.key==='Escape') _closeAllTP() })

// ═══════════════════════════════
// JOURNEY TRACKING
// ═══════════════════════════════
let _journeyInit = false
const _secsSeen = new Set()
let _scrollDepthSent = new Set()
let _pageStartTime = Date.now()
let _lastActiveTime = Date.now()
let _totalActiveMs = 0

function initJourneyTracking() {
  if (_journeyInit) return
  _journeyInit = true

  // ── Scroll depth ──
  function checkScrollDepth() {
    const scrolled = window.scrollY + window.innerHeight
    const total = document.documentElement.scrollHeight
    const pct = Math.round((scrolled / total) * 100)
    for (const threshold of [25, 50, 75, 90, 100]) {
      if (pct >= threshold && !_scrollDepthSent.has(threshold)) {
        _scrollDepthSent.add(threshold)
        trackWithId('scroll_depth', { pct: threshold })
      }
    }
  }
  window.addEventListener('scroll', checkScrollDepth, { passive: true })

  // ── Time on page ──
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      _totalActiveMs += Date.now() - _lastActiveTime
    } else {
      _lastActiveTime = Date.now()
    }
  })

  // Flush time on unload
  window.addEventListener('pagehide', function() {
    const total = _totalActiveMs + (document.hidden ? 0 : Date.now() - _lastActiveTime)
    const secs = Math.round(total / 1000)
    if (secs >= 5) trackWithId('time_on_page', { segundos: secs })
  })

  // ── Section visibility via IntersectionObserver ──
  const secObs = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        const idx = entry.target.dataset.secIdx
        if (idx != null && !_secsSeen.has(idx)) {
          _secsSeen.add(idx)
          const sec = _storeSecciones[Number(idx)]
          if (sec) trackWithId('section_view', { tipo: sec.tipo, idx: Number(idx) })
        }
      }
    })
  }, { threshold: 0.3 })

  // Observe all sections (re-run after sections render)
  function observeSections() {
    document.querySelectorAll('[data-sec-idx]').forEach(function(el) { secObs.observe(el) })
  }
  // Observe immediately + after a delay (sections may not be rendered yet)
  setTimeout(observeSections, 800)
  setTimeout(observeSections, 2500)

  // ── Product hover dwell ──
  let _hoverTimer = null; let _hoverProd = null
  document.addEventListener('mouseover', function(e) {
    const card = e.target.closest('[data-prod-id]')
    if (!card) return
    const id = card.dataset.prodId
    if (id === _hoverProd) return
    clearTimeout(_hoverTimer)
    _hoverProd = id
    _hoverTimer = setTimeout(function() {
      trackWithId('product_hover', { productoId: id })
    }, 1500)
  })
  document.addEventListener('mouseout', function(e) {
    if (!e.target.closest('[data-prod-id]')) { clearTimeout(_hoverTimer); _hoverProd = null }
  })
}

// ═══════════════════════════════
// BOOT
// ═══════════════════════════════
loadStore()
initIdentity().then(function() {
  trackEvent('view_page', { metadata: { referral: P.get('ref') || '' } })
  initJourneyTracking()
  // Living Platform: personalized experience
  if (_idUser) {
    setTimeout(function(){ _showWelcomeBack() }, 1200)
    setTimeout(function(){ _maybeShowLastViewed() }, 3500)
  }
})
