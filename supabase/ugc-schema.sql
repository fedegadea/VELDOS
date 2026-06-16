-- ════════════════════════════════════════════════════════════
-- UGC MODULE — Soul EcommLab
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- ════════════════════════════════════════════════════════════

-- ── 1. CREADORAS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ugc_creadoras (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telefono      TEXT UNIQUE NOT NULL,
  instagram_url TEXT,
  nombre        TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ── 2. SESIONES / OTP ────────────────────────────────────────
-- tipo='otp'     → codigo + expira_at (se sobreescribe por teléfono)
-- tipo='session' → token + creadora_id (una sesión por teléfono activa)
CREATE TABLE IF NOT EXISTS ugc_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo        TEXT NOT NULL CHECK (tipo IN ('otp','session')),
  telefono    TEXT NOT NULL,
  codigo      TEXT,
  token       TEXT UNIQUE,
  creadora_id UUID REFERENCES ugc_creadoras(id) ON DELETE CASCADE,
  expira_at   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (telefono, tipo)   -- UPSERT seguro por teléfono+tipo
);

-- ── 3. CANJES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ugc_canjes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ws_id            TEXT NOT NULL,
  producto         TEXT NOT NULL,
  brief            JSONB DEFAULT '{}',
  cupon_codigo     TEXT,           -- NUNCA exponer antes de cupon_liberado
  producto_url     TEXT,
  pago_monto       NUMERIC,
  demora_max_dias  INTEGER DEFAULT 7,
  estado           TEXT NOT NULL DEFAULT 'disponible'
                   CHECK (estado IN ('disponible','pausado','cerrado')),
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS ugc_canjes_ws_id_idx    ON ugc_canjes (ws_id);
CREATE INDEX IF NOT EXISTS ugc_canjes_estado_idx   ON ugc_canjes (estado);

-- ── MIGRACIÓN: agregar descuento_tipo ────────────────────────
-- Ejecutar si la tabla ya existe:
-- ALTER TABLE ugc_canjes ADD COLUMN IF NOT EXISTS descuento_tipo TEXT;

-- ── 4. SOLICITUDES ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ugc_solicitudes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canje_id              UUID NOT NULL REFERENCES ugc_canjes(id) ON DELETE CASCADE,
  creadora_id           UUID NOT NULL REFERENCES ugc_creadoras(id) ON DELETE CASCADE,
  estado                TEXT NOT NULL DEFAULT 'solicitado'
                        CHECK (estado IN ('solicitado','aceptado','rechazado','entregado','vencido')),
  cupon_liberado        BOOLEAN NOT NULL DEFAULT false,
  fecha_solicitud       TIMESTAMPTZ DEFAULT now(),
  fecha_resolucion      TIMESTAMPTZ,
  fecha_limite_entrega  TIMESTAMPTZ,
  UNIQUE (canje_id, creadora_id)   -- una creadora no puede solicitar dos veces el mismo canje
);

CREATE INDEX IF NOT EXISTS ugc_sol_canje_idx    ON ugc_solicitudes (canje_id);
CREATE INDEX IF NOT EXISTS ugc_sol_creadora_idx ON ugc_solicitudes (creadora_id);
CREATE INDEX IF NOT EXISTS ugc_sol_estado_idx   ON ugc_solicitudes (estado);

-- ════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ════════════════════════════════════════════════════════════

-- Habilitar RLS en todas las tablas
ALTER TABLE ugc_creadoras  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ugc_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ugc_canjes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ugc_solicitudes ENABLE ROW LEVEL SECURITY;

-- El backend Express.js usa service_role (bypasea RLS por defecto).
-- Las policies de abajo son defensa adicional si alguna vez se
-- conecta un cliente directo a Supabase.

-- ugc_creadoras: solo lectura pública (sin cupon_codigo aquí)
CREATE POLICY "creadoras_select" ON ugc_creadoras
  FOR SELECT USING (true);

CREATE POLICY "creadoras_insert" ON ugc_creadoras
  FOR INSERT WITH CHECK (true);

CREATE POLICY "creadoras_update" ON ugc_creadoras
  FOR UPDATE USING (true);

-- ugc_sessions: solo el servidor las gestiona
CREATE POLICY "sessions_all" ON ugc_sessions
  FOR ALL USING (true);

-- ugc_canjes: SELECT sin cupon_codigo via la vista ugc_canjes_pub
-- El INSERT/UPDATE/DELETE solo lo hace el servidor con service_role
CREATE POLICY "canjes_select" ON ugc_canjes
  FOR SELECT USING (true);

CREATE POLICY "canjes_write" ON ugc_canjes
  FOR ALL USING (true);

-- ugc_solicitudes: todas las operaciones
CREATE POLICY "solicitudes_all" ON ugc_solicitudes
  FOR ALL USING (true);

-- ════════════════════════════════════════════════════════════
-- VISTA PÚBLICA (sin cupon_codigo)
-- Úsala para consultas públicas como capa extra de seguridad
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW ugc_canjes_pub AS
  SELECT
    id, ws_id, producto, brief, producto_url,
    pago_monto, demora_max_dias, estado, created_at
  FROM ugc_canjes
  WHERE estado = 'disponible';

-- cupon_codigo NO aparece en esta vista.
-- La vista es de solo lectura (no exponer via API pública, solo como seguridad extra).
