const express = require('express');
const router = express.Router();

const healthRoutes = require('./health');
const walletRoutes = require('./wallet');
const compileRoutes = require('./compile');
const contractRoutes = require('./contract');

router.use('/api', healthRoutes);
router.use('/api', walletRoutes);
router.use('/api', compileRoutes);
router.use('/api', contractRoutes);

module.exports = router;
