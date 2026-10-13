// Read an strace -f log (execve, clone, clone3, fork, vfork, connect) and say
// which program made each connection of the internet families.
//   node trace-summary.mjs STRACE_LOG
import fs from 'node:fs';

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const program = new Map();   // pid -> program it executed
const parent = new Map();    // pid -> pid that created it
const pending = new Map();   // pid -> unfinished call
for (let line of lines) {
  const head = line.match(/^(\d+)\s+(.*)$/);
  if (!head) continue;
  const pid = head[1];
  let rest = head[2];
  // strace splits a call that another process interrupted in two lines.
  if (/<unfinished \.\.\.>$/.test(rest)) { pending.set(pid, rest.replace(/\s*<unfinished \.\.\.>$/, '')); continue; }
  const resumed = rest.match(/^<\.\.\. \w+ resumed>(.*)$/);
  if (resumed) { rest = (pending.get(pid) || '') + resumed[1]; pending.delete(pid); }
  const exec = rest.match(/^execve\("([^"]+)"/);
  if (exec && !/= -1 /.test(rest)) { program.set(pid, exec[1]); continue; }
  const made = rest.match(/^(?:clone3?|fork|vfork)\(.*\) = (\d+)$/);
  if (made) parent.set(made[1], pid);
}
// A program that starts a copy of itself does so as /proc/self/exe; name the
// program it is a copy of.
const programOf = pid => {
  let copy = false;
  for (let current = pid, steps = 0; current && steps < 50; current = parent.get(current), steps++) {
    const name = program.get(current);
    if (name === '/proc/self/exe') { copy = true; continue; }
    if (name) return copy ? `${name} (a child process of it)` : name;
  }
  return '(unknown)';
};
const counts = new Map();
const pendingConnect = new Map();
for (const line of lines) {
  const head = line.match(/^(\d+)\s+(.*)$/);
  if (!head) continue;
  const [, pid, rest] = head;
  const call = rest.match(/^connect\(\d+, \{sa_family=(AF_INET6?), (.*?)\}/);
  if (!call) continue;
  const key = `${line}`;
  if (pendingConnect.has(key)) continue;
  const address = call[2].match(/inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)"/);
  const port = call[2].match(/sin6?_port=htons\((\d+)\)/);
  // A call split in two lines is counted once: only its first line carries the address.
  const where = `${address ? address[1] || address[2] : '?'} port ${port ? port[1] : '?'}`;
  const who = `${programOf(pid)}  ->  ${where}`;
  counts.set(who, (counts.get(who) || 0) + 1);
}
console.log('Programs started:');
for (const name of [...new Set(program.values())].sort()) console.log(`  ${name}`);
console.log('Connections of the internet families (AF_INET, AF_INET6), by program:');
if (!counts.size) console.log('  none');
for (const [who, count] of [...counts].sort()) console.log(`  ${count} x ${who}`);
const fromNode = [...counts.keys()].filter(who => /\/node\s/.test(who));
console.log(fromNode.length ? `Node.js (installer or server) made ${fromNode.length} kind(s) of connection.` : 'Node.js (the installer and the server it started) made none.');
