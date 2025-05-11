// backend/label.js
require('dotenv').config();
const { processJob } = require('./app');

processJob()
  .then(results => {
    console.log('Labeler results:', results);
    process.exit(0);
  })
  .catch(err => {
    console.error('Labeler error:', err);
    process.exit(1);
  });
