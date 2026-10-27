const fs = require('fs');
const path = require('path');
const express = require('express');
const { asyncRoute, renderPage } = require('../http');

const router = express.Router();
const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'archive_ej_logs.sh');

router.get('/operations/ej-archive', asyncRoute(async (req, res) => {
  const script = fs.readFileSync(scriptPath, 'utf8');
  renderPage(req, res, 'ej-archive', {
    title: 'EJ log archive',
    script,
  });
}));

module.exports = router;
