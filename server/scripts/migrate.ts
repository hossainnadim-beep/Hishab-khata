import { db } from '../src/db.ts';
import { migrationSource } from '../src/migrations/index.ts';

const cmd = process.argv[2] ?? 'latest';

try {
  if (cmd === 'rollback') {
    const [batch, applied] = await db.migrate.rollback({ migrationSource });
    console.log(`Rolled back batch ${batch}: ${applied.join(', ') || '(nothing)'}`);
  } else {
    const [batch, applied] = await db.migrate.latest({ migrationSource });
    console.log(`Applied batch ${batch}: ${applied.join(', ') || '(up to date)'}`);
  }
} finally {
  await db.destroy();
}
