/**
 * Configuration loaded from environment variables.
 * Variable names match the reference repo (hermitdave/SunSynk-Octopus)
 * config.example.env for drop-in compatibility.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

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
    logLevel: optionalEnv('LOG_LEVEL', 'INFO'),
  };
}
