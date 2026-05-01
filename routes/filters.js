const express = require('express');
const router = express.Router();
const filterService = require('../services/filterService');

// GET /api/filters → List all saved filters
router.get('/', (req, res) => {
  const filters = filterService.getAllFilters();
  res.json(filters.map(f => ({ id: f.id, name: f.name, updatedAt: f.updatedAt })));
});

// POST /api/filters/save
router.post('/save', async (req, res) => {
  const { name, config, overwrite = false } = req.body;

  if (!name || !config) {
    return res.status(400).json({ error: 'Name and config are required' });
  }

  try {
    const result = await filterService.saveFilter(name, config, overwrite);
    res.json(result);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

module.exports = router;
