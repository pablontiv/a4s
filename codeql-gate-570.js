const http = require('node:http');
http.createServer((req, res) => {
  const input = new URL(req.url, 'http://localhost').searchParams.get('input') || '';
  res.end(String(/^(a+)+$/.test(input)));
}).listen(0, '127.0.0.1');
