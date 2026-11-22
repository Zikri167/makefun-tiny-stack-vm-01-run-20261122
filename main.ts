// Tiny stack VM for make.fun's ISA: runs program.bin on input.bin, answers
// with the bytes written and the exit code. Node stdlib only, deterministic.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Opcode metadata, packed as "op imm pops pushes" (op in hex); 38 opcodes.
const SPEC = '00 0 0 0 01 1 0 1 02 4 0 1 03 0 1 0 04 0 1 2 05 0 2 2 06 0 2 3 07 0 3 3 '
  + '10 0 2 1 11 0 2 1 12 0 2 1 13 0 2 1 14 0 2 1 15 0 2 1 16 0 2 1 17 0 1 1 18 0 2 1 '
  + '19 0 2 1 1a 0 2 1 1b 0 1 1 1c 0 2 1 1d 0 2 1 1e 0 2 1 20 0 2 1 21 0 2 1 22 0 2 1 '
  + '30 2 0 0 31 2 1 0 32 2 1 0 33 2 0 0 34 0 0 0 40 0 1 1 41 0 2 0 50 0 1 0 51 0 1 0 52 0 0 1 53 0 1 0';
const known = new Uint8Array(256);
const immOf = new Uint8Array(256);
const popOf = new Uint8Array(256);
const pshOf = new Uint8Array(256);
{
  const f = SPEC.split(' ');
  for (let i = 0; i < f.length; i += 4) {
    const o = parseInt(f[i], 16);
    known[o] = 1;
    immOf[o] = +f[i + 1];
    popOf[o] = +f[i + 2];
    pshOf[o] = +f[i + 3];
  }
}

const STEP_MAX = 1000000;
const OUT_MAX = 65536;

// Runs one program on its input bytes. Returns the bytes it wrote and its
// exit code (a trap's code included; output written before a trap is kept).
function run(prog: Uint8Array, input: Uint8Array): { out: Uint8Array; code: number } {
  const st = new Int32Array(256);
  let sp = 0;
  const cs = new Int32Array(64);
  let cp = 0;
  const mem = new Int32Array(256);
  const out = new Uint8Array(OUT_MAX);
  let olen = 0;
  let ip = 0;
  let pc = 0;
  let steps = 0;
  const n = prog.length;
  const enc = new TextEncoder();
  const done = (code: number) => ({ out: out.slice(0, olen), code });
  for (;;) {
    if (steps === STEP_MAX) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const op = prog[pc];
    if (!known[op]) return done(5);
    const im = immOf[op];
    if (pc + im >= n) return done(9);
    steps++;
    const nx = pc + 1 + im;
    if (sp < popOf[op]) return done(2);
    if (sp - popOf[op] + pshOf[op] > 256) return done(3);
    pc = nx;
    switch (op) {
      case 0x00:
        return done(0);
      case 0x01:
        st[sp++] = (prog[nx - 1] << 24) >> 24;
        break;
      case 0x02:
        st[sp++] = prog[nx - 4] | (prog[nx - 3] << 8) | (prog[nx - 2] << 16) | (prog[nx - 1] << 24);
        break;
      case 0x03:
        sp--;
        break;
      case 0x04:
        st[sp] = st[sp - 1];
        sp++;
        break;
      case 0x05: {
        const t = st[sp - 1];
        st[sp - 1] = st[sp - 2];
        st[sp - 2] = t;
        break;
      }
      case 0x06:
        st[sp] = st[sp - 2];
        sp++;
        break;
      case 0x07: {
        const a = st[sp - 3];
        st[sp - 3] = st[sp - 2];
        st[sp - 2] = st[sp - 1];
        st[sp - 1] = a;
        break;
      }
      case 0x17:
        st[sp - 1] = (-st[sp - 1]) | 0;
        break;
      case 0x1b:
        st[sp - 1] = ~st[sp - 1];
        break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = st[sp - 1];
        const a = st[sp - 2];
        let r: number;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) {
          if (b === 0) return done(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 0x14) {
          if (b === 0) return done(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 0x15) {
          if (b === 0) return done(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) {
          if (b === 0) return done(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        sp -= 2;
        st[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: {
        const rel = ((prog[nx - 2] | (prog[nx - 1] << 8)) << 16) >> 16;
        let take = op === 0x30;
        if (op !== 0x30) {
          const v = st[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = nx + rel;
        break;
      }
      case 0x33: {
        if (cp === 64) return done(7);
        cs[cp++] = nx;
        pc = prog[nx - 2] | (prog[nx - 1] << 8);
        break;
      }
      case 0x34: {
        if (cp === 0) return done(8);
        pc = cs[--cp];
        break;
      }
      case 0x40: {
        const addr = st[sp - 1];
        if (addr < 0 || addr >= 256) return done(6);
        st[sp - 1] = mem[addr];
        break;
      }
      case 0x41: {
        const addr = st[sp - 1];
        const v = st[sp - 2];
        if (addr < 0 || addr >= 256) return done(6);
        sp -= 2;
        mem[addr] = v;
        break;
      }
      case 0x50: {
        const bytes = enc.encode(String(st[sp - 1]));
        if (olen + bytes.length > OUT_MAX) return done(11);
        sp--;
        out.set(bytes, olen);
        olen += bytes.length;
        break;
      }
      case 0x51: {
        if (olen + 1 > OUT_MAX) return done(11);
        out[olen++] = st[--sp] & 255;
        break;
      }
      case 0x52:
        st[sp++] = ip < input.length ? input[ip++] : -1;
        break;
      case 0x53:
        return done(st[--sp] & 255);
      default:
        return done(5);
    }
  }
}

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(IN_DIR).sort()) {
  const r = run(
    new Uint8Array(readFileSync(join(IN_DIR, id, 'program.bin'))),
    new Uint8Array(readFileSync(join(IN_DIR, id, 'input.bin'))),
  );
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'stdout.bin'), r.out);
  writeFileSync(join(OUT_DIR, id, 'exit.txt'), String(r.code) + '\n');
}
