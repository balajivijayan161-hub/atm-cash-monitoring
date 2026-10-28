const { pool, applySchema } = require('./db');
const { seedIfEmpty } = require('../db/seed');
const { createApp } = require('./app');
const { startInboundPoller, stopInboundPoller } = require('./services/inboundPoller');
const { stopSimulator } = require('./services/simulator');
const { closeLiveFeedDowntime } = require('./services/ingestionRules');
const { seedAccessUsers } = require('./auth/accounts');

async function boot() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(842015)');
    await client.query('BEGIN');
    await applySchema(client);
    const seeded = await seedIfEmpty(client);
    await closeLiveFeedDowntime(client);
    await seedAccessUsers(client);
    await client.query('COMMIT');
    if (seeded) console.log('Sample ledger committed.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* session may already be clear */ }
    throw err;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(842015)'); } catch (unlockErr) { /* lock drops with the session */ }
    client.release();
  }
}

async function main() {
  await boot();
  const app = createApp();
  const port = Number(process.env.PORT) || 43123;
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`ATM cash operations listening on ${port}`);
  });
  startInboundPoller();
  const shutdown = () => {
    stopInboundPoller();
    stopSimulator();
    server.close(() => {
      pool.end().catch(() => {});
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start', err);
    process.exit(1);
  });
}

module.exports = { boot, main };
