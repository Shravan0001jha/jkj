import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanPer } from '../src/services/evidence.js';

// 23 Oct: PER.android = { ..., image: 4, 'image:make': 1 } parsed as [..., 'image', 'image'] (the quoted key was
// split at its colon), so run_evidence(android, image:make) was refused although the branch's plan defines it.
test('quoted plan keys containing ":" are read whole', () => {
  const src = "const PER = {\n  android: { queries: 2, image: 4, 'image:make': 1, \"image:cap_per_tier\": 1 },\n  ios: { queries: 2 },\n};\n";
  const per = parsePlanPer(src)!;
  assert.deepEqual(per.android, ['queries', 'image', 'image:make', 'image:cap_per_tier']);
  assert.deepEqual(per.ios, ['queries']);
});
