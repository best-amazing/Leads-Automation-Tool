const fs = require('fs');
const path = require('path');
const file = 'amazing-properties-447020-b2f3946f4b3e.json';
console.log('cwd:', process.cwd());
console.log('__dirname:', __dirname);
const p1 = path.join(process.cwd(), file);
const p2 = path.join(__dirname, file);
console.log('p1:', p1, 'exists?', fs.existsSync(p1));
console.log('p2:', p2, 'exists?', fs.existsSync(p2));
 