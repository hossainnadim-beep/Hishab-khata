import { Router, type Response } from 'express';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { config } from '../../config.ts';
import { db } from '../../db.ts';
import type { AuthedRequest } from '../../lib/auth.ts';

/**
 * Server-sent events: one stream per browser tab. A Postgres trigger NOTIFYs
 * 'company_events' with the company id whenever an audit record commits, so
 * subscribers learn about every posting the moment it is durable.
 */
const subscribers = new Map<string, Set<Response>>();
let listener: pg.Client | null = null;

async function ensureListener() {
  if (listener) return;
  listener = new pg.Client({ connectionString: config.databaseUrl });
  await listener.connect();
  await listener.query('LISTEN company_events');
  listener.on('notification', (msg) => {
    const companyId = msg.payload;
    if (!companyId) return;
    for (const res of subscribers.get(companyId) ?? []) {
      res.write(`data: ${JSON.stringify({ companyId, at: Date.now() })}\n\n`);
    }
  });
  listener.on('error', () => {
    listener = null; // reconnect lazily on next subscribe
  });
}

export const eventsRouter = Router({ mergeParams: true });

/**
 * EventSource cannot set Authorization headers, so this endpoint accepts the
 * JWT as a query param and re-checks membership itself.
 */
eventsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const token = String(req.query.token ?? '');
    let userId: string;
    try {
      userId = (jwt.verify(token, config.jwtSecret) as { sub: string }).sub;
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const companyId = req.params.companyId;
    const member = await db('memberships')
      .where({ user_id: userId, company_id: companyId })
      .first();
    if (!member) return res.status(403).json({ error: 'Not a member' });

    await ensureListener();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');

    if (!subscribers.has(companyId)) subscribers.set(companyId, new Set());
    subscribers.get(companyId)!.add(res);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      subscribers.get(companyId)?.delete(res);
    });
  } catch (e) {
    next(e);
  }
});
