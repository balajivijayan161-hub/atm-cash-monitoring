const express = require('express');
const { asyncRoute, renderPage } = require('../http');

const router = express.Router();

router.get('/operations/ej-archive', asyncRoute(async (req, res) => {
  renderPage(req, res, 'ej-archive', {
    title: 'EJ log archive',
  });
}));

module.exports = router;
