const fs = require('fs');
const path = require('path');

const files = [
  'scripts/fix-changelog.cjs',
  'scripts/fix-changelog.js',
  'scripts/fix-changelog.py'
];

for (const f of files) {
  try {
    fs.unlinkSync(f);
    console.log('deleted:', f);
  } catch (e) {
    console.log('skip:', f, e.message);
  }
}
