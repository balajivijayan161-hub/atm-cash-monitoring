const express = require('express');
const { asyncRoute } = require('../http');
const { getSimulatorStatus, startSimulator, stopSimulator } = require('../services/simulator');

const router = express.Router();

router.get('/live-feed/status', asyncRoute(async (req, res) => {
  res.json(getSimulatorStatus());
}));

router.post('/live-feed/start', asyncRoute(async (req, res) => {
  startSimulator();
  res.redirect('/?notice=Live Feed started. It stops itself after 15 minutes.');
}));

router.post('/live-feed/stop', asyncRoute(async (req, res) => {
  await stopSimulator();
  res.redirect('/?notice=Live Feed stopped.');
}));

module.exports = router;
