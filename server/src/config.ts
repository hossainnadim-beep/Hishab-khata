const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl:
    env.DATABASE_URL ?? 'postgres://localhost:5432/khata_dev',
  jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-in-production',
  jwtExpiresIn: '7d',
  bcryptRounds: 10,
};
