import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { BrandManager } from '../../src/brand-manager.js';
import { injectConfigIntoHtml } from '../../src/utils/html-config.js';

// Mock axios
vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('UTF-8 encoding', () => {
  describe('BrandManager external fetch encoding', () => {
    let manager: BrandManager;

    beforeEach(() => {
      manager = new BrandManager();
      vi.clearAllMocks();
    });

    afterEach(() => {
      manager.clearCache();
    });

    it('passes responseEncoding utf8 when fetching brand.json', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          house: { domain: 'example.se', name: 'Exempel AB' },
          brands: [{
            id: 'exempel',
            names: [{ sv: 'Exempel' }],
            keller_type: 'master',
            description: 'Sveriges bästa märke för alla tillfällen',
          }],
        },
      });

      await manager.validateDomain('example.se');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://example.se/.well-known/brand.json',
        expect.objectContaining({
          responseEncoding: 'utf8',
        }),
      );
    });

    it('preserves non-ASCII characters from external brand.json', async () => {
      const swedishDescription = 'Sveriges mest älskade choklad för alla smaker och tillfällen';

      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          house: { domain: 'marabou.com', name: 'Marabou' },
          brands: [{
            id: 'marabou',
            names: [{ sv: 'Marabou' }],
            keller_type: 'master',
            description: swedishDescription,
          }],
        },
      });

      const result = await manager.validateDomain('marabou.com');

      expect(result.valid).toBe(true);
      expect(result.raw_data.brands[0].description).toBe(swedishDescription);
    });

    it('preserves CJK characters from external brand.json', async () => {
      const japaneseDescription = '日本で最も愛されているブランド';

      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          house: { domain: 'example.jp', name: 'テスト' },
          brands: [{
            id: 'test',
            names: [{ ja: 'テスト' }],
            keller_type: 'master',
            description: japaneseDescription,
          }],
        },
      });

      const result = await manager.validateDomain('example.jp');

      expect(result.valid).toBe(true);
      expect(result.raw_data.brands[0].description).toBe(japaneseDescription);
    });
  });

  describe('HTML config charset', () => {
    it('injectConfigIntoHtml preserves non-ASCII in injected HTML', () => {
      const html = '<!doctype html><html><head><meta charset="UTF-8"></head><body></body></html>';
      const result = injectConfigIntoHtml(html);

      // Config script should be injected before </head>
      expect(result).toContain('window.__APP_CONFIG__');
      expect(result).toContain('</head>');
    });

    it('injectConfigIntoHtml handles user with non-ASCII name', () => {
      const html = '<!doctype html><html><head></head><body></body></html>';
      const user = {
        id: 'usr_1',
        email: 'test@example.se',
        firstName: 'Björk',
        lastName: 'Guðmundsdóttir',
      };

      const result = injectConfigIntoHtml(html, user);

      // The injected config should contain the user's name as JSON
      expect(result).toContain('Björk');
      expect(result).toContain('Guðmundsdóttir');
    });
  });

  describe('Brandfetch API encoding', () => {
    it('passes responseEncoding utf8 to Brandfetch API', async () => {
      // Reset modules to get fresh import with mocked axios
      vi.resetModules();
      vi.stubEnv('BRANDFETCH_API_KEY', 'test-key');

      const axiosMock = vi.fn().mockResolvedValue({
        status: 200,
        data: {
          id: 'test',
          name: 'Marabou',
          domain: 'marabou.com',
          claimed: false,
          verified: false,
          description: 'Sveriges mest älskade choklad',
          logos: [],
          colors: [],
          fonts: [],
        },
      });

      vi.doMock('axios', () => ({
        default: { get: axiosMock, isAxiosError: vi.fn() },
        isAxiosError: vi.fn(),
      }));

      const { fetchBrandData, clearCache } = await import('../../src/services/brandfetch.js');
      clearCache();

      await fetchBrandData('marabou.com');

      expect(axiosMock).toHaveBeenCalledWith(
        expect.stringContaining('marabou.com'),
        expect.objectContaining({
          responseEncoding: 'utf8',
        }),
      );

      vi.unstubAllEnvs();
    });
  });

  describe('Database client encoding', () => {
    it('registers connect handler that sets UTF-8 encoding', async () => {
      vi.resetModules();

      const mockQuery = vi.fn().mockResolvedValue({});
      const mockClient = { query: mockQuery };
      const connectHandlers: Array<(client: unknown) => void> = [];

      const mockPool = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'connect') connectHandlers.push(handler);
        }),
        query: vi.fn(),
        connect: vi.fn(),
        end: vi.fn(),
      };

      vi.doMock('pg', () => ({
        Pool: class MockPool {
          on = mockPool.on;
          query = mockPool.query;
          connect = mockPool.connect;
          end = mockPool.end;
        },
      }));

      const { initializeDatabase } = await import('../../src/db/client.js');
      initializeDatabase({ connectionString: 'postgresql://test:test@localhost/test' });

      // Verify connect handler was registered
      expect(connectHandlers.length).toBe(1);

      // Simulate a new connection
      connectHandlers[0](mockClient);

      // Should have called SET client_encoding
      expect(mockQuery).toHaveBeenCalledWith("SET client_encoding = 'UTF8'");
    });

    it('handles SET client_encoding failure gracefully', async () => {
      vi.resetModules();

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockError = new Error('connection dropped');
      const mockQuery = vi.fn().mockRejectedValue(mockError);
      const mockClient = { query: mockQuery };
      const connectHandlers: Array<(client: unknown) => void> = [];

      const mockPool = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'connect') connectHandlers.push(handler);
        }),
        query: vi.fn(),
        connect: vi.fn(),
        end: vi.fn(),
      };

      vi.doMock('pg', () => ({
        Pool: class MockPool {
          on = mockPool.on;
          query = mockPool.query;
          connect = mockPool.connect;
          end = mockPool.end;
        },
      }));

      const { initializeDatabase } = await import('../../src/db/client.js');
      initializeDatabase({ connectionString: 'postgresql://test:test@localhost/test' });

      // Simulate a new connection where SET fails
      connectHandlers[0](mockClient);

      // Wait for the promise rejection to be caught
      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          'Failed to set client_encoding on new connection:',
          mockError,
        );
      });

      consoleSpy.mockRestore();
    });
  });
});
