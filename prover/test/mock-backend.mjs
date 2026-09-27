// A stand-in for starknet_transaction_prover, run as a gateway worker in tests.
// Listens on PROVER_PORT. The transaction's first calldata felt picks what a
// proof does: 0x1 answers, 0x2 hangs, 0x3 exits mid-job, 0x4 allocates memory
// until it is killed, 0x5 starts a child process (its pid written to
// $MOCK_PID_DIR/child) and hangs, 0x6 answers after 300 ms. Answers carry the
// worker's pid (as the proof) and its PROVER_*, MALLOC_* and MAX_CONCURRENT_*
// environment.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PROVER_|MALLOC_|MAX_CONCURRENT)/.test(k)));
const hold = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const q = JSON.parse(body);
  const reply = answer => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, ...answer })); };
  const proof = () => reply({ result: { proof: String(process.pid), proof_facts: ['0x0', '0x0', process.env.MOCK_OS_PROGRAM], l2_to_l1_messages: [], env } });
  if (q.method === 'starknet_specVersion') return reply({ result: '0.10.3-rc.2' });
  switch (q.params.transaction.calldata[0]) {
    case '0x2': return;
    case '0x3': process.exit(3);
    case '0x4': for (;;) { hold.push(Buffer.alloc(64 << 20, 1)); await new Promise(r => setImmediate(r)); }
    case '0x5': writeFileSync(join(process.env.MOCK_PID_DIR, 'child'), String(spawn('sleep', ['600'], { stdio: 'ignore' }).pid)); return;
    case '0x6': setTimeout(proof, 300); return;
    default: return proof();
  }
});
server.listen(Number(process.env.PROVER_PORT), process.env.PROVER_IP);
