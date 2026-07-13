/**
 * IntelligentSunsynk server entry point.
 *
 * Start-up sequence:
 *  1. Load configuration from environment variables.
 *  2. Authenticate with SunSynk OpenAPI and discover the inverter.
 *  3. Read and save current inverter settings (golden snapshot).
 *  4. Start the recurring charge scheduler (cron job).
 *  5. Serve the Express REST API (and, in production, the React build).
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { loadConfig } from './config';
import { appState } from './state';
import { SunsynkService } from './services/sunsynk';
import { OctopusService } from './services/octopus';
import { startScheduler } from './jobs/chargeScheduler';
import { createRouter } from './routes/api';

async function main() {
  // -------------------------------------------------------------------------
  // 1. Configuration
  // -------------------------------------------------------------------------
  const config = loadConfig();
  console.log('[Server] Configuration loaded');

  // -------------------------------------------------------------------------
  // 2. Service instances
  // -------------------------------------------------------------------------
  const sunsynk = new SunsynkService(config);
  const octopus = new OctopusService(config);

  // -------------------------------------------------------------------------
  // 3. Authenticate & discover inverter
  // -------------------------------------------------------------------------
  console.log('[Server] Authenticating with SunSynk OpenAPI...');
  await sunsynk.authenticate();
  appState.isAuthenticated = true;
  console.log('[Server] Authentication successful');

  const { plantId, serial } = await sunsynk.discoverInverter();
  appState.plantId = plantId;
  appState.inverterSerial = serial;
  console.log('[Server] Inverter found – serial: ' + serial + ', plantId: ' + plantId);

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
