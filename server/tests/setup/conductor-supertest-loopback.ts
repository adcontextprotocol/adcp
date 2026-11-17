// Conductor-local Supertest loopback fix. Kept out of the setup file so the
// setup file, which runs before every test file, does not import Supertest
// (~30 ms per file) when the fix is not wanted.
import type { Server } from 'node:net';
import request from 'supertest';

// On macOS, Supertest's `listen(0)` can bind an IPv6 socket while Supertest
// still builds an IPv4 URL (`127.0.0.1`). Conductor may already own the same
// numeric port in the separate IPv4 namespace, so the request reaches its
// JSON 404 handler instead of the Express app. Preserve Supertest's listener
// lifecycle and select the client loopback address from the actual socket
// family. Keep the patch Conductor-local; CI and ordinary local runs retain
// upstream Supertest behavior.
type SupertestInternal = InstanceType<typeof request.Test>;
type SupertestPrototype = {
  __adcpConductorLoopbackPatched?: true;
  serverAddress(this: SupertestInternal, app: Server, path: string): string;
};

export function installConductorSupertestLoopback(): void {
  const testPrototype = request.Test.prototype as unknown as SupertestPrototype;
  if (testPrototype.__adcpConductorLoopbackPatched) return;

  const originalServerAddress = testPrototype.serverAddress;
  testPrototype.serverAddress = function serverAddress(app, path) {
    const url = originalServerAddress.call(this, app, path);
    const address = app.address();
    const isIpv6 = address != null
      && typeof address !== 'string'
      && (address.family === 'IPv6' || (address.family as string | number) === 6);
    return isIpv6 ? url.replace('://127.0.0.1:', '://[::1]:') : url;
  };
  testPrototype.__adcpConductorLoopbackPatched = true;
}
