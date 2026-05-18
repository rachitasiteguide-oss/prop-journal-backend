// HTTP/controller-boundary tests for the sweep + walk-forward endpoints.
//
// Mounts the real controllers on a fresh Express app with a stub auth
// middleware and the real global error handler. The service layer is mocked
// so these tests assert ONLY the controller contract: Zod validation,
// status codes, response envelope, and AppError → HTTP status mapping.
// (Service internals are covered by the integration test.)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../services/sweepService', () => ({
  createSweep:           vi.fn(),
  getSweep:              vi.fn(),
  listSweepsForSession:  vi.fn(),
}));
vi.mock('../../services/walkForwardService', () => ({
  createWalkForward:           vi.fn(),
  getWalkForward:              vi.fn(),
  listWalkForwardsForSession:  vi.fn(),
}));

import * as svc from '../../services/sweepService';
import * as wfSvc from '../../services/walkForwardService';
import {
  createSweepHandler, getSweepHandler, listSweepsHandler,
  createWalkForwardHandler, getWalkForwardHandler, listWalkForwardsHandler,
} from '../sweepController';
import { AppError, globalErrorHandler } from '../../middlewares/errorHandler';

function makeApp() {
  const app = express();
  app.use(express.json());
  // Stub auth — inject a fake authenticated user.
  app.use((req, _res, next) => {
    (req as unknown as { currentUser: { userId: string } }).currentUser = { userId: 'u1' };
    next();
  });
  app.post('/backtesting/sessions/:id/sweep',        createSweepHandler);
  app.get('/backtesting/sessions/:id/sweeps',        listSweepsHandler);
  app.get('/backtesting/sweeps/:id',                 getSweepHandler);
  app.post('/backtesting/sessions/:id/walkforward',  createWalkForwardHandler);
  app.get('/backtesting/sessions/:id/walkforwards',  listWalkForwardsHandler);
  app.get('/backtesting/walkforwards/:id',           getWalkForwardHandler);
  app.use(globalErrorHandler);
  return app;
}

const app = makeApp();

const VALID_BASE = {
  strategyType: 'MA_CROSS',
  strategyConfig: { fastPeriod: 3, slowPeriod: 8 },
  volume: 1, stopLossPct: 0.02, takeProfitRatio: 2,
};

beforeEach(() => vi.clearAllMocks());

// ── Sweep ────────────────────────────────────────────────────────────────────

describe('POST /backtesting/sessions/:id/sweep', () => {
  it('202 + envelope on a valid body', async () => {
    vi.mocked(svc.createSweep).mockResolvedValue({ id: 'sweep1', status: 'PENDING' } as never);
    const res = await request(app)
      .post('/backtesting/sessions/sess1/sweep')
      .send({ axis: { paramKey: 'fastPeriod', values: [2, 3, 5] }, baseConfig: VALID_BASE });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'success', data: { id: 'sweep1', status: 'PENDING' } });
    expect(svc.createSweep).toHaveBeenCalledWith('u1', 'sess1',
      { axis: { paramKey: 'fastPeriod', values: [2, 3, 5] }, baseConfig: VALID_BASE });
  });

  it('400 when axis.values is empty', async () => {
    const res = await request(app)
      .post('/backtesting/sessions/sess1/sweep')
      .send({ axis: { paramKey: 'fastPeriod', values: [] }, baseConfig: VALID_BASE });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
    expect(svc.createSweep).not.toHaveBeenCalled();
  });

  it('400 when axis.values exceeds 50', async () => {
    const res = await request(app)
      .post('/backtesting/sessions/sess1/sweep')
      .send({ axis: { paramKey: 'fastPeriod', values: Array.from({ length: 51 }, (_, i) => i) }, baseConfig: VALID_BASE });
    expect(res.status).toBe(400);
  });

  it('400 when axis.values contains a non-number', async () => {
    const res = await request(app)
      .post('/backtesting/sessions/sess1/sweep')
      .send({ axis: { paramKey: 'fastPeriod', values: [1, 'oops'] }, baseConfig: VALID_BASE });
    expect(res.status).toBe(400);
  });

  it('400 when paramKey is missing', async () => {
    const res = await request(app)
      .post('/backtesting/sessions/sess1/sweep')
      .send({ axis: { values: [1, 2] }, baseConfig: VALID_BASE });
    expect(res.status).toBe(400);
  });

  it('maps AppError(404) from the service to HTTP 404', async () => {
    vi.mocked(svc.createSweep).mockRejectedValue(new AppError('Session not found', 404));
    const res = await request(app)
      .post('/backtesting/sessions/missing/sweep')
      .send({ axis: { paramKey: 'fastPeriod', values: [2, 3] }, baseConfig: VALID_BASE });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: 'error', message: 'Session not found' });
  });

  it('maps AppError(400 non-AUTO) to HTTP 400', async () => {
    vi.mocked(svc.createSweep).mockRejectedValue(new AppError('Sweeps are only supported on AUTO sessions.', 400));
    const res = await request(app)
      .post('/backtesting/sessions/sess1/sweep')
      .send({ axis: { paramKey: 'fastPeriod', values: [2, 3] }, baseConfig: VALID_BASE });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/AUTO/);
  });
});

describe('GET sweep read endpoints', () => {
  it('GET /sweeps/:id returns the row', async () => {
    vi.mocked(svc.getSweep).mockResolvedValue({ id: 'sweep1', status: 'COMPLETED' } as never);
    const res = await request(app).get('/backtesting/sweeps/sweep1');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('COMPLETED');
    expect(svc.getSweep).toHaveBeenCalledWith('u1', 'sweep1');
  });

  it('GET /sweeps/:id maps 404', async () => {
    vi.mocked(svc.getSweep).mockRejectedValue(new AppError('Sweep not found', 404));
    const res = await request(app).get('/backtesting/sweeps/nope');
    expect(res.status).toBe(404);
  });

  it('GET /sessions/:id/sweeps returns a list', async () => {
    vi.mocked(svc.listSweepsForSession).mockResolvedValue([{ id: 'a' }, { id: 'b' }] as never);
    const res = await request(app).get('/backtesting/sessions/sess1/sweeps');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });
});

// ── Walk-forward ─────────────────────────────────────────────────────────────

describe('POST /backtesting/sessions/:id/walkforward', () => {
  const validWf = {
    axis: { paramKey: 'fastPeriod', values: [2, 3, 5] },
    baseConfig: VALID_BASE,
    windowsConfig: { windows: 4, isRatio: 0.7, selectionMetric: 'sharpe' },
  };

  it('202 + envelope on a valid body', async () => {
    vi.mocked(wfSvc.createWalkForward).mockResolvedValue({ id: 'wf1', status: 'PENDING' } as never);
    const res = await request(app).post('/backtesting/sessions/sess1/walkforward').send(validWf);
    expect(res.status).toBe(202);
    expect(res.body.data.id).toBe('wf1');
    expect(wfSvc.createWalkForward).toHaveBeenCalledWith('u1', 'sess1', validWf);
  });

  it('400 when fewer than 2 axis values', async () => {
    const res = await request(app).post('/backtesting/sessions/sess1/walkforward')
      .send({ ...validWf, axis: { paramKey: 'fastPeriod', values: [3] } });
    expect(res.status).toBe(400);
    expect(wfSvc.createWalkForward).not.toHaveBeenCalled();
  });

  it('400 when windows < 2', async () => {
    const res = await request(app).post('/backtesting/sessions/sess1/walkforward')
      .send({ ...validWf, windowsConfig: { windows: 1, isRatio: 0.7, selectionMetric: 'sharpe' } });
    expect(res.status).toBe(400);
  });

  it('400 when windows > 12', async () => {
    const res = await request(app).post('/backtesting/sessions/sess1/walkforward')
      .send({ ...validWf, windowsConfig: { windows: 20, isRatio: 0.7, selectionMetric: 'sharpe' } });
    expect(res.status).toBe(400);
  });

  it('400 when isRatio out of [0.3,0.9]', async () => {
    const res = await request(app).post('/backtesting/sessions/sess1/walkforward')
      .send({ ...validWf, windowsConfig: { windows: 4, isRatio: 0.95, selectionMetric: 'sharpe' } });
    expect(res.status).toBe(400);
  });

  it('400 on unknown selectionMetric', async () => {
    const res = await request(app).post('/backtesting/sessions/sess1/walkforward')
      .send({ ...validWf, windowsConfig: { windows: 4, isRatio: 0.7, selectionMetric: 'magic' } });
    expect(res.status).toBe(400);
  });

  it('maps service AppError(400 insufficient candles)→ 400', async () => {
    vi.mocked(wfSvc.createWalkForward).mockRejectedValue(
      new AppError('Not enough candles for 12 windows', 400));
    const res = await request(app).post('/backtesting/sessions/sess1/walkforward').send(validWf);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/candles/);
  });

  it('GET /walkforwards/:id returns the row', async () => {
    vi.mocked(wfSvc.getWalkForward).mockResolvedValue({ id: 'wf1', status: 'COMPLETED' } as never);
    const res = await request(app).get('/backtesting/walkforwards/wf1');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('COMPLETED');
  });

  it('GET /sessions/:id/walkforwards returns a list', async () => {
    vi.mocked(wfSvc.listWalkForwardsForSession).mockResolvedValue([{ id: 'wf1' }] as never);
    const res = await request(app).get('/backtesting/sessions/sess1/walkforwards');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});
