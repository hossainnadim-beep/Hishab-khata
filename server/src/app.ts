import express, { type Request, type Response, type NextFunction } from 'express';
import { ApiError } from './lib/errors.ts';
import { requireAuth, companyContext } from './lib/auth.ts';
import { authRouter } from './modules/auth/routes.ts';
import { companiesRouter, companyRouter } from './modules/companies/routes.ts';
import { accountsRouter } from './modules/accounts/routes.ts';
import { ledgerRouter } from './modules/ledger/routes.ts';
import { taxRouter } from './modules/tax/routes.ts';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/companies', requireAuth, companiesRouter);

  const scoped = express.Router({ mergeParams: true });
  scoped.use('/', companyRouter);
  scoped.use('/accounts', accountsRouter);
  scoped.use('/ledger', ledgerRouter);
  scoped.use('/tax-codes', taxRouter);
  app.use('/api/companies/:companyId', requireAuth, companyContext, scoped);

  // Error handler: ApiError → its status; Postgres RAISE/constraint → 400.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err?.code && /^[0-9A-Z]{5}$/.test(err.code)) {
      return res.status(400).json({ error: err.message?.split('\n')[0] ?? 'Database error' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
