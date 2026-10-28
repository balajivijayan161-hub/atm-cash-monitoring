const express = require('express');
const { asyncRoute } = require('../http');
const { getSimulatorStatus, startSimulator, stopSimulator } = require('../services/simulator');

const router = express.Router();

router.get('/simulator/status', asyncRoute(async (req, res) => {
  res.json(getSimulatorStatus());
}));

router.post('/simulator/start', asyncRoute(async (req, res) => {
  startSimulator();
  res.redirect('/?notice=Live feed started. It stops itself after 15 minutes.');
}));

router.post('/simulator/stop', asyncRoute(async (req, res) => {
  stopSimulator();
  res.redirect('/?notice=Live feed stopped.');
}));

module.exports = router;
