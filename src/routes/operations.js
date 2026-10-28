const express = require('express');
const { asyncRoute, renderPage } = require('../http');
const { requireCan } = require('../auth/gate');

const router = express.Router();
router.use(requireCan('journals'));

router.get('/operations/ej-archive', asyncRoute(async (req, res) => {
  renderPage(req, res, 'ej-archive', {
    title: 'Electronic Journal Archive',
  });
}));

module.exports = router;
