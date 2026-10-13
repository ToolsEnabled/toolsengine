// Verification aid: stands where a proxy would be, lets nothing through, and
// writes down the first line of whatever is asked of it (for example
// "CONNECT example.com:443 HTTP/1.1"). It shows what a program would have
// contacted without anything leaving the machine.
//   node proxy-sink.mjs LOG_FILE   -> prints the port it listens on
import net from 'node:net';
import fs from 'node:fs';

const log = process.argv[2];
const server = net.createServer(socket => {
  socket.once('data', chunk => {
    const first = chunk.toString('latin1').split('\r\n')[0].slice(0, 200);
    fs.appendFileSync(log, `${new Date().toISOString()} ${first}\n`);
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  socket.on('error', () => {});
});
server.listen(0, '127.0.0.1', () => { console.log(server.address().port); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
