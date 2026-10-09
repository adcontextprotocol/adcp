import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const proxyAddress = require('proxy-addr') as {
  compile(ranges: string[]): (address: string) => boolean;
};

describe('proxy address trust boundaries', () => {
  // CVE-2026-90711: these IPv6 ranges previously trusted every IPv4 peer.
  it.each(['::ffff:10.0.0.0/8', '::/1'])(
    'does not accept a spoofed forwarded identity through %s',
    async (subnet) => {
      const app = express();
      app.set('trust proxy', subnet);
      app.get('/identity', (req, res) => res.json({ ip: req.ip, ips: req.ips }));

      const response = await request(app)
        .get('/identity')
        .set('X-Forwarded-For', '198.51.100.40');

      expect(response.status).toBe(200);
      expect(['127.0.0.1', '::ffff:127.0.0.1']).toContain(response.body.ip);
      expect(response.body.ips).toEqual([]);
    },
  );

  it('retains correctly specified mapped and plain IPv4 trust ranges', () => {
    for (const subnet of ['::ffff:10.0.0.0/104', '10.0.0.0/8']) {
      const trust = proxyAddress.compile([subnet]);
      expect(trust('10.1.2.3')).toBe(true);
      expect(trust('198.51.100.40')).toBe(false);
    }
  });

  it('accepts forwarded identity from an explicitly trusted loopback proxy', async () => {
    const app = express();
    app.set('trust proxy', 'loopback');
    app.get('/identity', (req, res) => res.json({ ip: req.ip, ips: req.ips }));

    const response = await request(app)
      .get('/identity')
      .set('X-Forwarded-For', '198.51.100.40');

    expect(response.status).toBe(200);
    expect(response.body.ip).toBe('198.51.100.40');
    expect(response.body.ips).toEqual(['198.51.100.40']);
  });
});
