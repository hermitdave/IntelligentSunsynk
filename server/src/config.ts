/**
 * Configuration loaded from environment variables.
 * Variable names match the reference repo (hermitdave/SunSynk-Octopus)
 * config.example.env for drop-in compatibility.
 */
import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set. See .env.example.`);
  }
  return value;
}

function optionalEnv(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export interface Config {
  // Sunsynk OpenAPI credentials
  sunsynkApiKey: string;
  sunsynkApiSecret: string;
  // Sunsynk account credentials
  sunsynkUsername: string;
  sunsynkPassword: string;
  // Inverter identification
  sunsynkSerial: string;
  sunsynkPlantId: number | null;
  sunsynkVerifySsl: boolean;
  // Octopus Energy
  octopusApiKey: string;
  octopusAccountId: string;
  octopusOffPeakRate: number;
  octopusPeakRate: number;
  // Battery (display only)
  batteryCapacityKwh: number;
  batteryMinSoc: number;
  // Web server
  webHost: string;
  webPort: number;
  // Scheduler
  cronSchedule: string;
  // Logging
  logLevel: string;
}

export function loadConfig(): Config {
  return {
    sunsynkApiKey: requireEnv('SUNSYNK_API_KEY'),
    sunsynkApiSecret: requireEnv('SUNSYNK_API_SECRET'),
    sunsynkUsername: requireEnv('SUNSYNK_USERNAME'),
    sunsynkPassword: requireEnv('SUNSYNK_PASSWORD'),
    sunsynkSerial: requireEnv('SUNSYNK_SERIAL'),
    sunsynkPlantId: process.env.SUNSYNK_PLANT_ID
      ? parseInt(process.env.SUNSYNK_PLANT_ID, 10)
      : null,
    sunsynkVerifySsl: optionalEnv('SUNSYNK_VERIFY_SSL', 'false') === 'true',
    octopusApiKey: requireEnv('OCTOPUS_API_KEY'),
    octopusAccountId: requireEnv('OCTOPUS_ACCOUNT_ID'),
    octopusOffPeakRate: parseFloat(optionalEnv('OCTOPUS_OFF_PEAK_RATE', '7.0')),
    octopusPeakRate: parseFloat(optionalEnv('OCTOPUS_PEAK_RATE', '24.0')),
    batteryCapacityKwh: parseFloat(optionalEnv('BATTERY_CAPACITY_KWH', '10.0')),
    batteryMinSoc: parseInt(optionalEnv('BATTERY_MIN_SOC', '10'), 10),
    webHost: optionalEnv('WEB_HOST', '0.0.0.0'),
    webPort: parseInt(optionalEnv('WEB_PORT', '8080'), 10),
    cronSchedule: optionalEnv('CRON_SCHEDULE', '*/5 * * * *'),
    logLevel: optionalEnv('LOG_LEVEL', 'INFO'),
  };
}
