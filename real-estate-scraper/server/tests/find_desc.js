const fs = require('fs');
const data = JSON.parse(fs.readFileSync('logs/zillow_detail_nextdata_2.json'));
let desc = [];
function findDesc(obj, path, depth) {
  if(depth > 10) return;
  if(obj && typeof obj === 'object') {
    if(obj.description && typeof obj.description === 'string' && obj.description.length > 50) {
      desc.push({path: path + '.description', val: obj.description.substring(0, 100)});
    }
    Object.keys(obj).forEach(k => {
      if(typeof obj[k] === 'string' && obj[k].includes('{"')) {
        try {
          let parsed = JSON.parse(obj[k]);
          findDesc(parsed, path + '.' + k + '(parsed)', depth+1);
        } catch(e) {}
      } else {
        findDesc(obj[k], path + '.' + k, depth + 1);
      }
    });
  } else if(Array.isArray(obj)) {
    obj.forEach((v, i) => findDesc(v, path + '[' + i + ']', depth + 1));
  }
}
findDesc(data, 'root', 0);
console.log(JSON.stringify(desc, null, 2));
