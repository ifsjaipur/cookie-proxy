#!/usr/bin/env node
import { revokeKey } from '../src/db.js';

const [, , target] = process.argv;
if (!target) {
  console.error('Usage: cp-revoke-key <id-or-prefix>');
  process.exit(1);
}

const changed = revokeKey(target);
if (changed) console.log(`Revoked ${changed} key.`);
else console.log('No active key matched that id/prefix.');
