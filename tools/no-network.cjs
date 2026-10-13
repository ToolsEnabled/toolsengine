// Verification aid: a Node.js process started with this file preloaded cannot
// use the network, and every attempt is written to a log.
//
//   NODE_OPTIONS="--require /path/to/no-network.cjs"
//   TOOLSENGINE_NO_NETWORK_LOG=/path/to/log.txt
//
// NODE_OPTIONS is inherited, so the processes that the first one starts with
// Node.js are covered too (the installer, and the server it starts for its
// check). Each process writes one "loaded" line, which shows it was covered.
// Programs that are not Node.js, such as a browser, are not covered.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');

const log = process.env.TOOLSENGINE_NO_NETWORK_LOG;
const who = `pid ${process.pid} ${path.basename(process.argv[1] || 'node')}`;
const write = line => { if (log) try { fs.appendFileSync(log, `${new Date().toISOString()} ${who} ${line}\n`); } catch { /* the log is an aid */ } };
const refuse = what => function refused() {
  write(`REFUSED ${what}`);
  throw new Error(`Network use refused by the verification guard: ${what}`);
};

net.Socket.prototype.connect = refuse('net connect');
net.Server.prototype.listen = refuse('net listen');
dgram.Socket.prototype.bind = refuse('udp bind');
dgram.Socket.prototype.send = refuse('udp send');
dgram.Socket.prototype.connect = refuse('udp connect');
for (const name of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt', 'reverse']) {
  dns[name] = refuse(`dns ${name}`);
  dns.promises[name] = refuse(`dns ${name}`);
}
if (typeof globalThis.fetch === 'function') globalThis.fetch = refuse('fetch');
write('loaded: network functions refused in this process');
