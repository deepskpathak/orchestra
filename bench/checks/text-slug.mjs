import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { slugify, capitalize } = await import(pathToFileURL(`${process.cwd()}/src/text.js`).href);
assert.equal(slugify('Hello, World!'), 'hello-world');
assert.equal(slugify('  Many   spaces  '), 'many-spaces');
assert.equal(capitalize('abc'), 'Abc');
