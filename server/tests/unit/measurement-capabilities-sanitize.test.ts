import { describe, it, expect } from 'vitest';
import { sanitizeMeasurementCapabilities } from '../../src/capabilities.js';

describe('sanitizeMeasurementCapabilities', () => {
  it('accepts a minimal valid metric', () => {
    const out = sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'attention_units' }],
    });
    expect(out.metrics).toHaveLength(1);
    expect(out.metrics[0].metric_id).toBe('attention_units');
  });

  it('preserves all optional fields when present', () => {
    const out = sanitizeMeasurementCapabilities({
      metrics: [{
        metric_id: 'attention_units',
        standard_reference: 'https://iabtechlab.com/standards/attention',
        unit: 'score',
        description: 'Eye-tracking-based attention score (0-100).',
        methodology_url: 'https://vendor.example/docs/attention',
        methodology_version: 'v2.1',
        accreditations: [{
          accrediting_body: 'MRC',
          certification_id: 'MRC-ATT-2026-001',
          valid_until: '2027-12-31',
          evidence_url: 'https://mediaratingcouncil.org/x',
        }],
      }],
    });
    const m = out.metrics[0];
    expect(m.standard_reference).toBe('https://iabtechlab.com/standards/attention');
    expect(m.unit).toBe('score');
    expect(m.methodology_version).toBe('v2.1');
    expect(m.accreditations?.[0].verified_by_aao).toBe(false);
    expect(m.accreditations?.[0].accrediting_body).toBe('MRC');
  });

  it('preserves a display name and collapses whitespace in it', () => {
    const out = sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'givt_rate', name: '  Invalid Traffic\nRate (GIVT) ' }],
    });
    expect(out.metrics[0].name).toBe('Invalid Traffic Rate (GIVT)');
  });

  it('omits name when the vendor does not send one', () => {
    const out = sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'attention_units' }],
    });
    expect(out.metrics[0]).not.toHaveProperty('name');
  });

  it('rejects a name longer than 100 chars', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', name: 'x'.repeat(101) }],
    })).toThrow(/name: exceeds 100/);
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', name: ' \t ' }],
    })).toThrow(/name: empty/);
  });

  it('rejects a non-string name', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', name: 42 }],
    })).toThrow(/name: expected string/);
  });

  it('rejects scriptish content in name', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', name: '<script>alert(1)</script>' }],
    })).toThrow(/scriptish/);
  });

  it('accepts a name of exactly 100 chars', () => {
    const out = sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', name: 'x'.repeat(100) }],
    });
    expect(out.metrics[0].name).toHaveLength(100);
  });

  it('checks length before trimming padding whitespace', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', name: `  ${'x'.repeat(99)}` }],
    })).toThrow(/name: exceeds 100/);
  });

  it('rejects a null name', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', name: null }],
    })).toThrow(/name: expected string/);
  });

  it('strips control, zero-width, and bidi-override characters from name', () => {
    const out = sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', name: 'Atten\u0007tion\u200B \u202ESco\u0085re' }],
    });
    expect(out.metrics[0].name).toBe('Attention Score');
  });

  it('rejects a name made only of invisible characters', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', name: '\u200B\u202E\uFEFF' }],
    })).toThrow(/name: empty/);
  });

  it('rejects fullwidth-obfuscated scriptish content in name after NFKC', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', name: 'x ｏｎｌｏａｄ＝y' }],
    })).toThrow(/scriptish/);
  });

  it('rejects scriptish content split by any invisible format character', () => {
    for (const sep of ['\u200B', '\u2060', '\u00AD', '\u2063', '\u206A', '\u180E']) {
      expect(() => sanitizeMeasurementCapabilities({
        metrics: [{ metric_id: 'm', name: `x on${sep}load=y` }],
      })).toThrow(/scriptish/);
      expect(() => sanitizeMeasurementCapabilities({
        metrics: [{ metric_id: 'm', name: `<scr${sep}ipt>` }],
      })).toThrow(/scriptish/);
    }
  });

  it('accepts duplicate names across distinct metric_ids', () => {
    const out = sanitizeMeasurementCapabilities({
      metrics: [
        { metric_id: 'attention_units', name: 'Attention' },
        { metric_id: 'attention_seconds', name: 'Attention' },
      ],
    });
    expect(out.metrics.map(m => m.name)).toEqual(['Attention', 'Attention']);
  });

  it('always sets verified_by_aao=false on accreditations even if vendor passes true', () => {
    const out = sanitizeMeasurementCapabilities({
      metrics: [{
        metric_id: 'attention_units',
        accreditations: [{ accrediting_body: 'MRC', verified_by_aao: true }],
      }],
    });
    expect(out.metrics[0].accreditations?.[0].verified_by_aao).toBe(false);
  });

  it('rejects empty metrics array', () => {
    expect(() => sanitizeMeasurementCapabilities({ metrics: [] }))
      .toThrow(/empty array/);
  });

  it('rejects more than 500 metrics', () => {
    const metrics = Array.from({ length: 501 }, (_, i) => ({ metric_id: `m_${i}` }));
    expect(() => sanitizeMeasurementCapabilities({ metrics }))
      .toThrow(/exceeds 500/);
  });

  it('rejects duplicate metric_ids', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'attention_units' }, { metric_id: 'attention_units' }],
    })).toThrow(/duplicate/);
  });

  it('rejects scriptish content in description', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', description: 'attention <script>alert(1)</script>' }],
    })).toThrow(/scriptish/);
  });

  it('rejects javascript: URIs', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', methodology_url: 'javascript:alert(1)' }],
    })).toThrow(/scheme.*not allowed|invalid URI/);
  });

  it('rejects ftp: URIs', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{
        metric_id: 'm',
        accreditations: [{ accrediting_body: 'MRC', evidence_url: 'ftp://example.com/cert' }],
      }],
    })).toThrow(/scheme.*not allowed/);
  });

  it('strips control characters from description', () => {
    const out = sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', description: 'normal\x00\x07\x1Btext' }],
    });
    expect(out.metrics[0].description).toBe('normaltext');
  });

  it('preserves tab, newline, and carriage return in description', () => {
    const out = sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', description: 'line1\nline2\tcol2\rmore' }],
    });
    expect(out.metrics[0].description).toBe('line1\nline2\tcol2\rmore');
  });

  it('rejects description over 2000 chars', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', description: 'a'.repeat(2001) }],
    })).toThrow(/exceeds 2000/);
  });

  it('rejects non-ISO date in valid_until', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{
        metric_id: 'm',
        accreditations: [{ accrediting_body: 'MRC', valid_until: 'next year' }],
      }],
    })).toThrow(/ISO 8601 date/);
  });

  it('rejects URI fields exceeding 2048 chars', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2050);
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', standard_reference: longUrl }],
    })).toThrow(/exceeds 2048|invalid URI/);
  });

  it('rejects more than 32 accreditations on one metric', () => {
    const accreditations = Array.from({ length: 33 }, () => ({ accrediting_body: 'MRC' }));
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ metric_id: 'm', accreditations }],
    })).toThrow(/exceeds 32/);
  });

  it('rejects non-object root', () => {
    expect(() => sanitizeMeasurementCapabilities(null)).toThrow();
    expect(() => sanitizeMeasurementCapabilities('string')).toThrow();
    expect(() => sanitizeMeasurementCapabilities([])).toThrow();
  });

  it('rejects metrics with missing metric_id', () => {
    expect(() => sanitizeMeasurementCapabilities({
      metrics: [{ description: 'no id' }],
    })).toThrow();
  });
});
