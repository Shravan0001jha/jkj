// A lossy proxy for reliability runs: node mock/lossy-proxy.mjs [--port 4398] [--to 4399] [--loss 0.3] [--delay 2000] [--ws-kill 20000]
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
const a = process.argv.slice(2); const o = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const PORT = +o('--port', 4398), TO = +o('--to', 4399), LOSS = +o('--loss', 0.3), DELAY = +o('--delay', 2000), WSKILL = +o('--ws-kill', 20000);
const log = (...x) => console.log(new Date().toISOString().slice(11, 19), ...x);
const srv = createServer((req, res) => {
  if (Math.random() < LOSS) { log('DROP', req.method, req.url); req.socket.destroy(); return; }
  const wait = Math.random() * DELAY;
  setTimeout(() => {
    const up = request({ host: '127.0.0.1', port: TO, method: req.method, path: req.url, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
    log('pass', req.method, req.url, `+${Math.round(wait)}ms`);
  }, wait);
});
srv.on('upgrade', (req, socket, head) => {
  if (Math.random() < LOSS) { log('DROP ws'); socket.destroy(); return; }
  const up = connect(TO, '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    up.write(head); socket.pipe(up); up.pipe(socket);
    log('ws up; killing in', WSKILL, 'ms');
    setTimeout(() => { log('KILL ws'); socket.destroy(); up.destroy(); }, WSKILL);
  });
  up.on('error', () => socket.destroy());
});
srv.listen(PORT, '127.0.0.1', () => log(`lossy proxy :${PORT} → :${TO} loss=${LOSS} delay≤${DELAY}ms ws-kill=${WSKILL}ms`));
