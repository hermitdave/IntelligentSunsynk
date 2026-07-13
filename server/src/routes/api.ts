/**
 * REST API routes for the React frontend.
 */
import { Router, Request, Response } from 'express';
import { appState } from '../state';
import { SunsynkService } from '../services/sunsynk';
import { OctopusService } from '../services/octopus';
import { runChargeCheck } from '../jobs/chargeScheduler';

export function createRouter(
  sunsynk: SunsynkService,
  octopus: OctopusService,
  serial: string,
): Router {
  const router = Router();

  /** GET /api/status – full application state */
  router.get('/status', (_req: Request, res: Response) => {
    res.json(appState);
  });

  /** GET /api/charge-slots – current Octopus dispatch slots */
  router.get('/charge-slots', (_req: Request, res: Response) => {
    res.json({ slots: appState.chargeSlots, isInChargeSlot: appState.isInChargeSlot });
  });

  /** GET /api/settings – saved (startup) and current inverter settings */
  router.get('/settings', (_req: Request, res: Response) => {
    res.json({
      saved: appState.savedSettings,
      current: appState.currentSettings,
    });
  });

  /** POST /api/refresh – force an immediate scheduler run */
  router.post('/refresh', async (_req: Request, res: Response) => {
    try {
      await runChargeCheck(sunsynk, octopus, serial);
      res.json({ ok: true, state: appState });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  return router;
}
