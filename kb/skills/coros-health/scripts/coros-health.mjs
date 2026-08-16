#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decoder, Stream } from '@garmin/fitsdk';
import {
  officialOauth, rebuildWellness, syncWellness, validateWellness, wellnessPaths, wellnessTrend,
} from './coros-wellness.mjs';

export const SCHEMA_VERSION = 1;
export const ALGORITHM_VERSION = 2;
const DEFAULT_API_URL = 'https://teamcnapi.coros.com';
const MIN_FIT_BYTES = 64;
const FULL_KM_MIN_M = 950;
const FULL_KM_MAX_M = 1050;
const SKILL_SOURCE_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function isWithin(path, parent) {
  const rel = relative(parent, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertPrivateDataRoot(root) {
  // In a source checkout, never let a convenient cwd default place personal
  // health data under the public code repository. The deployed runtime is not a
  // git checkout, so personal workspaces and explicit external data roots work.
  if (existsSync(join(SKILL_SOURCE_REPO, '.git')) && isWithin(root, SKILL_SOURCE_REPO)) {
    throw new Error('refusing COROS data root inside the skill source repository; run from the private workspace or set COROS_DATA_ROOT outside it');
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) out._.push(arg);
    else if (['--repair', '--json', '--refresh-tools', '--fit-only', '--wellness-only'].includes(arg)) out[arg.slice(2)] = true;
    else {
      const [key, inline] = arg.slice(2).split('=', 2);
      out[key] = inline ?? argv[++i];
    }
  }
  return out;
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function findWorkspace(start = process.cwd()) {
  if (process.env.COROS_WORKSPACE_ROOT) return resolve(process.env.COROS_WORKSPACE_ROOT);
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'AGENTS.md')) || existsSync(join(current, 'memory'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(start);
}

export function resolvePaths(options = {}) {
  const workspace = resolve(options.workspace || findWorkspace());
  const root = resolve(options.dataRoot || process.env.COROS_DATA_ROOT || join(workspace, 'data', 'health', 'coros'));
  assertPrivateDataRoot(root);
  return {
    workspace, root,
    activities: join(root, 'raw', 'activities.json'),
    fitDir: join(root, 'raw', 'fit'),
    activitiesJsonl: join(root, 'derived', 'activities.jsonl'),
    runningCsv: join(root, 'derived', 'running.csv'),
    splitsCsv: join(root, 'derived', 'running-splits.csv'),
    baselines: join(root, 'derived', 'baselines.json'),
    state: join(root, 'state', 'sync-state.json'),
    annotations: join(root, 'state', 'annotations.json'),
    readme: join(root, 'README.md'),
  };
}

function ensureLayout(paths) {
  for (const dir of [join(paths.root, 'raw'), paths.fitDir, join(paths.root, 'derived'), join(paths.root, 'state')]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(paths.annotations)) atomicWrite(paths.annotations, '{}\n');
  if (!existsSync(paths.readme)) atomicWrite(paths.readme, [
    '# COROS health data',
    '',
    'This directory contains private local data. Credentials are never stored here.',
    '',
    '- raw/activities.json: merged COROS activity metadata.',
    '- raw/fit/<activity-id>.fit: immutable FIT binaries validated by signature, declared length, CRC and decoder.',
    '- derived/activities.jsonl: normalized activities, one activity per line.',
    '- derived/running.csv: running activity summary.',
    '- derived/running-splits.csv: lap-level running data.',
    '- derived/baselines.json: cached aggregate comparison groups.',
    '- state/sync-state.json: sync watermarks and schema/algorithm versions.',
    '- state/annotations.json: optional user labels keyed by activity ID.',
    '- wellness/: official OAuth MCP health/recovery observations, derived daily trends and an independent sync state.',
    '',
    'Derived files are rebuildable; raw FIT files are not modified by rebuild.',
    '',
    'EF = speed (metres/minute) / average heart rate. First-5-km EF = (5000 / timer_seconds * 60) / time-weighted average HR. Timer time is preferred over elapsed time.',
    'The steady segment uses only the first five complete 1 km laps. The finishing segment uses only the sixth complete 1 km lap.',
    '',
  ].join('\n'));
}

function yamlScalar(text) {
  const s = text.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function readCorosSecrets(path) {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  let inCoros = false;
  let indent = 0;
  const result = {};
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const leading = raw.length - raw.trimStart().length;
    const match = raw.match(/^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!match) continue;
    if (leading === 0) {
      inCoros = match[1] === 'coros';
      indent = inCoros ? leading : 0;
      continue;
    }
    if (inCoros && leading > indent && ['api_url', 'email', 'password'].includes(match[1])) result[match[1]] = yamlScalar(match[2]);
  }
  return result;
}

function credentials(options = {}) {
  const secretPath = resolve(options.secrets || process.env.COROS_SECRETS_FILE || join(homedir(), '.knowledge-assistant', 'config', 'secrets.yaml'));
  const file = readCorosSecrets(secretPath);
  return {
    apiUrl: process.env.COROS_API_URL || file.api_url || DEFAULT_API_URL,
    email: process.env.COROS_EMAIL || file.email,
    password: process.env.COROS_PASSWORD || file.password,
  };
}

export function inspectFitBuffer(buffer, { checkCrc = true } = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < MIN_FIT_BYTES) return { valid: false, reason: 'too_short', bytes: buffer.length };
  if (buffer.subarray(8, 12).toString('ascii') !== '.FIT') return { valid: false, reason: 'missing_fit_signature', bytes: buffer.length };
  const headerSize = buffer[0];
  if (headerSize !== 12 && headerSize !== 14) return { valid: false, reason: 'invalid_header_size', bytes: buffer.length };
  const declaredDataSize = buffer.readUInt32LE(4);
  const expected = headerSize + declaredDataSize + 2;
  if (expected !== buffer.length) return { valid: false, reason: 'declared_length_mismatch', bytes: buffer.length, expected };
  try {
    const decoder = new Decoder(Stream.fromBuffer(buffer));
    if (!decoder.isFIT()) return { valid: false, reason: 'sdk_signature_rejected', bytes: buffer.length };
    if (checkCrc && !decoder.checkIntegrity()) return { valid: false, reason: 'crc_or_integrity_failed', bytes: buffer.length };
    return { valid: true, bytes: buffer.length, headerSize, declaredDataSize };
  } catch (error) {
    return { valid: false, reason: `sdk_error:${error.message}`, bytes: buffer.length };
  }
}

export function inspectFitFile(path) {
  try { return inspectFitBuffer(readFileSync(path)); }
  catch (error) { return { valid: false, reason: `read_error:${error.code || error.message}`, bytes: 0 }; }
}

function safeId(value) {
  const id = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid activity ID');
  return id;
}

function activityId(activity) {
  return safeId(activity.labelId ?? activity.activityId ?? activity.id);
}

function activityDate(activity) {
  const raw = String(activity.date ?? '').replace(/\D/g, '');
  if (raw.length === 8) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const candidate = activity.startTime ?? activity.start_time;
  if (candidate) {
    const date = new Date(candidate);
    if (!Number.isNaN(date.valueOf())) return date.toISOString().slice(0, 10);
  }
  return null;
}

function dateTime(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : null;
    if (ms) return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value) {
    const d = new Date(value);
    if (!Number.isNaN(d.valueOf())) return d.toISOString();
  }
  return null;
}

function number(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function first(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== '');
}

function normalizeDevice(value) {
  const text = String(value ?? '').trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
  if (!text) return null;
  const upper = text.toUpperCase();
  if (/PACE\s*2\b/.test(upper)) return 'PACE 2';
  if (/PACE\s*4\b/.test(upper)) return 'PACE 4';
  return text;
}

function runningCadenceSpm(...values) {
  const cadence = number(...values);
  // FIT running cadence is commonly encoded as strides/minute (one foot),
  // while COROS presents total steps/minute. Preserve the user-facing unit.
  return cadence !== null && cadence > 0 && cadence < 130 ? cadence * 2 : cadence;
}

function isRunning(meta, session) {
  const text = `${meta.name ?? ''} ${meta.sportType ?? ''} ${session?.sport ?? ''} ${session?.subSport ?? ''}`.toLowerCase();
  return meta.sportType === 100 || /跑步|跑步机|run|treadmill/.test(text);
}

function decodeFit(path) {
  const buffer = readFileSync(path);
  const integrity = inspectFitBuffer(buffer);
  if (!integrity.valid) throw new Error(`invalid FIT: ${integrity.reason}`);
  const decoder = new Decoder(Stream.fromBuffer(buffer));
  const { messages, errors } = decoder.read({ includeUnknownData: true, mergeHeartRates: true });
  if (errors?.length) throw new Error(`FIT decode errors: ${errors.map((e) => e.message || e).join('; ')}`);
  return messages;
}

function messagesOf(messages, name) {
  const value = messages?.[name];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function sessionFrom(messages) {
  return messagesOf(messages, 'sessionMesgs')[0] || messagesOf(messages, 'session')[0] || {};
}

function lapsFrom(messages) {
  return messagesOf(messages, 'lapMesgs').length ? messagesOf(messages, 'lapMesgs') : messagesOf(messages, 'lap');
}

function deviceFrom(messages, metadata) {
  const infos = messagesOf(messages, 'deviceInfoMesgs').length ? messagesOf(messages, 'deviceInfoMesgs') : messagesOf(messages, 'deviceInfo');
  const fit = infos.map((x) => first(x.productName, x.garminProduct, x.product)).find(Boolean);
  return normalizeDevice(first(metadata.device, metadata.deviceName, fit));
}

function normalizeLap(lap, index, id) {
  const timer = number(lap.totalTimerTime, lap.timerTime);
  const elapsed = number(lap.totalElapsedTime, lap.elapsedTime);
  const distance = number(lap.totalDistance, lap.distance);
  return {
    activity_id: id,
    lap_index: index + 1,
    start_time: dateTime(lap.startTime),
    distance_m: distance,
    timer_time_s: timer,
    elapsed_time_s: elapsed,
    effective_time_s: timer ?? elapsed,
    pace_s_per_km: distance && (timer ?? elapsed) ? (timer ?? elapsed) / (distance / 1000) : null,
    avg_hr: number(lap.avgHeartRate, lap.avgHr),
    max_hr: number(lap.maxHeartRate, lap.maxHr),
    avg_cadence_spm: runningCadenceSpm(lap.avgRunningCadence, lap.avgCadence),
    max_cadence_spm: runningCadenceSpm(lap.maxRunningCadence, lap.maxCadence),
    avg_power_w: number(lap.avgPower),
    max_power_w: number(lap.maxPower),
    max_speed_mps: number(lap.enhancedMaxSpeed, lap.maxSpeed),
    avg_temperature_c: number(lap.avgTemperature),
    total_ascent_m: number(lap.totalAscent),
    complete_km: distance !== null && distance >= FULL_KM_MIN_M && distance <= FULL_KM_MAX_M,
  };
}

export function calculateSegments(laps, totalDistanceM = null, annotation = null) {
  const full = laps.filter((lap) => lap.complete_km);
  let steady5k = null;
  if (full.length >= 5) {
    const selected = full.slice(0, 5);
    const times = selected.map((x) => number(x.timer_time_s, x.elapsed_time_s));
    const total = times.every((x) => x !== null && x > 0) ? times.reduce((a, b) => a + b, 0) : null;
    const hrWeight = selected.reduce((acc, lap, i) => {
      if (lap.avg_hr && times[i]) return { sum: acc.sum + lap.avg_hr * times[i], time: acc.time + times[i] };
      return acc;
    }, { sum: 0, time: 0 });
    const avgHr = hrWeight.time ? hrWeight.sum / hrWeight.time : null;
    steady5k = {
      lap_indices: selected.map((x) => x.lap_index),
      timer_time_s: total,
      avg_hr: avgHr,
      pace_s_per_km: total ? total / 5 : null,
      ef: total && avgHr ? ((5000 / total) * 60) / avgHr : null,
    };
  }
  let finish1k = null;
  if (full.length >= 6) {
    const lap = full[5];
    finish1k = {
      lap_index: lap.lap_index,
      timer_time_s: number(lap.timer_time_s, lap.elapsed_time_s),
      pace_s_per_km: lap.pace_s_per_km,
      avg_hr: lap.avg_hr,
      max_hr: lap.max_hr,
      avg_cadence_spm: lap.avg_cadence_spm,
      max_speed_mps: lap.max_speed_mps,
      classification: null,
      classification_rule: null,
    };
    const marked = typeof annotation === 'string' ? annotation : annotation?.finish_1k;
    if (marked) {
      finish1k.classification = 'user';
      finish1k.classification_label = marked;
    } else if (
      steady5k?.pace_s_per_km && finish1k.pace_s_per_km
      && finish1k.pace_s_per_km <= steady5k.pace_s_per_km * 0.85
      && finish1k.avg_hr && steady5k.avg_hr && finish1k.avg_hr >= steady5k.avg_hr + 10
      && totalDistanceM >= 5800 && totalDistanceM <= 6500
    ) {
      finish1k.classification = 'inferred';
      finish1k.classification_label = '爽跑';
      finish1k.classification_rule = 'six complete 1km laps; finish pace >=15% faster; avg HR >=10 bpm higher; total distance 5.8–6.5km';
    }
  }
  return { steady_5k: steady5k, finish_1k: finish1k };
}

export function normalizeActivity(metadata, messages, annotation = null) {
  const id = activityId(metadata);
  const session = sessionFrom(messages);
  const laps = lapsFrom(messages).map((lap, index) => normalizeLap(lap, index, id));
  laps.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || '') || a.lap_index - b.lap_index);
  laps.forEach((lap, index) => { lap.lap_index = index + 1; });
  const distance = number(session.totalDistance, metadata.distance);
  const timer = number(session.totalTimerTime, metadata.workoutTime, metadata.totalTime);
  const elapsed = number(session.totalElapsedTime, metadata.totalTime, metadata.workoutTime);
  const start = dateTime(first(session.startTime, metadata.startTime));
  const date = activityDate(metadata) || start?.slice(0, 10) || null;
  const activity = {
    schema_version: SCHEMA_VERSION,
    algorithm_version: ALGORITHM_VERSION,
    activity_id: id,
    date,
    start_time: start,
    name: first(metadata.name, session.sport, 'activity'),
    sport_type: first(session.sport, metadata.sportType, metadata.mode),
    is_running: isRunning(metadata, session),
    device: deviceFrom(messages, metadata),
    distance_m: distance,
    timer_time_s: timer,
    elapsed_time_s: elapsed,
    pace_s_per_km: distance && timer ? timer / (distance / 1000) : null,
    avg_hr: number(session.avgHeartRate, metadata.avgHr),
    max_hr: number(session.maxHeartRate, metadata.maxHr),
    avg_cadence_spm: runningCadenceSpm(session.avgRunningCadence, session.avgCadence, metadata.avgCadence),
    max_cadence_spm: runningCadenceSpm(session.maxRunningCadence, session.maxCadence, metadata.cadence),
    avg_power_w: number(session.avgPower, metadata.avgPower),
    max_power_w: number(session.maxPower),
    avg_temperature_c: number(session.avgTemperature, metadata.bodyTemperature),
    max_temperature_c: number(session.maxTemperature),
    total_ascent_m: number(session.totalAscent, metadata.ascent),
    calories_kcal: number(session.totalCalories, metadata.calorie),
    training_load: number(metadata.trainingLoad),
    laps,
  };
  Object.assign(activity, calculateSegments(laps, distance, annotation));
  return activity;
}

function mergeActivities(existing, incoming) {
  const byId = new Map();
  for (const activity of [...existing, ...incoming]) {
    try { byId.set(activityId(activity), { ...(byId.get(activityId(activity)) || {}), ...activity }); } catch { /* ignore malformed rows */ }
  }
  return [...byId.values()].sort((a, b) => (activityDate(a) || '').localeCompare(activityDate(b) || '') || activityId(a).localeCompare(activityId(b)));
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'number' ? String(value) : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(rows, columns) {
  return `${[columns, ...rows.map((row) => columns.map((key) => row[key]))].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function mean(values) {
  const clean = values.filter((x) => Number.isFinite(x));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function median(values) {
  const clean = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function stats(rows) {
  const metrics = ['pace_s_per_km', 'avg_hr', 'ef', 'finish_pace_s_per_km', 'finish_avg_hr'];
  const out = { count: rows.length };
  for (const metric of metrics) {
    const values = rows.map((row) => metric === 'ef' ? row.steady_5k?.ef : metric === 'finish_pace_s_per_km' ? row.finish_1k?.pace_s_per_km : metric === 'finish_avg_hr' ? row.finish_1k?.avg_hr : metric === 'pace_s_per_km' ? row.steady_5k?.pace_s_per_km ?? row.pace_s_per_km : row.steady_5k?.avg_hr ?? row.avg_hr).filter(Number.isFinite);
    out[metric] = { mean: mean(values), median: median(values) };
  }
  return out;
}

function buildBaselines(activities) {
  const runs = activities.filter((x) => x.is_running);
  const devices = {};
  for (const device of new Set(runs.map((x) => x.device).filter(Boolean))) devices[device] = stats(runs.filter((x) => x.device === device));
  return {
    schema_version: SCHEMA_VERSION,
    algorithm_version: ALGORITHM_VERSION,
    generated_at: new Date().toISOString(),
    all_runs: stats(runs),
    devices,
    finish_user: stats(runs.filter((x) => x.finish_1k?.classification === 'user')),
    finish_inferred: stats(runs.filter((x) => x.finish_1k?.classification === 'inferred')),
  };
}

export function rebuild(paths, { strict = false } = {}) {
  ensureLayout(paths);
  const metadata = readJson(paths.activities, []);
  const annotations = readJson(paths.annotations, {});
  const normalized = [];
  const invalid = [];
  for (const meta of metadata) {
    let id;
    try { id = activityId(meta); } catch { invalid.push({ activity_id: null, reason: 'invalid_metadata_id' }); continue; }
    const path = join(paths.fitDir, `${id}.fit`);
    const check = inspectFitFile(path);
    if (!check.valid) { invalid.push({ activity_id: id, reason: check.reason }); continue; }
    try { normalized.push(normalizeActivity(meta, decodeFit(path), annotations[id])); }
    catch (error) { invalid.push({ activity_id: id, reason: error.message }); }
  }
  normalized.sort((a, b) => (a.start_time || a.date || '').localeCompare(b.start_time || b.date || '') || a.activity_id.localeCompare(b.activity_id));
  atomicWrite(paths.activitiesJsonl, normalized.map((x) => JSON.stringify(x)).join('\n') + (normalized.length ? '\n' : ''));
  const runs = normalized.filter((x) => x.is_running);
  const runRows = runs.map((x) => ({
    activity_id: x.activity_id, date: x.date, start_time: x.start_time, device: x.device,
    distance_m: x.distance_m, timer_time_s: x.timer_time_s, elapsed_time_s: x.elapsed_time_s,
    pace_s_per_km: x.pace_s_per_km, avg_hr: x.avg_hr, max_hr: x.max_hr,
    avg_cadence_spm: x.avg_cadence_spm, avg_power_w: x.avg_power_w,
    avg_temperature_c: x.avg_temperature_c, total_ascent_m: x.total_ascent_m,
    calories_kcal: x.calories_kcal, training_load: x.training_load,
    steady_5k_time_s: x.steady_5k?.timer_time_s, steady_5k_pace_s_per_km: x.steady_5k?.pace_s_per_km,
    steady_5k_avg_hr: x.steady_5k?.avg_hr, steady_5k_ef: x.steady_5k?.ef,
    finish_1k_time_s: x.finish_1k?.timer_time_s, finish_1k_pace_s_per_km: x.finish_1k?.pace_s_per_km,
    finish_1k_avg_hr: x.finish_1k?.avg_hr, finish_1k_max_hr: x.finish_1k?.max_hr,
    finish_1k_cadence_spm: x.finish_1k?.avg_cadence_spm, finish_1k_max_speed_mps: x.finish_1k?.max_speed_mps,
    finish_classification: x.finish_1k?.classification,
  }));
  const runColumns = Object.keys(runRows[0] || { activity_id: '', date: '', device: '' });
  atomicWrite(paths.runningCsv, toCsv(runRows, runColumns));
  const splitRows = runs.flatMap((x) => x.laps.map((lap) => ({ date: x.date, device: x.device, ...lap })));
  const splitColumns = Object.keys(splitRows[0] || { activity_id: '', lap_index: '', distance_m: '' });
  atomicWrite(paths.splitsCsv, toCsv(splitRows, splitColumns));
  atomicWrite(paths.baselines, stableJson(buildBaselines(normalized)));
  const result = { parsed: normalized.length, running: runs.length, invalid_count: invalid.length, invalid };
  const priorState = readJson(paths.state, {});
  atomicWrite(paths.state, stableJson({
    ...priorState,
    schema_version: SCHEMA_VERSION,
    algorithm_version: ALGORITHM_VERSION,
    data_through: normalized.map((x) => x.date).filter(Boolean).sort().at(-1) || priorState.data_through || null,
    activity_ids: metadata.map((x) => { try { return activityId(x); } catch { return null; } }).filter(Boolean),
    valid_fit_ids: normalized.map((x) => x.activity_id),
    fit_valid_count: normalized.length,
    fit_invalid_count: invalid.length,
    last_rebuild_at: new Date().toISOString(),
  }));
  if (strict && invalid.length) throw new Error(`${invalid.length} missing or invalid FIT files`);
  const wp = wellnessPaths(paths);
  if (existsSync(wp.raw)) result.wellness = rebuildWellness(paths);
  return result;
}

function loadDerived(paths) {
  if (!existsSync(paths.activitiesJsonl)) return [];
  return readFileSync(paths.activitiesJsonl, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function percent(target, baseline) {
  return Number.isFinite(target) && Number.isFinite(baseline) && baseline !== 0 ? ((target - baseline) / baseline) * 100 : null;
}

function compareMetric(target, groupStats, metric, targetValue) {
  const base = groupStats?.[metric];
  return { value: targetValue, baseline_mean: base?.mean ?? null, baseline_median: base?.median ?? null, vs_mean_pct: percent(targetValue, base?.mean), vs_median_pct: percent(targetValue, base?.median) };
}

export function compareLatest(paths) {
  const all = loadDerived(paths);
  const runs = all.filter((x) => x.is_running).sort((a, b) => (a.start_time || a.date || '').localeCompare(b.start_time || b.date || ''));
  const target = runs.at(-1);
  if (!target) return { ok: false, reason: 'no cached running activities', data_through: null };
  const targetTime = new Date(`${target.date}T23:59:59Z`).valueOf();
  const prior = runs.slice(0, -1);
  const recent = prior.filter((x) => targetTime - new Date(`${x.date}T00:00:00Z`).valueOf() <= 60 * 86400000);
  const sameDevice = prior.filter((x) => x.device && x.device === target.device);
  const userFinish = prior.filter((x) => x.finish_1k?.classification === 'user');
  const inferredFinish = prior.filter((x) => x.finish_1k?.classification === 'inferred');
  const groups = { recent_60d: recent, same_device: sameDevice, finish_user: userFinish, finish_inferred: inferredFinish };
  const comparisons = {};
  for (const [name, rows] of Object.entries(groups)) {
    const s = stats(rows);
    comparisons[name] = {
      count: rows.length,
      steady_pace: compareMetric(target, s, 'pace_s_per_km', target.steady_5k?.pace_s_per_km),
      steady_hr: compareMetric(target, s, 'avg_hr', target.steady_5k?.avg_hr),
      steady_ef: compareMetric(target, s, 'ef', target.steady_5k?.ef),
      finish_pace: compareMetric(target, s, 'finish_pace_s_per_km', target.finish_1k?.pace_s_per_km),
      finish_hr: compareMetric(target, s, 'finish_avg_hr', target.finish_1k?.avg_hr),
    };
  }
  const deviceGroups = {};
  for (const device of new Set(runs.map((x) => x.device).filter(Boolean))) deviceGroups[device] = stats(runs.filter((x) => x.device === device));
  return { ok: true, data_through: target.date, target, comparisons, device_groups: deviceGroups, caveat: 'Device and temperature are explanatory variables; cross-device differences are not absolute fitness gains.' };
}

async function requestJson(url, init, label) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  const data = await res.json();
  if (data?.result && data.result !== '0000') throw new Error(`${label} rejected: ${data.message || data.result}`);
  return data;
}

async function login(creds) {
  if (!creds.email || !creds.password) throw new Error('COROS credentials unavailable');
  const pwd = createHash('md5').update(creds.password).digest('hex');
  const data = await requestJson(`${creds.apiUrl}/account/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: creds.email, accountType: 2, pwd }) }, 'login');
  const token = data?.data?.accessToken;
  if (!token) throw new Error('login response contained no access token');
  return token;
}

async function queryIncremental(creds, token, existing, { repair = false } = {}) {
  const known = new Set(existing.map((x) => { try { return activityId(x); } catch { return ''; } }));
  const newest = existing.map(activityDate).filter(Boolean).sort().at(-1);
  const incoming = [];
  for (let page = 1; ; page += 1) {
    const data = await requestJson(`${creds.apiUrl}/activity/query?size=200&pageNumber=${page}&modeList=`, { headers: { accessToken: token } }, 'activity query');
    const list = data?.data?.dataList || [];
    incoming.push(...list);
    const oldPage = list.length > 0 && list.every((x) => known.has(String(x.labelId)) || (newest && activityDate(x) <= newest));
    if (page >= (data?.data?.totalPage || 0) || (!repair && existing.length && oldPage)) break;
  }
  return incoming;
}

export async function fetchFitForActivity(creds, token, activity, fetchImpl = fetch) {
  const id = activityId(activity);
  const sport = encodeURIComponent(activity.sportType ?? activity.mode ?? '');
  const endpoint = `${creds.apiUrl}/activity/detail/download?labelId=${encodeURIComponent(id)}&sportType=${sport}&fileType=4`;
  let response = await fetchImpl(endpoint, { headers: { accessToken: token } });
  if (!response.ok) throw new Error(`FIT link HTTP ${response.status}`);
  let buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('json') || buffer.subarray(0, 1).toString() === '{') {
    let envelope;
    try { envelope = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('FIT endpoint returned invalid JSON'); }
    const fileUrl = envelope?.data?.fileUrl;
    if (!fileUrl || !/^https?:\/\//i.test(fileUrl)) throw new Error('FIT endpoint JSON contained no valid fileUrl');
    response = await fetchImpl(fileUrl);
    if (!response.ok) throw new Error(`FIT file HTTP ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
  }
  const check = inspectFitBuffer(buffer);
  if (!check.valid) throw new Error(`downloaded FIT rejected: ${check.reason}`);
  return buffer;
}

function writeFitAtomic(paths, id, buffer) {
  const target = join(paths.fitDir, `${safeId(id)}.fit`);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, buffer, { mode: 0o600 });
  const check = inspectFitFile(tmp);
  if (!check.valid) { unlinkSync(tmp); throw new Error(`temporary FIT rejected: ${check.reason}`); }
  if (existsSync(target) && inspectFitFile(target).valid) { unlinkSync(tmp); return false; }
  renameSync(tmp, target);
  return true;
}

export async function sync(paths, options = {}) {
  ensureLayout(paths);
  const existing = readJson(paths.activities, []);
  const previousState = readJson(paths.state, {});
  const trustedFitIds = new Set(previousState.valid_fit_ids || []);
  const creds = options.credentials || credentials(options);
  const result = { remote: { status: 'not_attempted', error: null }, metadata_new: 0, metadata_changed: false, fit_downloaded: 0, fit_skipped_valid: 0, fit_failed: [], data_through: existing.map(activityDate).filter(Boolean).sort().at(-1) || null };
  let merged = existing;
  try {
    const token = options.token || await login(creds);
    const incoming = await queryIncremental(creds, token, existing, { repair: options.repair });
    merged = mergeActivities(existing, incoming);
    result.metadata_new = merged.length - existing.length;
    const mergedText = stableJson(merged);
    result.metadata_changed = mergedText !== stableJson(existing);
    if (result.metadata_changed || !existsSync(paths.activities)) atomicWrite(paths.activities, mergedText);
    for (const activity of merged) {
      const id = activityId(activity);
      const target = join(paths.fitDir, `${id}.fit`);
      if (!options.repair && trustedFitIds.has(id) && existsSync(target)) { result.fit_skipped_valid += 1; continue; }
      if (inspectFitFile(target).valid) { result.fit_skipped_valid += 1; continue; }
      try {
        const buffer = await fetchFitForActivity(creds, token, activity, options.fetchImpl || fetch);
        if (writeFitAtomic(paths, id, buffer)) result.fit_downloaded += 1;
      } catch (error) { result.fit_failed.push({ activity_id: id, error: error.message }); }
    }
    result.remote.status = result.fit_failed.length ? 'partial' : 'ok';
  } catch (error) {
    result.remote.status = 'failed';
    result.remote.error = error.message;
  }
  const versionsCurrent = previousState.schema_version === SCHEMA_VERSION && previousState.algorithm_version === ALGORITHM_VERSION;
  const derivedPresent = [paths.activitiesJsonl, paths.runningCsv, paths.splitsCsv, paths.baselines].every(existsSync);
  const needsRebuild = result.metadata_changed || result.fit_downloaded > 0 || !versionsCurrent || !derivedPresent;
  const rebuilt = needsRebuild ? rebuild(paths) : {
    skipped: true,
    reason: 'no metadata/FIT/algorithm changes',
    parsed: previousState.fit_valid_count ?? loadDerived(paths).length,
    invalid_count: previousState.fit_invalid_count ?? 0,
  };
  result.data_through = merged.map(activityDate).filter(Boolean).sort().at(-1) || result.data_through;
  const validFitIds = needsRebuild
    ? loadDerived(paths).map((x) => x.activity_id)
    : previousState.valid_fit_ids || loadDerived(paths).map((x) => x.activity_id);
  const state = {
    schema_version: SCHEMA_VERSION, algorithm_version: ALGORITHM_VERSION,
    last_attempt_at: new Date().toISOString(), last_success_at: result.remote.status === 'ok' ? new Date().toISOString() : previousState.last_success_at || null,
    last_rebuild_at: needsRebuild ? new Date().toISOString() : previousState.last_rebuild_at || null,
    data_through: result.data_through, activity_ids: merged.map((x) => activityId(x)),
    valid_fit_ids: validFitIds,
    fit_valid_count: rebuilt.parsed, fit_invalid_count: rebuilt.invalid_count,
  };
  atomicWrite(paths.state, stableJson(state));
  return { ...result, rebuild: rebuilt };
}

export function migrate(paths, legacyDir) {
  ensureLayout(paths);
  const source = resolve(legacyDir);
  const legacyActivities = readJson(join(source, 'activities.json'), []);
  const current = readJson(paths.activities, []);
  const merged = mergeActivities(current, legacyActivities);
  atomicWrite(paths.activities, stableJson(merged));
  let copiedValid = 0;
  let skippedValid = 0;
  let invalidLegacy = 0;
  for (const activity of merged) {
    const id = activityId(activity);
    const target = join(paths.fitDir, `${id}.fit`);
    if (inspectFitFile(target).valid) { skippedValid += 1; continue; }
    const candidates = [];
    try {
      for (const name of readdirSync(source)) if (name.endsWith('.fit') && name.includes(id)) candidates.push(join(source, name));
    } catch { /* handled by no candidates */ }
    const valid = candidates.find((path) => inspectFitFile(path).valid);
    if (valid) { copyFileSync(valid, target); copiedValid += 1; }
    else if (candidates.length) invalidLegacy += 1;
  }
  return { metadata_total: merged.length, metadata_added: merged.length - current.length, copied_valid_fit: copiedValid, skipped_existing_valid_fit: skippedValid, invalid_legacy_fit: invalidLegacy, source_preserved: true };
}

export function validate(paths) {
  ensureLayout(paths);
  const metadata = readJson(paths.activities, []);
  const checks = metadata.map((x) => {
    const id = activityId(x);
    return { activity_id: id, ...inspectFitFile(join(paths.fitDir, `${id}.fit`)) };
  });
  const valid = checks.filter((x) => x.valid).length;
  const state = readJson(paths.state, null);
  const stateSummary = state ? {
    schema_version: state.schema_version,
    algorithm_version: state.algorithm_version,
    last_attempt_at: state.last_attempt_at || null,
    last_success_at: state.last_success_at || null,
    last_rebuild_at: state.last_rebuild_at || null,
    data_through: state.data_through || null,
    activity_id_count: state.activity_ids?.length || 0,
    valid_fit_id_count: state.valid_fit_ids?.length || 0,
  } : null;
  return { metadata_count: metadata.length, valid_fit_count: valid, invalid_fit_count: checks.length - valid, invalid: checks.filter((x) => !x.valid), state: stateSummary, wellness: validateWellness(paths) };
}

function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (command === 'oauth-start') { output(officialOauth('login-start', { cacheRoot: args['oauth-cache-root'] })); return; }
  if (command === 'oauth-finish') { output(officialOauth('login-finish', { cacheRoot: args['oauth-cache-root'] })); return; }
  if (command === 'oauth-status') { output(officialOauth('login-status', { cacheRoot: args['oauth-cache-root'] })); return; }
  const paths = resolvePaths({ workspace: args.workspace, dataRoot: args['data-root'] });
  if (command === 'sync') {
    const official = args['fit-only'] ? null : await syncWellness(paths, {
      startDate: args.from, endDate: args.to, refreshTools: args['refresh-tools'],
      cacheRoot: args['oauth-cache-root'], timeZone: args.timezone,
    });
    const activity = args['wellness-only'] ? null : await sync(paths, { repair: args.repair, secrets: args.secrets });
    output(activity ? { ...activity, official_wellness: official } : { official_wellness: official });
  }
  else if (command === 'sync-fit') output(await sync(paths, { repair: args.repair, secrets: args.secrets }));
  else if (command === 'wellness-sync') output(await syncWellness(paths, {
    startDate: args.from, endDate: args.to, refreshTools: args['refresh-tools'],
    cacheRoot: args['oauth-cache-root'], timeZone: args.timezone,
  }));
  else if (command === 'wellness-rebuild') output(rebuildWellness(paths));
  else if (command === 'wellness-trend') output(wellnessTrend(paths, { days: args.days }));
  else if (command === 'rebuild') output(rebuild(paths));
  else if (command === 'validate') output(validate(paths));
  else if (command === 'compare') output(compareLatest(paths));
  else if (command === 'analyze-latest') {
    const data = loadDerived(paths).sort((a, b) => (a.start_time || a.date || '').localeCompare(b.start_time || b.date || ''));
    output({ ok: Boolean(data.length), data_through: data.at(-1)?.date || null, activity: data.at(-1) || null });
  } else if (command === 'migrate') {
    const legacy = args['legacy-dir'] || join(paths.workspace, 'tools', 'coros-data');
    output(migrate(paths, legacy));
  } else {
    process.stderr.write('Usage: coros-health.mjs <sync|sync-fit|wellness-sync|wellness-trend|wellness-rebuild|oauth-start|oauth-finish|oauth-status|analyze-latest|compare|rebuild|validate|migrate> [--repair] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days N] [--data-root PATH] [--workspace PATH]\n');
    process.exitCode = 2;
  }
}

function isDirectExecution(entrypoint = process.argv[1]) {
  if (!entrypoint) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(resolve(entrypoint)) === realpathSync(modulePath);
  } catch {
    return resolve(entrypoint) === modulePath;
  }
}

const isMain = isDirectExecution();
if (isMain) main().catch((error) => { process.stderr.write(`coros-health: ${error.message}\n`); process.exitCode = 1; });
