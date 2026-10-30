// Run: node period.test.js   (the 신청서 prints the whole month: monthBounds from index.html)
const assert = require('assert'), fs = require('fs');
const src = fs.readFileSync(__dirname + '/index.html', 'utf8');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const monthBounds = new Function('ymd', 'return ' + src.match(/function monthBounds[^\n]*/)[0].replace(/^function monthBounds/, 'function'))(ymd);
assert.deepStrictEqual(monthBounds('2026-02'), ['2026-02-01', '2026-02-28']);
assert.deepStrictEqual(monthBounds('2028-02'), ['2028-02-01', '2028-02-29']);
assert.deepStrictEqual(monthBounds('2026-04'), ['2026-04-01', '2026-04-30']);
assert.deepStrictEqual(monthBounds('2026-10'), ['2026-10-01', '2026-10-31']);
assert(/var mb = monthBounds\(enr\.month\), ps = parse\(mb\[0\]\), pe = parse\(mb\[1\]\)/.test(src), 'signLeft must use monthBounds');
console.log('OK period');
