#!/usr/bin/env node
import { listKeys } from '../src/db.js';

const rows = listKeys();
if (!rows.length) {
  console.log('No keys issued yet.');
  process.exit(0);
}

console.log(
  ['id', 'label', 'prefix', 'rate', 'uses', 'last_used', 'status'].join('\t')
);
for (const r of rows) {
  console.log(
    [
      r.id,
      r.label,
      r.key_prefix,
      r.rate_limit,
      r.use_count,
      r.last_used || '—',
      r.revoked_at ? 'REVOKED' : 'active',
    ].join('\t')
  );
}
