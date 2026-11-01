const http = require('http');
const fs = require('fs');
const path = require('path');

const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/sala.html': ['sala.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/pattern.svg': ['pattern.svg', 'image/svg+xml'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
http.createServer((req, res) => {
  const file = files[new URL(req.url, 'http://localhost').pathname];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, file[0]), (err, data) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    res.writeHead(200, { 'Content-Type': file[1] }); res.end(data);
  });
}).listen(Number(process.env.PORT || 8000), '127.0.0.1', function () { console.log('Campos Calls: http://localhost:' + this.address().port); });
