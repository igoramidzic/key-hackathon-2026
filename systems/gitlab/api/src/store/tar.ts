import { gzipSync } from 'node:zlib';

const BLOCK = 512;

function writeString(buf: Buffer, offset: number, length: number, value: string) {
  buf.write(value.slice(0, length), offset, length, 'utf8');
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number) {
  // length includes the trailing NUL
  buf.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

/** Splits a long path into ustar `prefix` (≤155) + `name` (≤100) at a slash. */
function splitPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Path too long for tar: ${path}`);
}

function header(path: string, size: number, mtime: number, type: '0' | '5'): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitPath(path);
  writeString(buf, 0, 100, name);
  writeOctal(buf, 100, 8, type === '5' ? 0o755 : 0o644);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, Math.floor(mtime / 1000));
  buf.fill(' ', 148, 156); // checksum placeholder
  buf.write(type, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  writeString(buf, 265, 32, 'git');
  writeString(buf, 297, 32, 'git');
  writeString(buf, 345, 155, prefix);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i]!;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return buf;
}

/** A real gzipped ustar archive of `files`, all under the top-level directory `root`. */
export function createTarGz(
  root: string,
  files: { path: string; content: string }[],
  mtime: number,
): Buffer {
  const chunks: Buffer[] = [header(`${root}/`, 0, mtime, '5')];
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      chunks.push(header(`${root}/${dir}/`, 0, mtime, '5'));
    }
    const body = Buffer.from(file.content, 'utf8');
    chunks.push(header(`${root}/${file.path}`, body.length, mtime, '0'));
    chunks.push(body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(chunks));
}
