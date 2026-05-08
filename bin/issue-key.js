#!/usr/bin/env node
import { issueKey } from '../src/db.js';

const [, , label, rateArg] = process.argv;

if (!label) {
  console.error('Usage: cp-issue-key <label> [rate-per-minute]');
  console.error('Example: cp-issue-key sachin 60');
  process.exit(1);
}

const rate = rateArg ? Number(rateArg) : 60;
const key = issueKey(label, rate);

console.log('\nAPI key issued.');
console.log('  label:      ' + label);
console.log('  rate/min:   ' + rate);
console.log('  key:        ' + key);
console.log('\nStore this key now — it is not recoverable. Hand it to the user as:');
console.log('  Authorization: Bearer ' + key + '\n');
