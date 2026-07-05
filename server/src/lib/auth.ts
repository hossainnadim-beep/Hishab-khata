import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { unauthorized, forbidden } from './errors.ts';

export type Role = 'owner' | 'accountant' | 'data_entry' | 'read_only';
const RANK: Record<Role, number> = { read_only: 0, data_entry: 1, accountant: 2, owner: 3 };

export interface AuthedRequest extends Request {
  userId?: string;
  companyId?: string;
  role?: Role;
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized('Missing bearer token'));
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string };
    req.userId = payload.sub;
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}

/** Loads membership for :companyId, attaches companyId + role. */
export async function companyContext(req: AuthedRequest, _res: Response, next: NextFunction) {
  const companyId = req.params.companyId;
  const member = await db('memberships')
    .where({ user_id: req.userId, company_id: companyId })
    .first();
  if (!member) return next(forbidden('Not a member of this company'));
  req.companyId = companyId;
  req.role = member.role as Role;
  next();
}

export function requireRole(min: Role) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    if (!req.role || RANK[req.role] < RANK[min]) {
      return next(forbidden(`Requires ${min} role or higher`));
    }
    next();
  };
}
