import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Encoder, Profile } from '../kb/skills/coros-health/node_modules/@garmin/fitsdk/src/index.js';
import {
  calculateSegments, compareLatest, fetchFitForActivity, inspectFitBuffer,
  migrate, rebuild, resolvePaths, sync, validate,
} from '../kb/skills/coros-health/scripts/coros-health.mjs';
import {
  argumentsForTool, normalizeObservations, rebuildWellness, selectWellnessTools,
  syncWellness, validateWellness, wellnessPaths, wellnessTrend,
} from '../kb/skills/coros-health/scripts/coros-wellness.mjs';

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

function wellnessProvider({ fail = false } = {}) {
  const tools = [
    { name: 'queryHrvAssessment', description: 'Query HRV', inputSchema: { properties: { startDate: {}, endDate: {} } } },
    { name: 'querySleepData', description: 'Query sleep', inputSchema: { properties: { startDay: {}, endDay: {} } } },
    { name: 'queryRestingHeartRate', description: 'Resting heart rate', inputSchema: { properties: { days: {} } } },
    { name: 'queryStressLevel', description: 'Stress time series', inputSchema: { properties: { start_date: {}, end_date: {} } } },
    { name: 'queryRecoveryStatus', description: 'Recovery status', inputSchema: { properties: {} } },
  ];
  return {
    async listTools() {
      if (fail) throw new Error('network unavailable');
      return tools;
    },
    async callTool(name) {
      return {
        access_token: 'must-not-be-persisted',
        content: [{ type: 'text', text: JSON.stringify({ records: [
          { date: '20260120', hrv: name.includes('Hrv') ? 48 : undefined, totalSleepMinutes: name.includes('Sleep') ? 430 : undefined,
            restingHeartRate: name.includes('Resting') ? 49 : undefined, stressLevel: name.includes('Stress') ? 31 : undefined,
            recoveryScore: name.includes('Recovery') ? 82 : undefined },
          { date: '2026-01-21T00:30:00+08:00', hrv: name.includes('Hrv') ? 52 : undefined, totalSleepMinutes: name.includes('Sleep') ? 445 : undefined,
            restingHeartRate: name.includes('Resting') ? 48 : undefined, stressLevel: name.includes('Stress') ? 29 : undefined,
            recoveryScore: name.includes('Recovery') ? 86 : undefined },
        ] }) }],
      };
    },
  };
}

test('official tool discovery and arguments cover health and date-range schemas', () => {
  const selected = selectWellnessTools([
    { name: 'queryHrvAssessment', description: '' },
    { name: 'querySleepData', description: '' },
    { name: 'queryRestingHeartRate', description: '' },
    { name: 'queryStressLevel', description: '' },
    { name: 'queryRecoveryStatus', description: '' },
  ]);
  assert.deepEqual(selected.map((row) => row.kind), ['hrv', 'sleep', 'resting_heart_rate', 'stress', 'recovery']);
  assert.deepEqual(argumentsForTool({ inputSchema: { properties: { startDay: {}, endDay: {}, days: {} } } }, '2026-01-20', '2026-01-21'), {
    startDay: '20260120', endDay: '20260121', days: 2,
  });
  assert.deepEqual(argumentsForTool({ inputSchema: { properties: { startDate: {}, endDate: {}, days: {} } } }, '2026-01-20', '2026-01-21'), {
    startDate: '20260120', endDate: '20260121', days: 2,
  });
  assert.equal(argumentsForTool({ inputSchema: { properties: { days: { description: 'default 7 and maximum 7' } } } }, '2026-01-01', '2026-01-21').days, 7);
});

test('normalizes current official MCP JSON-encoded text responses', () => {
  const observations = [
    { kind: 'hrv', tool: 'querySleepHrv', range: { end_date: '2026-01-21' }, payload: { content: [{ type: 'text', text: JSON.stringify('2026-01-21:\nHRV Avg: 52 ms\nBaseline: 49 ms') }] } },
    { kind: 'sleep', tool: 'querySleepData', range: { end_date: '2026-01-21' }, payload: { content: [{ type: 'text', text: JSON.stringify('2026-01-21\nSleep Score: 87\nMain Sleep: 7h 25m\nAwake Time: 15 min') }] } },
    { kind: 'resting_heart_rate', tool: 'queryRestingHeartRate', range: { end_date: '2026-01-21' }, payload: { content: [{ type: 'text', text: JSON.stringify('2026-01-21: 48 bpm') }] } },
    { kind: 'recovery', tool: 'queryRecoveryStatus', range: { end_date: '2026-01-21' }, payload: { content: [{ type: 'text', text: JSON.stringify('Recovery Status\nRecovery: 82%') }] } },
  ];
  const [row] = normalizeObservations(observations);
  assert.equal(row.date, '2026-01-21');
  assert.equal(row.hrv_ms, 52);
  assert.equal(row.hrv_baseline_ms, 49);
  assert.equal(row.sleep_minutes, 445);
  assert.equal(row.sleep_score, 87);
  assert.equal(row.awake_minutes, 15);
  assert.equal(row.resting_hr_bpm, 48);
  assert.equal(row.recovery, 82);
});

test('wellness sync is incremental, idempotent and strips OAuth secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coros-wellness-'));
  const paths = fixture(root, [{ labelId: 'run-1', date: 20260120, name: 'Run', sportType: 100, trainingLoad: 60 }]);
  rebuild(paths);
  const options = { provider: wellnessProvider(), startDate: '2026-01-20', endDate: '2026-01-21' };
  const first = await syncWellness(paths, options);
  assert.equal(first.remote.status, 'ok');
  assert.equal(first.data_through, '2026-01-21');
  const wp = wellnessPaths(paths);
  const rawHash = createHash('sha256').update(readFileSync(wp.raw)).digest('hex');
  const second = await syncWellness(paths, options);
  assert.equal(second.remote.status, 'ok');
  assert.equal(second.observations_new, 0);
  assert.equal(second.daily_changed, false);
  assert.equal(createHash('sha256').update(readFileSync(wp.raw)).digest('hex'), rawHash);
  assert.doesNotMatch(readFileSync(wp.raw, 'utf8'), /must-not-be-persisted|access_token/);
  assert.deepEqual(validateWellness(paths).sensitive_key_hits, []);
  const daily = readFileSync(wp.daily, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(daily[0].local_activity_training_load, 60);
  const trend = wellnessTrend(paths);
  assert.equal(trend.source, 'local_cache');
  assert.equal(trend.latest.local_activity_training_load, null);
});

test('wellness normalization respects source dates and offline fallback keeps cache', async () => {
  const rows = normalizeObservations([{ kind: 'hrv', tool: 'queryHrvAssessment', payload: { records: [
    { date: 20260131, hrv: 41 },
    { date: '2026-02-01T00:05:00+08:00', hrv: 44 },
  ] } }]);
  assert.deepEqual(rows.map((row) => row.date), ['2026-01-31', '2026-02-01']);
  const root = mkdtempSync(join(tmpdir(), 'coros-wellness-offline-'));
  const paths = fixture(root, []);
  await syncWellness(paths, { provider: wellnessProvider(), startDate: '2026-01-20', endDate: '2026-01-21' });
  const failed = await syncWellness(paths, { provider: wellnessProvider({ fail: true }), startDate: '2026-01-21', endDate: '2026-01-22' });
  assert.equal(failed.remote.status, 'failed');
  assert.match(failed.remote.error, /network unavailable/);
  assert.equal(wellnessTrend(paths).data_through, '2026-01-21');
  const wp = wellnessPaths(paths);
  rmSync(wp.daily);
  const rebuilt = rebuildWellness(paths);
  assert.equal(rebuilt.daily_count, 2);
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

    const trend = spawnSync(process.execPath, [
      join(skillLink, 'scripts', 'coros-health.mjs'),
      'wellness-trend', '--workspace', root, '--data-root', paths.root,
    ], { encoding: 'utf8' });
    assert.equal(trend.status, 0, trend.stderr);
    assert.equal(JSON.parse(trend.stdout).source, 'local_cache');
  }
});
