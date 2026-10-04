#!/usr/bin/env node
// Release gate: npm can accept a publish minutes before installs can resolve
// it. Publishing a dependent in that window leaves `npm install ordewell`
// failing with ETARGET for everyone until the dependency shows up (0.6.3 hit
// this for ~7 minutes), so each publish waits for the one it depends on.
'use strict';

const [name, version] = process.argv.slice(2);
if (!name || !version) {
  console.error('usage: wait-for-npm.mjs <package> <version>');
  process.exit(1);
}

const POLL_MS = 15_000;
const TIMEOUT_MS = 30 * 60_000;

// The abbreviated packument is what `npm install` reads, so asking for it
// (without a cache-busting query) sees the registry the way an install does.
const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`;

async function resolvable() {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) return false;
    const doc = await res.json();
    return Boolean(doc.versions?.[version]);
  } catch {
    return false;
  }
}

const deadline = Date.now() + TIMEOUT_MS;
while (!(await resolvable())) {
  if (Date.now() > deadline) {
    console.error(`${name}@${version} still not resolvable after ${TIMEOUT_MS / 60_000} minutes.`);
    process.exit(1);
  }
  console.log(`Waiting for ${name}@${version} to resolve on the registry…`);
  await new Promise((r) => setTimeout(r, POLL_MS));
}

console.log(`${name}@${version} resolves on the registry.`);
