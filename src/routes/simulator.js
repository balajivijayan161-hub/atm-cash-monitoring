const express = require('express');
const { asyncRoute } = require('../http');
const { getSimulatorStatus, startSimulator, stopSimulator } = require('../services/simulator');
const { guard } = require('../auth/gate');
const { recordChange } = require('../auth/activity');

const router = express.Router();

router.get('/live-feed/status', asyncRoute(async (req, res) => {
  res.json(getSimulatorStatus());
}));

router.post('/live-feed/start', asyncRoute(async (req, res) => {
  startSimulator();
  await recordChange(req, {
    action: 'update',
    entity: 'live feed',
    entityId: 'feed',
    before: { running: false },
    after: { running: true },
  });
  res.redirect('/?notice=Live Feed started. It stops itself after 15 minutes.');
}));

router.post('/live-feed/stop', asyncRoute(async (req, res) => {
  await stopSimulator();
  await recordChange(req, {
    action: 'update',
    entity: 'live feed',
    entityId: 'feed',
    before: { running: true },
    after: { running: false },
  });
  res.redirect('/?notice=Live Feed stopped.');
}));

module.exports = guard(router, 'liveFeed');
