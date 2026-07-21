/**
 * IntelligentSunsynk server entry point.
 *
 * Start-up sequence:
 *  1. Load configuration from environment variables.
 *  2. Authenticate with SunSynk OpenAPI.
 *  3. Read and save current inverter settings using the configured serial.
 *  4. Start the recurring charge scheduler (cron job).
 *  5. Serve the Express REST API (and, in production, the React build).
 */
import express from 'express';
import cors from 'cors';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { loadConfig } from './config';
import { appState } from './state';
import { SunsynkService } from './services/sunsynk';
import { OctopusService } from './services/octopus';
import { startScheduler, PEAK_VALLEY_NORMAL } from './jobs/chargeScheduler';
import { createRouter } from './routes/api';

/** Reject after `ms` so a hung inverter call can't block process exit. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('timed out after ' + ms + 'ms')), ms),
    ),
  ]);
}

let shuttingDown = false;

/**
 * On Ctrl+C / termination, make sure the inverter is left with Use Timer
 * enabled (peakAndVallery = "1") so it is not stranded in forced-charge mode.
 * Only writes if the current value differs, and never blocks exit for long.
 */
async function gracefulShutdown(
  signal: string,
  sunsynk: SunsynkService,
  serial: string,
): Promise<void> {
  if (shuttingDown) {
    // A second signal (e.g. impatient Ctrl+C) forces an immediate exit.
    console.log('[Server] Received ' + signal + ' again — forcing exit.');
    process.exit(1);
  }
  shuttingDown = true;
  console.log('[Server] Received ' + signal + ', restoring Use Timer before exit...');

  try {
    const current = appState.currentSettings?.peakAndVallery;
    if (current === PEAK_VALLEY_NORMAL) {
      console.log('[Server] Use Timer already enabled (peakAndVallery=1); nothing to restore.');
    } else {
      await withTimeout(sunsynk.updateSettings(serial, { peakAndVallery: PEAK_VALLEY_NORMAL }), 10_000);
      appState.currentSettings = { ...(appState.currentSettings ?? {}), peakAndVallery: PEAK_VALLEY_NORMAL } as typeof appState.currentSettings;
      console.log('[Server] Use Timer restored (peakAndVallery=1). Exiting.');
    }
    process.exit(0);
  } catch (err) {
    console.error(
      '[Server] Failed to restore Use Timer on shutdown:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}

async function main() {
  // -------------------------------------------------------------------------
  // 1. Configuration
  // -------------------------------------------------------------------------
  const config = loadConfig();
  console.log('[Server] Configuration loaded');
  console.log(
    '[Server] SunSynk auth mode: ' +
    (config.sunsynkAccessToken ? 'manual token (SUNSYNK_ACCESS_TOKEN)' : 'OpenAPI password grant')
  );

  // -------------------------------------------------------------------------
  // 2. Service instances
  // -------------------------------------------------------------------------
  const sunsynk = new SunsynkService(config);
  const octopus = new OctopusService(config);

  // -------------------------------------------------------------------------
  // 3. Authenticate and initialize inverter access
  // -------------------------------------------------------------------------
  console.log('[Server] Authenticating with SunSynk OpenAPI...');
  await sunsynk.authenticate();
  appState.isAuthenticated = true;
  console.log('[Server] Authentication successful');

  const serial = config.sunsynkSerial;
  appState.inverterSerial = serial;
  appState.plantId = config.sunsynkPlantId;
  console.log(
    '[Server] Using configured inverter serial: ' + serial + ', plantId: ' + config.sunsynkPlantId
  );

  // -------------------------------------------------------------------------
  // 4. Read and save initial inverter settings
  // -------------------------------------------------------------------------
  console.log('[Server] Reading initial inverter settings...');
  const initialSettings = await sunsynk.getSettings(serial);
  appState.savedSettings = initialSettings;
  appState.currentSettings = { ...initialSettings };
  console.log('[Server] Settings snapshot saved. peakAndVallery = ' + initialSettings.peakAndVallery);

  // -------------------------------------------------------------------------
  // 5. Start the recurring charge scheduler
  // -------------------------------------------------------------------------
  startScheduler(config, sunsynk, octopus, serial);

  // Restore Use Timer on shutdown so Ctrl+C never leaves the inverter in
  // forced-charge mode.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void gracefulShutdown(signal, sunsynk, serial);
    });
  }

  // -------------------------------------------------------------------------
  // 6. Express server
  // -------------------------------------------------------------------------
  const app = express();

  // Rate limiter: cap requests per IP to mitigate abuse even on a local network
  const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,            // 120 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  app.use(cors());
  app.use(express.json());
  app.use(limiter);

  // API routes
  app.use('/api', createRouter(sunsynk, octopus, serial));

  // Serve the React production build (when running npm run build)
  const clientBuildPath = path.join(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(clientBuildPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });

  app.listen(config.webPort, config.webHost, () => {
    console.log('[Server] Listening on http://' + config.webHost + ':' + config.webPort);
    console.log('[Server] API: http://localhost:' + config.webPort + '/api/status');
    console.log('[Server] Dashboard: http://localhost:' + config.webPort);
  });
}

main().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
