const { neon } = require('@neondatabase/serverless');

let cliente = null;
let esquema = null;

function getSql() {
  if (cliente) return cliente;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('Variável DATABASE_URL não configurada. Conecte o banco Neon ao projeto na Vercel (aba Storage).');
  cliente = neon(url);
  return cliente;
}

async function criarEsquema() {
  const sql = getSql();
  await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(727000)`,

    sql`CREATE TABLE IF NOT EXISTS store (
      id integer PRIMARY KEY,
      data jsonb NOT NULL,
      rev integer NOT NULL DEFAULT 1,
      users_count integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    sql`CREATE TABLE IF NOT EXISTS usuarios (
      id text PRIMARY KEY, nome text, email text, senha_hash text, role text, pct double precision, ativo integer
    )`,
    sql`CREATE TABLE IF NOT EXISTS clientes (
      id text PRIMARY KEY, cod_sis text, tipo text, nome text, fantasia text, doc text, ie text, email text, tel text,
      log text, num text, bairro text, cid text, uf text, cep text, vend text, ativo integer
    )`,
    sql`CREATE TABLE IF NOT EXISTS produtos (
      id text PRIMARY KEY, cod_int text, sku text, nome text, un text, custo double precision, preco double precision,
      est double precision, cat text, marca text, ativo integer
    )`,
    sql`CREATE TABLE IF NOT EXISTS orcamentos (
      id text PRIMARY KEY, n text, cli text, vend text, vend_nome text, data bigint, frete double precision,
      parc bigint, st text, ped text, itens jsonb
    )`,
    sql`CREATE TABLE IF NOT EXISTS pedidos (
      id text PRIMARY KEY, n text, orc text, cli text, vend text, vend_nome text, data bigint, frete double precision,
      parc bigint, st text, itens jsonb
    )`,

    sql`CREATE OR REPLACE FUNCTION ml_num(t text) RETURNS double precision LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE r double precision;
    BEGIN
      r := t::double precision;
      IF r = 'NaN'::double precision OR r = 'Infinity'::double precision OR r = '-Infinity'::double precision THEN
        RETURN NULL;
      END IF;
      RETURN r;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END
    $$`,
    sql`CREATE OR REPLACE FUNCTION ml_int(t text) RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE r double precision;
    BEGIN
      r := ml_num(t);
      IF r IS NULL OR abs(r) > 9e18 THEN
        RETURN NULL;
      END IF;
      RETURN round(r)::bigint;
    END
    $$`,
    sql`CREATE OR REPLACE FUNCTION ml_flag(v jsonb) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN v IN ('0'::jsonb, 'false'::jsonb, '"0"'::jsonb) THEN 0 ELSE 1 END
    $$`,
    sql`CREATE OR REPLACE FUNCTION ml_arr(d jsonb, k text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN jsonb_typeof(d -> k) = 'array' THEN d -> k ELSE '[]'::jsonb END
    $$`,

    sql`CREATE OR REPLACE FUNCTION ml_refresh_mirror() RETURNS void LANGUAGE plpgsql AS $$
    DECLARE v_doc jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock(727001);
      SELECT s.data INTO v_doc FROM store s WHERE s.id = 1;

      DELETE FROM usuarios;
      DELETE FROM clientes;
      DELETE FROM produtos;
      DELETE FROM orcamentos;
      DELETE FROM pedidos;

      IF v_doc IS NULL THEN
        RETURN;
      END IF;

      INSERT INTO usuarios (id, nome, email, senha_hash, role, pct, ativo)
      SELECT DISTINCT ON (x.j ->> 'id')
        x.j ->> 'id', x.j ->> 'nome', x.j ->> 'email', x.j ->> 'h', x.j ->> 'role',
        ml_num(x.j ->> 'pct'), ml_flag(x.j -> 'ativo')
      FROM jsonb_array_elements(ml_arr(v_doc, 'users')) AS x(j)
      WHERE jsonb_typeof(x.j) = 'object' AND COALESCE(x.j ->> 'id', '') <> ''
      ORDER BY x.j ->> 'id';

      INSERT INTO clientes (id, cod_sis, tipo, nome, fantasia, doc, ie, email, tel, log, num, bairro, cid, uf, cep, vend, ativo)
      SELECT DISTINCT ON (x.j ->> 'id')
        x.j ->> 'id', x.j ->> 'codSis', x.j ->> 'tipo', x.j ->> 'nome', x.j ->> 'fantasia', x.j ->> 'doc',
        x.j ->> 'ie', x.j ->> 'email', x.j ->> 'tel', x.j ->> 'log', x.j ->> 'num', x.j ->> 'bairro',
        x.j ->> 'cid', x.j ->> 'uf', x.j ->> 'cep', x.j ->> 'vend', ml_flag(x.j -> 'ativo')
      FROM jsonb_array_elements(ml_arr(v_doc, 'cli')) AS x(j)
      WHERE jsonb_typeof(x.j) = 'object' AND COALESCE(x.j ->> 'id', '') <> ''
      ORDER BY x.j ->> 'id';

      INSERT INTO produtos (id, cod_int, sku, nome, un, custo, preco, est, cat, marca, ativo)
      SELECT DISTINCT ON (x.j ->> 'id')
        x.j ->> 'id', x.j ->> 'codInt', x.j ->> 'sku', x.j ->> 'nome', x.j ->> 'un',
        ml_num(x.j ->> 'custo'), ml_num(x.j ->> 'preco'), ml_num(x.j ->> 'est'),
        x.j ->> 'cat', x.j ->> 'marca', ml_flag(x.j -> 'ativo')
      FROM jsonb_array_elements(ml_arr(v_doc, 'prod')) AS x(j)
      WHERE jsonb_typeof(x.j) = 'object' AND COALESCE(x.j ->> 'id', '') <> ''
      ORDER BY x.j ->> 'id';

      INSERT INTO orcamentos (id, n, cli, vend, vend_nome, data, frete, parc, st, ped, itens)
      SELECT DISTINCT ON (x.j ->> 'id')
        x.j ->> 'id', x.j ->> 'n', x.j ->> 'cli', x.j ->> 'vend', x.j ->> 'vendNome',
        ml_int(x.j ->> 'data'), ml_num(x.j ->> 'frete'), ml_int(x.j ->> 'parc'),
        x.j ->> 'st', x.j ->> 'ped',
        CASE WHEN jsonb_typeof(x.j -> 'itens') = 'array' THEN x.j -> 'itens' ELSE '[]'::jsonb END
      FROM jsonb_array_elements(ml_arr(v_doc, 'orc')) AS x(j)
      WHERE jsonb_typeof(x.j) = 'object' AND COALESCE(x.j ->> 'id', '') <> ''
      ORDER BY x.j ->> 'id';

      INSERT INTO pedidos (id, n, orc, cli, vend, vend_nome, data, frete, parc, st, itens)
      SELECT DISTINCT ON (x.j ->> 'id')
        x.j ->> 'id', x.j ->> 'n', x.j ->> 'orc', x.j ->> 'cli', x.j ->> 'vend', x.j ->> 'vendNome',
        ml_int(x.j ->> 'data'), ml_num(x.j ->> 'frete'), ml_int(x.j ->> 'parc'),
        x.j ->> 'st',
        CASE WHEN jsonb_typeof(x.j -> 'itens') = 'array' THEN x.j -> 'itens' ELSE '[]'::jsonb END
      FROM jsonb_array_elements(ml_arr(v_doc, 'ped')) AS x(j)
      WHERE jsonb_typeof(x.j) = 'object' AND COALESCE(x.j ->> 'id', '') <> ''
      ORDER BY x.j ->> 'id';
    END
    $$`
  ]);
}

function ensureSchema() {
  if (!esquema) esquema = criarEsquema().catch(err => { esquema = null; throw err; });
  return esquema;
}

module.exports = { getSql, ensureSchema };
