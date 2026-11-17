#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PAGE_SIZE = 64 * 1024;

function readUleb(bytes, state) {
  let value = 0n;
  let shift = 0n;
  while (state.offset < bytes.length) {
    const byte = bytes[state.offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
    if (shift > 70n) throw new Error('Invalid LEB128 integer');
  }
  throw new Error('Unexpected end of WebAssembly binary');
}

function readString(bytes, state) {
  const length = Number(readUleb(bytes, state));
  const end = state.offset + length;
  if (end > bytes.length) throw new Error('Invalid WebAssembly string');
  const value = new TextDecoder().decode(bytes.subarray(state.offset, end));
  state.offset = end;
  return value;
}

function readLimits(bytes, state) {
  const flags = Number(readUleb(bytes, state));
  const minimumPages = readUleb(bytes, state);
  const maximumPages = (flags & 0x01) !== 0 ? readUleb(bytes, state) : null;
  return {
    minimumPages,
    maximumPages,
    shared: (flags & 0x02) !== 0,
    memory64: (flags & 0x04) !== 0
  };
}

function skipTableType(bytes, state) {
  state.offset++; // element reference type
  readLimits(bytes, state);
}

function readMemoryLimits(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 8 || bytes.subarray(0, 4).toString('hex') !== '0061736d') {
    throw new Error('Not a WebAssembly binary');
  }

  const memories = [];
  let offset = 8;
  while (offset < bytes.length) {
    const sectionId = bytes[offset++];
    const state = { offset };
    const sectionSize = Number(readUleb(bytes, state));
    const sectionEnd = state.offset + sectionSize;
    if (sectionEnd > bytes.length) throw new Error('Invalid WebAssembly section');
    const section = bytes.subarray(state.offset, sectionEnd);
    const cursor = { offset: 0 };

    if (sectionId === 2) {
      const count = Number(readUleb(section, cursor));
      for (let index = 0; index < count; index++) {
        readString(section, cursor);
        readString(section, cursor);
        const kind = section[cursor.offset++];
        if (kind === 0) {
          readUleb(section, cursor);
        } else if (kind === 1) {
          skipTableType(section, cursor);
        } else if (kind === 2) {
          memories.push({ source: 'import', ...readLimits(section, cursor) });
        } else if (kind === 3) {
          cursor.offset += 2; // value type and mutability
        } else if (kind === 4) {
          readUleb(section, cursor);
          readUleb(section, cursor);
        } else {
          throw new Error(`Unknown WebAssembly import kind: ${kind}`);
        }
      }
    } else if (sectionId === 5) {
      const count = Number(readUleb(section, cursor));
      for (let index = 0; index < count; index++) {
        memories.push({ source: 'defined', ...readLimits(section, cursor) });
      }
    }

    offset = sectionEnd;
  }

  if (memories.length === 0) throw new Error('No memory section or imported memory found');
  return memories.map(memory => ({
    source: memory.source,
    minimumMiB: Number(memory.minimumPages * BigInt(PAGE_SIZE)) / (1024 * 1024),
    maximumMiB: memory.maximumPages === null
      ? null
      : Number(memory.maximumPages * BigInt(PAGE_SIZE)) / (1024 * 1024),
    shared: memory.shared,
    memory64: memory.memory64,
    maximumPagesDeclared: memory.maximumPages !== null
  }));
}

const modules = [
  ['wasm-vips', path.join(__dirname, '..', 'node_modules', 'wasm-vips', 'lib', 'vips.wasm')],
  ['@colorhythm/libraw-wasm', path.join(__dirname, '..', 'node_modules', '@colorhythm', 'libraw-wasm', 'dist', 'libraw.wasm')]
];

let failed = false;
for (const [name, filePath] of modules) {
  if (!fs.existsSync(filePath)) {
    console.error(`[WasmMemory] ${name}: not found at ${filePath}`);
    failed = true;
    continue;
  }
  try {
    const memories = readMemoryLimits(filePath);
    console.log(`[WasmMemory] ${name}: ${JSON.stringify(memories)}`);
  } catch (error) {
    console.error(`[WasmMemory] ${name}: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
