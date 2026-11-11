const zlib = require('zlib');
const { getSql, ensureSchema } = require('../lib/db');

const LIMITE_DESCOMPRIMIDO = 100 * 1024 * 1024;

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
  const sql = getSql();
  const linhas = await sql.query('SELECT data, rev FROM store WHERE id = 1');
  if (!linhas.length) return responder(req, res, 200, null);
  const base = linhas[0].data && typeof linhas[0].data === 'object' ? linhas[0].data : {};
  return responder(req, res, 200, Object.assign({}, base, { _rev: linhas[0].rev }));
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

  const sql = getSql();
  const gravado = await sql.query(
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
    const [atual] = await sql.query('SELECT rev, users_count FROM store WHERE id = 1');
    if (atual && totalUsuarios === 0 && atual.users_count > 0 && !apagarLoginsConfirmado) {
      return responder(req, res, 409, { ok: false, erro: 'Gravação recusada: base sem usuários sobrescreveria dados existentes.', rev: atual.rev });
    }
    return responder(req, res, 409, { ok: false, erro: 'Os dados foram alterados por outra pessoa. Recarregue a página.', rev: atual ? atual.rev : null });
  }

  try {
    await sql.query('SELECT ml_refresh_mirror()');
  } catch (err) {
    console.error('Falha ao atualizar as tabelas espelho (os dados principais foram gravados):', err);
  }

  return responder(req, res, 200, { ok: true, rev: gravado[0].rev });
}

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    if (req.method === 'GET') return await ler(req, res);
    if (req.method === 'POST') return await gravar(req, res);
    res.setHeader('Allow', 'GET, POST');
    return await responder(req, res, 405, { ok: false, erro: 'Método não permitido.' });
  } catch (err) {
    console.error('Erro em /api/db:', err);
    if (!res.headersSent) {
      return responder(req, res, 500, {
        ok: false,
        erro: req.method === 'POST' ? 'Falha ao gravar no banco de dados.' : 'Falha ao ler o banco de dados.'
      });
    }
  }
};
