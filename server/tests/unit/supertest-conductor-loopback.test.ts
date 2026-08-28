import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { installConductorSupertestLoopback } from '../setup/revenue-tracking-env.js';

type PatchableSupertestPrototype = typeof request.Test.prototype & {
  __adcpConductorLoopbackPatched?: true;
};
const testPrototype = request.Test.prototype as PatchableSupertestPrototype;
const originalServerAddress = testPrototype.serverAddress;
const originalPatchMarker = testPrototype.__adcpConductorLoopbackPatched;

installConductorSupertestLoopback();

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve())),
  ));
});

afterAll(() => {
  testPrototype.serverAddress = originalServerAddress;
  if (originalPatchMarker) testPrototype.__adcpConductorLoopbackPatched = originalPatchMarker;
  else delete testPrototype.__adcpConductorLoopbackPatched;
});

describe('Conductor Supertest loopback selection', () => {
  it('routes a fresh app through the family of its ephemeral listener', async () => {
    const app = express().get('/ok', (_req, res) => res.json({ ok: true }));

    const response = await request(app).get('/ok');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('preserves an already-listening IPv4 server', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ family: 'IPv4' }));
    });
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const response = await request(server).get('/');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ family: 'IPv4' });
  });

  it('preserves an already-listening IPv6 server and repeated installation', async () => {
    const installedServerAddress = testPrototype.serverAddress;
    installConductorSupertestLoopback();
    expect(testPrototype.serverAddress).toBe(installedServerAddress);
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ family: 'IPv6' }));
    });
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '::1', resolve));

    const response = await request(server).get('/');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ family: 'IPv6' });
  });
});
