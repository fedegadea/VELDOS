-- ════════════════════════════════════════════════════════════
-- SOUL CLUB MODULE — SOULAB
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- ════════════════════════════════════════════════════════════
-- ANTES DE EJECUTAR:
-- 1. Ir a Supabase → Storage → New bucket
--    Nombre: soul-club · Public bucket: ✓ ON
-- ════════════════════════════════════════════════════════════

-- ── 1. MIEMBROS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS soul_club_miembros (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ws_id      TEXT NOT NULL,
  email      TEXT NOT NULL,
  nombre     TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (ws_id, email)
);

-- ── 2. EVENTOS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS soul_club_eventos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ws_id            TEXT NOT NULL,
  titulo           TEXT NOT NULL,
  descripcion      TEXT,
  fecha            DATE,
  lugar            TEXT,
  imagen_url       TEXT,
  waitlist_abierta BOOLEAN NOT NULL DEFAULT true,
  publicado        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ── 3. WAITLIST EVENTOS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS soul_club_waitlist_eventos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id  UUID NOT NULL REFERENCES soul_club_eventos(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  nombre     TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (evento_id, email)
);

-- ── 4. DROPS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS soul_club_drops (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ws_id            TEXT NOT NULL,
  titulo           TEXT NOT NULL,
  descripcion      TEXT,
  fecha_drop       DATE,
  imagen_url       TEXT,
  waitlist_abierta BOOLEAN NOT NULL DEFAULT true,
  publicado        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ── 5. WAITLIST DROPS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS soul_club_waitlist_drops (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drop_id    UUID NOT NULL REFERENCES soul_club_drops(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  nombre     TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (drop_id, email)
);

-- ── 6. BENEFICIOS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS soul_club_beneficios (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ws_id          TEXT NOT NULL,
  titulo         TEXT NOT NULL,
  descripcion    TEXT,
  tipo           TEXT NOT NULL DEFAULT 'codigo'
                 CHECK (tipo IN ('codigo','lugar','descuento','otro')),
  codigo         TEXT,
  lugar          TEXT,
  imagen_url     TEXT,
  vigencia_hasta DATE,
  activo         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ── ÍNDICES ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS sc_miembros_ws_idx    ON soul_club_miembros (ws_id);
CREATE INDEX IF NOT EXISTS sc_eventos_ws_idx     ON soul_club_eventos (ws_id);
CREATE INDEX IF NOT EXISTS sc_drops_ws_idx       ON soul_club_drops (ws_id);
CREATE INDEX IF NOT EXISTS sc_beneficios_ws_idx  ON soul_club_beneficios (ws_id);

-- ── RLS ───────────────────────────────────────────────────────
ALTER TABLE soul_club_miembros         ENABLE ROW LEVEL SECURITY;
ALTER TABLE soul_club_eventos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE soul_club_waitlist_eventos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE soul_club_drops             ENABLE ROW LEVEL SECURITY;
ALTER TABLE soul_club_waitlist_drops    ENABLE ROW LEVEL SECURITY;
ALTER TABLE soul_club_beneficios        ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sc_miembros_all"  ON soul_club_miembros         FOR ALL USING (true);
CREATE POLICY "sc_eventos_all"   ON soul_club_eventos           FOR ALL USING (true);
CREATE POLICY "sc_wl_ev_all"     ON soul_club_waitlist_eventos  FOR ALL USING (true);
CREATE POLICY "sc_drops_all"     ON soul_club_drops             FOR ALL USING (true);
CREATE POLICY "sc_wl_dr_all"     ON soul_club_waitlist_drops    FOR ALL USING (true);
CREATE POLICY "sc_benef_all"     ON soul_club_beneficios        FOR ALL USING (true);
