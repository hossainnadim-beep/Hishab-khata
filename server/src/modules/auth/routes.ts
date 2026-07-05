import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../../db.ts';
import { config } from '../../config.ts';
import { parse } from '../../lib/validate.ts';
import { badRequest, unauthorized } from '../../lib/errors.ts';
import { signToken, requireAuth, type AuthedRequest } from '../../lib/auth.ts';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

authRouter.post('/register', async (req, res, next) => {
  try {
    const body = parse(registerSchema, req.body);
    const existing = await db('users').where({ email: body.email.toLowerCase() }).first();
    if (existing) throw badRequest('An account with this email already exists');
    const [user] = await db('users')
      .insert({
        email: body.email.toLowerCase(),
        password_hash: await bcrypt.hash(body.password, config.bcryptRounds),
        name: body.name,
      })
      .returning(['id', 'email', 'name']);
    res.status(201).json({ token: signToken(user.id), user });
  } catch (e) {
    next(e);
  }
});

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = parse(loginSchema, req.body);
    const user = await db('users').where({ email: body.email.toLowerCase() }).first();
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
      throw unauthorized('Invalid email or password');
    }
    res.json({
      token: signToken(user.id),
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (e) {
    next(e);
  }
});

authRouter.get('/me', requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const user = await db('users').where({ id: req.userId }).first(['id', 'email', 'name']);
    const memberships = await db('memberships as m')
      .join('companies as c', 'c.id', 'm.company_id')
      .where('m.user_id', req.userId)
      .select('c.id', 'c.name', 'c.base_currency', 'm.role');
    res.json({ user, companies: memberships });
  } catch (e) {
    next(e);
  }
});
