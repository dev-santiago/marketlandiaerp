const zlib = require('zlib');
const { Pool } = require('pg');

const LIMITE_DESCOMPRIMIDO = 100 * 1024 * 1024;

const ehPostgres = v => typeof v === 'string' && /^postgres(ql)?:\/\//i.test(v);

function acharUrl() {
  for (const nome of ['DATABASE_URL', 'POSTGRES_URL']) {
    if (ehPostgres(process.env[nome])) return { nome, url: process.env[nome] };
  }
  const outras = Object.keys(process.env).filter(k => ehPostgres(process.env[k])).sort();
  const pooled = outras.filter(k => !/UNPOOLED|NON_POOLING|NO_SSL|PRISMA/i.test(k));
  const nome = pooled[0] || outras[0];
  if (nome) return { nome, url: process.env[nome] };
  const candidatas = Object.keys(process.env).filter(k => /URL|POSTGRES|DATABASE|PG/i.test(k)).sort();
  throw new Error('Nenhuma variável de conexão do banco encontrada. Variáveis parecidas que existem: ' + (candidatas.join(', ') || 'nenhuma') + '. Conecte o banco ao projeto (Storage > Connect Project) e faça um Redeploy.');
}

let pool = null;
let origem = null;

function getPool() {
  if (pool) return pool;
  const achada = acharUrl();
  origem = achada.nome;
  const u = new URL(achada.url);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('channel_binding');
  const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  pool = new Pool({
    connectionString: u.toString(),
    ssl: local ? false : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 15000
  });
  pool.on('error', err => console.error('Erro no pool do banco:', err));
  return pool;
}

const consultar = async (texto, valores) => (await getPool().query(texto, valores)).rows;

const DDL_BASE = `CREATE TABLE IF NOT EXISTS store (
  id integer PRIMARY KEY,
  data jsonb NOT NULL,
  rev integer NOT NULL DEFAULT 1,
  users_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

const DDL_ESPELHO = `SELECT pg_advisory_xact_lock(727000);
CREATE TABLE IF NOT EXISTS usuarios (
      id text PRIMARY KEY, nome text, email text, senha_hash text, role text, pct double precision, ativo integer
    );
CREATE TABLE IF NOT EXISTS clientes (
      id text PRIMARY KEY, cod_sis text, tipo text, nome text, fantasia text, doc text, ie text, email text, tel text,
      log text, num text, bairro text, cid text, uf text, cep text, vend text, ativo integer
    );
CREATE TABLE IF NOT EXISTS produtos (
      id text PRIMARY KEY, cod_int text, sku text, nome text, un text, custo double precision, preco double precision,
      est double precision, cat text, marca text, ativo integer
    );
CREATE TABLE IF NOT EXISTS orcamentos (
      id text PRIMARY KEY, n text, cli text, vend text, vend_nome text, data bigint, frete double precision,
      parc bigint, st text, ped text, itens jsonb
    );
CREATE TABLE IF NOT EXISTS pedidos (
      id text PRIMARY KEY, n text, orc text, cli text, vend text, vend_nome text, data bigint, frete double precision,
      parc bigint, st text, itens jsonb
    );
CREATE OR REPLACE FUNCTION ml_num(t text) RETURNS double precision LANGUAGE plpgsql IMMUTABLE AS $$
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
    $$;
CREATE OR REPLACE FUNCTION ml_int(t text) RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE r double precision;
    BEGIN
      r := ml_num(t);
      IF r IS NULL OR abs(r) > 9e18 THEN
        RETURN NULL;
      END IF;
      RETURN round(r)::bigint;
    END
    $$;
CREATE OR REPLACE FUNCTION ml_flag(v jsonb) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN v IN ('0'::jsonb, 'false'::jsonb, '"0"'::jsonb) THEN 0 ELSE 1 END
    $$;
CREATE OR REPLACE FUNCTION ml_arr(d jsonb, k text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN jsonb_typeof(d -> k) = 'array' THEN d -> k ELSE '[]'::jsonb END
    $$;
CREATE OR REPLACE FUNCTION ml_refresh_mirror() RETURNS void LANGUAGE plpgsql AS $$
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
    $$;`;

let base = null;
let espelho = null;
let espelhoErro = null;

function prepararBase() {
  if (!base) base = consultar(DDL_BASE).catch(err => { base = null; throw err; });
  return base;
}

function prepararEspelho() {
  if (espelho) return espelho;
  espelho = (async () => {
    try {
      await consultar(DDL_ESPELHO);
      espelhoErro = null;
      return true;
    } catch (err) {
      espelhoErro = String(err && err.message ? err.message : err);
      console.error('Tabelas espelho indisponíveis (o sistema continua gravando normalmente):', err);
      return false;
    }
  })();
  return espelho;
}

const lerCorpo = req => new Promise((resolve, reject) => {
  const partes = [];
  req.on('data', p => partes.push(p));
  req.on('end', () => resolve(Buffer.concat(partes)));
  req.on('error', reject);
});

const gzip = buf => new Promise((resolve, reject) =>
  zlib.gzip(buf, { level: 4 }, (err, out) => (err ? reject(err) : resolve(out))));

const gunzip = buf => new Promise((resolve, reject) =>
  zlib.gunzip(buf, { maxOutputLength: LIMITE_DESCOMPRIMIDO }, (err, out) => (err ? reject(err) : resolve(out))));

async function responder(req, res, status, payload) {
  const texto = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Accept-Encoding');
  if (texto.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const comprimido = await gzip(Buffer.from(texto));
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', comprimido.length);
    return res.end(comprimido);
  }
  return res.end(texto);
}

async function lerJson(req) {
  let corpo = await lerCorpo(req);
  if (corpo.length > 2 && corpo[0] === 0x1f && corpo[1] === 0x8b) corpo = await gunzip(corpo);
  return JSON.parse(corpo.toString('utf8'));
}

async function ler(req, res) {
  const linhas = await consultar('SELECT data, rev FROM store WHERE id = 1');
  if (!linhas.length) return responder(req, res, 200, null);
  const dados = linhas[0].data && typeof linhas[0].data === 'object' ? linhas[0].data : {};
  return responder(req, res, 200, Object.assign({}, dados, { _rev: linhas[0].rev }));
}

async function gravar(req, res) {
  let dados;
  try {
    dados = await lerJson(req);
  } catch (err) {
    return responder(req, res, 400, { ok: false, erro: 'Corpo da requisição inválido.' });
  }
  if (!dados || typeof dados !== 'object' || !Array.isArray(dados.users)) {
    return responder(req, res, 400, { ok: false, erro: 'Dados inválidos.' });
  }

  const revCliente = Number.isInteger(dados._rev) ? dados._rev : null;
  delete dados._rev;
  const apagarLoginsConfirmado = req.headers['x-confirm-wipe-users'] === 'sim';
  const totalUsuarios = dados.users.length;
  const json = JSON.stringify(dados).replace(/(?<!\\)\\u0000/g, '');

  const gravado = await consultar(
    `INSERT INTO store AS s (id, data, rev, users_count, updated_at)
     VALUES (1, $1::jsonb, 1, $2::int, now())
     ON CONFLICT (id) DO UPDATE
       SET data = EXCLUDED.data, rev = s.rev + 1, users_count = EXCLUDED.users_count, updated_at = now()
       WHERE (s.rev = $3::int OR (s.users_count = 0 AND $2::int > 0))
         AND ($2::int > 0 OR $4::boolean OR s.users_count = 0)
     RETURNING rev`,
    [json, totalUsuarios, revCliente, apagarLoginsConfirmado]
  );

  if (!gravado.length) {
    const [atual] = await consultar('SELECT rev, users_count FROM store WHERE id = 1');
    if (atual && totalUsuarios === 0 && atual.users_count > 0 && !apagarLoginsConfirmado) {
      return responder(req, res, 409, { ok: false, erro: 'Gravação recusada: base sem usuários sobrescreveria dados existentes.', rev: atual.rev });
    }
    return responder(req, res, 409, { ok: false, erro: 'Os dados foram alterados por outra pessoa. Recarregue a página.', rev: atual ? atual.rev : null });
  }

  if (await prepararEspelho()) {
    try {
      await consultar('SELECT ml_refresh_mirror()');
    } catch (err) {
      console.error('Falha ao atualizar as tabelas espelho (os dados principais foram gravados):', err);
    }
  }

  return responder(req, res, 200, { ok: true, rev: gravado[0].rev });
}

async function saude(req, res) {
  const [reg] = await consultar('SELECT rev, users_count, updated_at, octet_length(data::text) AS bytes FROM store WHERE id = 1');
  const temEspelho = await prepararEspelho();
  let tabelas = null;
  if (temEspelho) {
    const [t] = await consultar(
      `SELECT (SELECT count(*) FROM usuarios)::int AS usuarios, (SELECT count(*) FROM clientes)::int AS clientes,
              (SELECT count(*) FROM produtos)::int AS produtos, (SELECT count(*) FROM orcamentos)::int AS orcamentos,
              (SELECT count(*) FROM pedidos)::int AS pedidos`
    );
    tabelas = t;
  }
  return responder(req, res, 200, {
    ok: true,
    banco: 'conectado',
    variavel_usada: origem,
    gravado: reg
      ? { versao: reg.rev, usuarios: reg.users_count, atualizado_em: reg.updated_at, tamanho_kb: Math.round(reg.bytes / 1024) }
      : 'ainda sem dados (normal antes do primeiro acesso)',
    tabelas_copia: temEspelho ? tabelas : 'indisponíveis: ' + espelhoErro
  });
}

module.exports = async function handler(req, res) {
  const consulta = String(req.url || '').split('?')[1] || '';
  const pedindoSaude = req.method === 'GET' && /(^|&)saude=1(&|$)/.test(consulta);
  const pedindoRev = req.method === 'GET' && /(^|&)rev=1(&|$)/.test(consulta);
  try {
    await prepararBase();
    if (pedindoSaude) return await saude(req, res);
    if (pedindoRev) {
      const [linha] = await consultar('SELECT rev FROM store WHERE id = 1');
      return await responder(req, res, 200, { rev: linha ? linha.rev : 0 });
    }
    if (req.method === 'GET') return await ler(req, res);
    if (req.method === 'POST') return await gravar(req, res);
    res.setHeader('Allow', 'GET, POST');
    return await responder(req, res, 405, { ok: false, erro: 'Método não permitido.' });
  } catch (err) {
    console.error('Erro em /api/db:', err);
    if (res.headersSent) return;
    if (pedindoSaude) {
      return responder(req, res, 500, { ok: false, erro: String(err && err.message ? err.message : err) });
    }
    return responder(req, res, 500, {
      ok: false,
      erro: req.method === 'POST' ? 'Falha ao gravar no banco de dados.' : 'Falha ao ler o banco de dados.'
    });
  }
};
