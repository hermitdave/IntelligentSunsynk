/**
 * REST API routes for the React frontend.
 */
import { Router, Request, Response } from 'express';
import { appState } from '../state';
import { SunsynkService } from '../services/sunsynk';
import { OctopusService } from '../services/octopus';
import { runChargeCheck } from '../jobs/chargeScheduler';
import { yesterdaySlots } from '../services/slotHistory';

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

  /** GET /api/slot-history – in-memory charge slot history */
  router.get('/slot-history', (_req: Request, res: Response) => {
    const nowIso = new Date().toISOString();
    res.json({
      fulfilled: appState.slotHistory.fulfilled,
      yesterday: yesterdaySlots(appState.slotHistory, nowIso),
      active: appState.slotHistory.active,
      futurePlanned: appState.slotHistory.futurePlanned,
    });
  });

  /** GET /api/settings – saved (startup) and current inverter settings */
  router.get('/settings', (_req: Request, res: Response) => {
    res.json({
      saved: appState.savedSettings,
      current: appState.currentSettings,
    });
  });

  /** GET /api/plant-overview – current Sunsynk plant overview payload */
  router.get('/plant-overview', async (_req: Request, res: Response) => {
    try {
      console.log('[API] GET /api/plant-overview received');
      const plantId = appState.plantId;
      if (!plantId) {
        console.warn('[API] /api/plant-overview rejected: SUNSYNK_PLANT_ID is not configured');
        res.status(400).json({ ok: false, error: 'SUNSYNK_PLANT_ID is not configured' });
        return;
      }

      const overview = await sunsynk.getPlantOverview(plantId);
      console.log('[API] /api/plant-overview success for plantId=' + plantId);
      res.json({ plantId, overview });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[API] /api/plant-overview failed:', message);
      res.status(500).json({ ok: false, error: message });
    }
  });

  /** GET /api/power-graph?date=YYYY-MM-DD – Sunsynk plant storage power graph */
  router.get('/power-graph', async (req: Request, res: Response) => {
    try {
      console.log('[API] GET /api/power-graph received', { date: req.query.date ?? null });
      const plantId = appState.plantId;
      if (!plantId) {
        console.warn('[API] /api/power-graph rejected: SUNSYNK_PLANT_ID is not configured');
        res.status(400).json({ ok: false, error: 'SUNSYNK_PLANT_ID is not configured' });
        return;
      }

      const rawDate = String(req.query.date ?? '');
      const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate);
      if (!isValidDate) {
        console.warn('[API] /api/power-graph rejected: invalid date format', { rawDate });
        res.status(400).json({ ok: false, error: 'Query parameter date must be YYYY-MM-DD' });
        return;
      }

      const graph = await sunsynk.getPlantPowerGraph(plantId, rawDate);
      console.log('[API] /api/power-graph success for plantId=' + plantId + ', date=' + rawDate);
      res.json({ plantId, date: rawDate, graph });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[API] /api/power-graph failed:', message);
      res.status(500).json({ ok: false, error: message });
    }
  });

  /** GET /api/energy-flow – current Sunsynk plant energy flow payload */
  router.get('/energy-flow', async (_req: Request, res: Response) => {
    try {
      console.log('[API] GET /api/energy-flow received');
      const plantId = appState.plantId;
      if (!plantId) {
        console.warn('[API] /api/energy-flow rejected: SUNSYNK_PLANT_ID is not configured');
        res.status(400).json({ ok: false, error: 'SUNSYNK_PLANT_ID is not configured' });
        return;
      }

      const flow = await sunsynk.getPlantEnergyFlow(plantId);
      console.log('[API] /api/energy-flow success for plantId=' + plantId);
      res.json({ plantId, flow });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[API] /api/energy-flow failed:', message);
      res.status(500).json({ ok: false, error: message });
    }
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
