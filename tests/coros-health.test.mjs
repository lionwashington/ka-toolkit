import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Encoder, Profile } from '../kb/skills/coros-health/node_modules/@garmin/fitsdk/src/index.js';
import {
  calculateSegments, compareLatest, fetchFitForActivity, inspectFitBuffer,
  migrate, rebuild, resolvePaths, sync, validate,
} from '../kb/skills/coros-health/scripts/coros-health.mjs';

function makeFit({ start = '2026-01-20T00:00:00Z', device = 'PACE 4', finish = 330 } = {}) {
  const encoder = new Encoder();
  const begin = new Date(start);
  encoder.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'development', product: 1, timeCreated: begin });
  const times = [560, 560, 560, 560, 560, finish];
  const hrs = [128, 129, 130, 129, 129, 157];
  let offset = 0;
  for (let i = 0; i < times.length; i += 1) {
    const lapStart = new Date(begin.valueOf() + offset * 1000);
    offset += times[i];
    encoder.onMesg(Profile.MesgNum.LAP, {
      startTime: lapStart, timestamp: new Date(begin.valueOf() + offset * 1000),
      totalElapsedTime: times[i] + (i === 5 ? 2 : 0), totalTimerTime: times[i], totalDistance: 1000,
      avgHeartRate: hrs[i], maxHeartRate: i === 5 ? 173 : hrs[i] + 8,
      avgCadence: i === 5 ? 97 : 84, maxSpeed: i === 5 ? 4.5 : 2.2,
    });
  }
  encoder.onMesg(Profile.MesgNum.SESSION, {
    startTime: begin, timestamp: new Date(begin.valueOf() + offset * 1000), sport: 'running',
    totalElapsedTime: offset + 10, totalTimerTime: offset, totalDistance: 6014,
    avgHeartRate: 132, maxHeartRate: 173, avgCadence: 86, totalCalories: 420,
  });
  encoder.onMesg(Profile.MesgNum.ACTIVITY, { timestamp: new Date(begin.valueOf() + offset * 1000), totalTimerTime: offset, numSessions: 1, type: 'manual' });
  return Buffer.from(encoder.close());
}

function fixture(root, rows) {
  const paths = resolvePaths({ workspace: root, dataRoot: join(root, 'data') });
  mkdirSync(join(paths.root, 'raw', 'fit'), { recursive: true });
  mkdirSync(join(paths.root, 'state'), { recursive: true });
  writeFileSync(paths.activities, `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(paths.annotations, '{}\n');
  for (const row of rows) writeFileSync(join(paths.fitDir, `${row.labelId}.fit`), makeFit({ start: `${String(row.date).slice(0, 4)}-${String(row.date).slice(4, 6)}-${String(row.date).slice(6, 8)}T00:00:00Z` }));
  return paths;
}

test('validates FIT signature, declared length and CRC; rejects link JSON', () => {
  const valid = makeFit();
  assert.equal(inspectFitBuffer(valid).valid, true);
  const pseudo = Buffer.from(JSON.stringify({ data: { fileUrl: 'https://example.invalid/a.fit' } }));
  assert.equal(inspectFitBuffer(pseudo).valid, false);
  const damaged = Buffer.from(valid);
  damaged[damaged.length - 1] ^= 0xff;
  assert.equal(inspectFitBuffer(damaged).reason, 'crc_or_integrity_failed');
});

test('follows COROS JSON fileUrl before accepting binary FIT', async () => {
  const valid = makeFit();
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response(JSON.stringify({ data: { fileUrl: 'https://download.invalid/real.fit' } }), { headers: { 'content-type': 'application/json' } });
    return new Response(valid, { headers: { 'content-type': 'application/octet-stream' } });
  };
  const got = await fetchFitForActivity({ apiUrl: 'https://api.invalid' }, 'private-token', { labelId: 'activity-1', sportType: 100 }, fakeFetch);
  assert.equal(calls.length, 2);
  assert.equal(inspectFitBuffer(got).valid, true);
});

test('calculates first-five EF separately from sixth-lap finish', () => {
  const times = [550, 560, 570, 560, 560, 330];
  const hrs = [127, 128, 130, 129, 131, 157];
  const laps = times.map((time, i) => ({ lap_index: i + 1, complete_km: true, distance_m: 1000, timer_time_s: time, elapsed_time_s: time + 2, pace_s_per_km: time, avg_hr: hrs[i], max_hr: hrs[i] + 8, avg_cadence_spm: i === 5 ? 194 : 170, max_speed_mps: i === 5 ? 4.6 : 2.2 }));
  const result = calculateSegments(laps, 6014);
  const expectedHr = times.slice(0, 5).reduce((sum, t, i) => sum + t * hrs[i], 0) / 2800;
  assert.equal(result.steady_5k.timer_time_s, 2800);
  assert.ok(Math.abs(result.steady_5k.avg_hr - expectedHr) < 1e-12);
  assert.ok(Math.abs(result.steady_5k.ef - (((5000 / 2800) * 60) / expectedHr)) < 1e-12);
  assert.equal(result.finish_1k.timer_time_s, 330);
  assert.equal(result.finish_1k.avg_hr, 157);
  assert.equal(result.finish_1k.classification, 'inferred');
  const user = calculateSegments(laps, 6014, { finish_1k: '爽跑' });
  assert.equal(user.finish_1k.classification, 'user');
});

test('rebuild is deterministic and compare groups PACE 2/PACE 4', () => {
  const root = mkdtempSync(join(tmpdir(), 'coros-health-'));
  const rows = [
    { labelId: 'a1', date: 20260101, name: 'Run', sportType: 100, device: 'COROS PACE 2', distance: 6014 },
    { labelId: 'a2', date: 20260115, name: 'Run', sportType: 100, device: 'PACE_4', distance: 6014 },
    { labelId: 'a3', date: 20260120, name: 'Run', sportType: 100, device: 'COROS PACE 4', distance: 6014 },
  ];
  const paths = fixture(root, rows);
  const first = rebuild(paths);
  const hashes = [paths.activitiesJsonl, paths.runningCsv, paths.splitsCsv].map((p) => createHash('sha256').update(readFileSync(p)).digest('hex'));
  const second = rebuild(paths);
  const hashes2 = [paths.activitiesJsonl, paths.runningCsv, paths.splitsCsv].map((p) => createHash('sha256').update(readFileSync(p)).digest('hex'));
  assert.deepEqual(first, second);
  assert.deepEqual(hashes, hashes2);
  const comparison = compareLatest(paths);
  assert.equal(comparison.ok, true);
  assert.ok(comparison.device_groups['PACE 2']);
  assert.ok(comparison.device_groups['PACE 4']);
  assert.equal(comparison.comparisons.recent_60d.count, 2);
  assert.equal(comparison.comparisons.same_device.count, 1);
});

test('migration preserves 142-byte pseudo-FIT and does not import it', () => {
  const root = mkdtempSync(join(tmpdir(), 'coros-health-migrate-'));
  const legacy = join(root, 'legacy');
  mkdirSync(legacy);
  const row = { labelId: 'legacy-1', date: 20260101, name: 'Run', sportType: 100 };
  writeFileSync(join(legacy, 'activities.json'), JSON.stringify([row]));
  writeFileSync(join(legacy, '20260101_Run_legacy-1.fit'), JSON.stringify({ data: { fileUrl: 'x'.repeat(112) } }).padEnd(142));
  const paths = resolvePaths({ workspace: root, dataRoot: join(root, 'data') });
  const result = migrate(paths, legacy);
  assert.equal(result.invalid_legacy_fit, 1);
  assert.equal(result.copied_valid_fit, 0);
  assert.equal(result.source_preserved, true);
  assert.equal(validate(paths).invalid_fit_count, 1);
});

test('offline sync keeps local cache analyzable and reports failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coros-health-offline-'));
  const paths = fixture(root, [{ labelId: 'cached-1', date: 20260120, name: 'Run', sportType: 100, device: 'PACE 4', distance: 6014 }]);
  const result = await sync(paths, { credentials: {} });
  assert.equal(result.remote.status, 'failed');
  assert.match(result.remote.error, /credentials unavailable/);
  assert.equal(result.rebuild.parsed, 1);
  assert.equal(compareLatest(paths).ok, true);
  const repeated = await sync(paths, { credentials: {} });
  assert.equal(repeated.remote.status, 'failed');
  assert.equal(repeated.fit_downloaded, 0);
  assert.equal(repeated.rebuild.skipped, true);
});

test('refuses to place private health data inside the public source repository', () => {
  const repo = join(import.meta.dirname, '..');
  assert.throws(
    () => resolvePaths({ workspace: repo }),
    /refusing COROS data root inside the skill source repository/,
  );
});

test('emits JSON when invoked through Codex and Claude discovery symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'coros-health-discovery-'));
  const paths = fixture(root, [{ labelId: 'cached-1', date: 20260120, name: 'Run', sportType: 100, device: 'PACE 4', distance: 6014 }]);
  rebuild(paths);
  const skillSource = join(import.meta.dirname, '..', 'kb', 'skills', 'coros-health');

  for (const discovery of ['.codex', '.claude']) {
    const skillsDir = join(root, discovery, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const skillLink = join(skillsDir, 'coros-health');
    symlinkSync(skillSource, skillLink, 'dir');
    const result = spawnSync(process.execPath, [
      join(skillLink, 'scripts', 'coros-health.mjs'),
      'validate', '--workspace', root, '--data-root', paths.root,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim(), `${discovery} discovery invocation produced no stdout`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.valid_fit_count, 1);
    assert.equal(output.invalid_fit_count, 0);
  }
});
