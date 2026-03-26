#!/usr/bin/env bash
# Monitor outreach quality metrics from production.
# Usage: ./server/scripts/monitor-outreach-quality.sh
set -euo pipefail

APP="adcp-docs"

fly ssh console -a "$APP" -C "node -e \"
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  // 1. Response rate (7 days)
  const rr = (await pool.query(\\\`
    WITH sent AS (
      SELECT DISTINCT person_id FROM person_events
      WHERE event_type = 'message_sent' AND created_at > now() - interval '7 days'
    ),
    replied AS (
      SELECT DISTINCT pe.person_id FROM person_events pe
      WHERE pe.event_type = 'message_received' AND pe.channel = 'slack'
      AND pe.created_at > now() - interval '7 days'
      AND pe.person_id IN (SELECT person_id FROM person_events WHERE event_type = 'message_sent')
    )
    SELECT
      (SELECT count(*) FROM sent) as messaged,
      (SELECT count(*) FROM replied) as replied
  \\\`)).rows[0];
  const rate = rr.messaged > 0 ? Math.round(rr.replied / rr.messaged * 100) : 0;
  const rateIcon = rate > 5 ? '✅' : rate >= 2 ? '⚠️' : '❌';
  console.log('=== RESPONSE RATE (7d) ===');
  console.log(rateIcon + ' ' + rate + '% (' + rr.replied + '/' + rr.messaged + ' people)');

  // 2. Skip rate (24h)
  const sr = (await pool.query(\\\`
    SELECT event_type, count(*) as c FROM person_events
    WHERE event_type IN ('message_sent', 'outreach_skipped')
    AND created_at > now() - interval '24 hours'
    GROUP BY event_type
  \\\`)).rows;
  const sent24 = Number(sr.find(r => r.event_type === 'message_sent')?.c ?? 0);
  const skipped24 = Number(sr.find(r => r.event_type === 'outreach_skipped')?.c ?? 0);
  const total24 = sent24 + skipped24;
  const skipPct = total24 > 0 ? Math.round(skipped24 / total24 * 100) : 0;
  const skipIcon = skipPct > 80 ? '✅' : skipPct >= 50 ? '⚠️' : '❌';
  console.log('\\n=== SKIP RATE (24h) ===');
  console.log(skipIcon + ' ' + skipPct + '% skipped (' + skipped24 + ' skipped, ' + sent24 + ' sent)');

  // Skip reasons
  const reasons = (await pool.query(\\\`
    SELECT data->>'reason' as reason, count(*) as c FROM person_events
    WHERE event_type = 'outreach_skipped' AND created_at > now() - interval '24 hours'
    GROUP BY data->>'reason' ORDER BY c DESC LIMIT 8
  \\\`)).rows;
  if (reasons.length > 0) {
    console.log('Top skip reasons:');
    reasons.forEach(r => console.log('  ' + r.c + 'x ' + r.reason));
  }

  // 3. Message quality sample (last 5)
  const msgs = (await pool.query(\\\`
    SELECT pr.display_name, pr.stage, pe.data->>'text' as text,
           length(pe.data->>'text') as len
    FROM person_events pe
    JOIN person_relationships pr ON pr.id = pe.person_id
    WHERE pe.event_type = 'message_sent'
    ORDER BY pe.created_at DESC LIMIT 5
  \\\`)).rows;
  console.log('\\n=== MESSAGE QUALITY SAMPLE (last 5) ===');
  const hedgeWords = ['might be worth', 'if you get a chance', 'worth a few minutes', 'when you get a chance', 'worth a look'];
  let qualityIssues = 0;
  msgs.forEach(m => {
    const text = m.text || '';
    const len = Number(m.len || 0);
    const lenIcon = len <= 280 ? '✅' : len <= 400 ? '⚠️' : '❌';
    const flags = [];
    hedgeWords.forEach(h => { if (text.toLowerCase().includes(h)) flags.push('hedge:' + h); });
    if (flags.length > 0) qualityIssues++;
    if (len > 280) qualityIssues++;
    console.log('---');
    console.log(m.display_name + ' [' + m.stage + '] ' + lenIcon + ' ' + len + ' chars' + (flags.length > 0 ? ' ❌ ' + flags.join(', ') : ''));
    console.log(text.slice(0, 300) + (text.length > 300 ? '...' : ''));
  });
  if (qualityIssues === 0) console.log('✅ No quality issues in sample');

  // 4. Thread continuity (7d)
  const threads = (await pool.query(\\\`
    SELECT pr.display_name, count(DISTINCT pe.data->>'thread_ts') as threads
    FROM person_events pe
    JOIN person_relationships pr ON pr.id = pe.person_id
    WHERE pe.event_type = 'message_sent' AND pe.created_at > now() - interval '7 days'
    AND pe.data->>'thread_ts' IS NOT NULL
    GROUP BY pr.display_name
    HAVING count(DISTINCT pe.data->>'thread_ts') > 1
  \\\`)).rows;
  console.log('\\n=== THREAD CONTINUITY (7d) ===');
  if (threads.length === 0) {
    console.log('✅ All people have single thread');
  } else {
    threads.forEach(t => console.log('❌ ' + t.display_name + ': ' + t.threads + ' different threads'));
  }

  // 5. Unreplied distribution
  const unreplied = (await pool.query(\\\`
    SELECT unreplied_outreach_count as n, count(*) as c FROM person_relationships
    WHERE opted_out = FALSE GROUP BY n ORDER BY n
  \\\`)).rows;
  console.log('\\n=== UNREPLIED DISTRIBUTION ===');
  unreplied.forEach(r => {
    const icon = Number(r.n) >= 4 ? '❌' : Number(r.n) >= 2 ? '⚠️' : '✅';
    console.log(icon + ' unreplied=' + r.n + ': ' + r.c + ' people');
  });

  // 6. Daily volume (7d)
  const daily = (await pool.query(\\\`
    SELECT date_trunc('day', created_at)::date as day, event_type, count(*) as c
    FROM person_events
    WHERE event_type IN ('message_sent', 'message_received', 'outreach_skipped')
    AND created_at > now() - interval '7 days'
    GROUP BY day, event_type ORDER BY day DESC, event_type
  \\\`)).rows;
  console.log('\\n=== DAILY VOLUME (7d) ===');
  daily.forEach(r => console.log(r.day.toISOString().slice(0,10) + ' | ' + r.event_type + ': ' + r.c));

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
\""
