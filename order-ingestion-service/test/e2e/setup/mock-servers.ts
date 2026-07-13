import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Spawns the REAL mock customer APIs — the project we are forbidden to modify and
 * treat as a third party's live service.
 *
 * Two instances, because they need different rate limits and each keeps its own
 * cursor:
 *
 *   4101 — the everyday one (their default 60 req/min)
 *   4102 — throttled to 3 req/min, so a 429 can actually be provoked
 *
 * Spawning them here rather than asking a human to start something first is the
 * difference between a check that runs and a check that rots.
 */
export const MOCK_URL = 'http://localhost:4101';
export const THROTTLED_MOCK_URL = 'http://localhost:4102';

const MOCKS_DIR = resolve(__dirname, '../../../../mock-customer-apis');

const processes: ChildProcess[] = [];

function startMock(port: number, rateLimitPerMinute: number): ChildProcess {
  const child = spawn('node', ['main.js'], {
    cwd: MOCKS_DIR,
    env: {
      ...process.env,
      MOCKS_PORT: String(port),
      // customer-c.js reads this per request, and dotenv does not overwrite a
      // variable that is already set — so this wins over their .env file.
      MOCKS_CUSTOMER_C_RATE_LIMIT_PER_MINUTE: String(rateLimitPerMinute),
    },
    stdio: 'ignore',
  });

  processes.push(child);
  return child;
}

async function waitUntilUp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${url}/customer-b/orders`);
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error(`Mock customer API at ${url} never came up`);
}

export async function setup(): Promise<void> {
  startMock(4101, 60);
  startMock(4102, 3);

  await Promise.all([waitUntilUp(MOCK_URL), waitUntilUp(THROTTLED_MOCK_URL)]);
}

export function teardown(): void {
  for (const child of processes) {
    child.kill('SIGKILL');
  }
}
