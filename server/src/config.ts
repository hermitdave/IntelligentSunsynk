/**
 * Configuration loaded from environment variables.
 * Variable names match the reference repo (hermitdave/SunSynk-Octopus)
 * config.example.env for drop-in compatibility.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { SocThreshold } from './types';

/**
 * Default time-of-day SoC threshold schedule. Times are local; each threshold
 * applies from its start time until the next, wrapping past midnight (so the
 * 18:00 entry covers 18:00 → 09:00 the next day).
 */
export const DEFAULT_SOC_THRESHOLD_SCHEDULE = '09:00=90,12:00=75,15:00=60,18:00=45';

/**
 * Parse a "HH:MM=NN,HH:MM=NN,..." schedule string into sorted SocThreshold
 * entries. Throws on malformed input so misconfiguration fails fast at startup.
 */
export function parseSocThresholdSchedule(raw: string): SocThreshold[] {
  const entries: SocThreshold[] = [];
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const match = /^(\d{1,2}):(\d{2})=(\d{1,3})$/.exec(part);
    if (!match) {
      throw new Error(
        `Invalid SOC_THRESHOLD_SCHEDULE entry "${part}". Expected "HH:MM=NN" (e.g. "09:00=90").`,
      );
    }
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const threshold = parseInt(match[3], 10);
    if (hours > 23 || minutes > 59) {
      throw new Error(`Invalid time in SOC_THRESHOLD_SCHEDULE entry "${part}" (expected 00:00-23:59).`);
    }
    if (threshold > 100) {
      throw new Error(`Invalid threshold in SOC_THRESHOLD_SCHEDULE entry "${part}" (expected 0-100).`);
    }
    entries.push({ startMinutes: hours * 60 + minutes, threshold });
  }
  if (entries.length === 0) {
    throw new Error('SOC_THRESHOLD_SCHEDULE must contain at least one "HH:MM=NN" entry.');
  }
  entries.sort((a, b) => a.startMinutes - b.startMinutes);
  return entries;
}

function loadEnvFiles(): void {
  const repoRootEnvPath = path.resolve(__dirname, '..', '..', '.env');
  const cwdEnvPath = path.resolve(process.cwd(), '.env');

  if (fs.existsSync(repoRootEnvPath)) {
    dotenv.config({ path: repoRootEnvPath });
  }

  if (cwdEnvPath !== repoRootEnvPath && fs.existsSync(cwdEnvPath)) {
    dotenv.config({ path: cwdEnvPath });
  }
}

loadEnvFiles();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Required environment variable ${name} is not set. ` +
      'Make sure it exists in the repo root .env file. See .env.example.'
    );
  }
  return value;
}

function requireEnvUnless(name: string, skipWhen: boolean, reason: string): string {
  const value = process.env[name];
  if (!value && !skipWhen) {
    throw new Error(
      `Required environment variable ${name} is not set. ` +
      `${reason} See .env.example.`
    );
  }
  return value ?? '';
}

function optionalEnv(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function optionalEnvTrimmed(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

export interface Config {
  // Sunsynk account credentials
  sunsynkAccessToken: string;
  sunsynkUsername: string;
  sunsynkPassword: string;
  // Inverter identification
  sunsynkSerial: string;
  sunsynkPlantId: number;
  sunsynkVerifySsl: boolean;
  // Octopus Energy
  octopusApiKey: string;
  octopusAccountId: string;
  // Web server
  webHost: string;
  webPort: number;
  // Scheduler
  cronSchedule: string;
  socThresholdSchedule: SocThreshold[];
  // Logging
  logLevel: string;
}

export function loadConfig(): Config {
  const hasManualAccessToken = Boolean(process.env.SUNSYNK_ACCESS_TOKEN);
  const plantIdRaw = requireEnv('SUNSYNK_PLANT_ID');
  const plantId = parseInt(plantIdRaw, 10);
  if (Number.isNaN(plantId)) {
    throw new Error(
      'Required environment variable SUNSYNK_PLANT_ID must be a valid integer. ' +
      'Make sure it exists in the repo root .env file. See .env.example.'
    );
  }

  return {
    sunsynkAccessToken: optionalEnvTrimmed('SUNSYNK_ACCESS_TOKEN'),
    sunsynkUsername: requireEnvUnless(
      'SUNSYNK_USERNAME',
      hasManualAccessToken,
      'It is required unless SUNSYNK_ACCESS_TOKEN is provided.'
    ),
    sunsynkPassword: requireEnvUnless(
      'SUNSYNK_PASSWORD',
      hasManualAccessToken,
      'It is required unless SUNSYNK_ACCESS_TOKEN is provided.'
    ),
    sunsynkSerial: requireEnv('SUNSYNK_SERIAL'),
    sunsynkPlantId: plantId,
    sunsynkVerifySsl: optionalEnv('SUNSYNK_VERIFY_SSL', 'false') === 'true',
    octopusApiKey: requireEnv('OCTOPUS_API_KEY'),
    octopusAccountId: requireEnv('OCTOPUS_ACCOUNT_ID'),
    webHost: optionalEnv('WEB_HOST', '0.0.0.0'),
    webPort: parseInt(optionalEnv('WEB_PORT', '8080'), 10),
    cronSchedule: optionalEnv('CRON_SCHEDULE', '*/5 * * * *'),
    socThresholdSchedule: parseSocThresholdSchedule(
      optionalEnv('SOC_THRESHOLD_SCHEDULE', DEFAULT_SOC_THRESHOLD_SCHEDULE),
    ),
    logLevel: optionalEnv('LOG_LEVEL', 'INFO'),
  };
}
