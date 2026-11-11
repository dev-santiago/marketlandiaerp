const { getSql, ensureSchema } = require('../lib/db');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const sql = getSql();
    const [reg] = await sql.query(
      `SELECT rev, users_count, updated_at, octet_length(data::text) AS bytes FROM store WHERE id = 1`
    );
    const [esp] = await sql.query(
      `SELECT (SELECT count(*) FROM usuarios)::int AS usuarios,
              (SELECT count(*) FROM clientes)::int AS clientes,
              (SELECT count(*) FROM produtos)::int AS produtos,
              (SELECT count(*) FROM orcamentos)::int AS orcamentos,
              (SELECT count(*) FROM pedidos)::int AS pedidos`
    );
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      banco: 'conectado',
      gravado: reg
        ? { versao: reg.rev, atualizado_em: reg.updated_at, tamanho_kb: Math.round(reg.bytes / 1024) }
        : 'ainda sem dados (normal antes do primeiro acesso)',
      tabelas: esp
    }));
  } catch (err) {
    console.error('Erro em /api/health:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, erro: String(err && err.message ? err.message : err) }));
  }
};
