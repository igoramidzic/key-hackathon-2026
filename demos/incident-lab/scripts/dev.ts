import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const frontend = await createServer();
await frontend.listen();
frontend.printUrls();
const backend = spawn(process.execPath, ['--watch', '--import', 'tsx', 'server.ts'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: '4311' },
});
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  backend.kill('SIGTERM');
  await frontend.close();
  process.exit(code);
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
backend.on('error', (error) => {
  console.error('Unable to start the simulation server:', error.message);
  void close(1);
});
backend.on('exit', (code) => {
  if (!closing) void close(code ?? 1);
});
