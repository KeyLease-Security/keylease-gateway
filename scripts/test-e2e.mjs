#!/usr/bin/env node
import http from 'node:http';
import { Keypair } from '../packages/cli/node_modules/@stellar/stellar-sdk/lib/esm/index.js';
import { mintSessionToken } from '../packages/cli/dist/token.js';
import { buildProxyServer } from '../packages/proxy/dist/server.js';
import { LeaseVerifier } from '../packages/proxy/dist/verifier.js';

async function main() {
  console.log('🚀 Starting end-to-end test suite...');
  const serversToClose = [];

  try {
    // 1. Spin up mock protected upstream API
    const upstreamServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-upstream-ok': 'true',
      });
      res.end(JSON.stringify({ message: 'protected data', path: req.url }));
    });

    await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    serversToClose.push(upstreamServer);
    const upstreamPort = upstreamServer.address().port;
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
    console.log(`✓ Upstream API listening at ${upstreamUrl}`);

    // 2. Set up simulated Soroban contract state
    const consumer = Keypair.random();
    const provider = Keypair.random();
    const now = Math.floor(Date.now() / 1000);

    const leases = new Map([
      [
        'lease-valid',
        {
          leaseId: 'lease-valid',
          service: 'weather-api',
          provider: provider.publicKey(),
          consumer: consumer.publicKey(),
          callsLimit: 10,
          callsUsed: 2,
          expiresAt: now + 3600,
          active: true,
          settled: false,
          pricePaid: 10000,
        },
      ],
      [
        'lease-expired',
        {
          leaseId: 'lease-expired',
          service: 'weather-api',
          provider: provider.publicKey(),
          consumer: consumer.publicKey(),
          callsLimit: 10,
          callsUsed: 1,
          expiresAt: now - 60, // expired
          active: true,
          settled: false,
          pricePaid: 10000,
        },
      ],
      [
        'lease-exhausted',
        {
          leaseId: 'lease-exhausted',
          service: 'weather-api',
          provider: provider.publicKey(),
          consumer: consumer.publicKey(),
          callsLimit: 5,
          callsUsed: 5, // quota exhausted
          expiresAt: now + 3600,
          active: true,
          settled: false,
          pricePaid: 5000,
        },
      ],
    ]);

    const stateProvider = {
      async getLeaseState(leaseId) {
        const lease = leases.get(leaseId);
        if (!lease) throw new Error(`lease ${leaseId} not found`);
        return lease;
      },
    };

    // 3. Boot the proxy
    const verifier = new LeaseVerifier({ provider: stateProvider, cacheTtlMs: 1000 });
    const proxyApp = buildProxyServer({
      upstream: upstreamUrl,
      verifier,
    });

    await proxyApp.listen({ port: 0, host: '127.0.0.1' });
    serversToClose.push(proxyApp.server);
    const proxyPort = proxyApp.server.address().port;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    console.log(`✓ Proxy server listening at ${proxyUrl}`);

    // 4. Assert: Allowed request 200 + x-keylease-calls-remaining
    console.log('Testing allowed request...');
    const validToken = mintSessionToken({
      leaseId: 'lease-valid',
      consumerSecret: consumer.secret(),
      issuedAt: now,
      expiresAt: now + 3600,
    });

    const resAllowed = await fetch(`${proxyUrl}/v1/weather`, {
      headers: { authorization: `Bearer ${validToken}` },
    });
    if (resAllowed.status !== 200) {
      throw new Error(`Expected 200, got ${resAllowed.status}: ${await resAllowed.text()}`);
    }
    const remainingHeader = resAllowed.headers.get('x-keylease-calls-remaining');
    if (!remainingHeader) {
      throw new Error('Expected x-keylease-calls-remaining header');
    }
    console.log(`✓ Allowed request passed: 200 OK (calls remaining: ${remainingHeader})`);

    // 5. Assert: Forged token 401
    console.log('Testing forged token...');
    const parts = validToken.split('.');
    const forgedToken = `${parts[0]}.${parts[1]}.${Buffer.alloc(64, 1).toString('base64url')}`;
    const resForged = await fetch(`${proxyUrl}/v1/weather`, {
      headers: { authorization: `Bearer ${forgedToken}` },
    });
    if (resForged.status !== 401) {
      throw new Error(`Expected 401 for forged token, got ${resForged.status}`);
    }
    console.log('✓ Forged token rejected: 401 Unauthorized');

    // 6. Assert: Expired lease 403
    console.log('Testing expired lease...');
    const expiredToken = mintSessionToken({
      leaseId: 'lease-expired',
      consumerSecret: consumer.secret(),
      issuedAt: now,
      expiresAt: now + 3600,
    });
    const resExpired = await fetch(`${proxyUrl}/v1/weather`, {
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    if (resExpired.status !== 403) {
      throw new Error(`Expected 403 for expired lease, got ${resExpired.status}`);
    }
    console.log('✓ Expired lease rejected: 403 Forbidden');

    // 7. Assert: Quota exhausted 403
    console.log('Testing quota exhausted...');
    const exhaustedToken = mintSessionToken({
      leaseId: 'lease-exhausted',
      consumerSecret: consumer.secret(),
      issuedAt: now,
      expiresAt: now + 3600,
    });
    const resExhausted = await fetch(`${proxyUrl}/v1/weather`, {
      headers: { authorization: `Bearer ${exhaustedToken}` },
    });
    if (resExhausted.status !== 403) {
      throw new Error(`Expected 403 for exhausted quota, got ${resExhausted.status}`);
    }
    console.log('✓ Exhausted quota rejected: 403 Forbidden');

    console.log('🎉 All end-to-end assertions passed successfully!');
  } finally {
    console.log('🧹 Cleaning up server resources...');
    for (const server of serversToClose) {
      try {
        server.close();
      } catch {
        // ignore
      }
    }
    console.log('✓ Cleanup complete.');
  }
}

main().catch((err) => {
  console.error('❌ E2E Test Failed:', err);
  process.exit(1);
});
