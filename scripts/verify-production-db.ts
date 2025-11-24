#!/usr/bin/env tsx
/**
 * Verify production database has correct registry data
 * Usage: DATABASE_URL=<prod-url> npx tsx scripts/verify-production-db.ts
 */

import pg from "pg";
const { Pool } = pg;

interface RegistryEntry {
  id: string;
  entry_type: string;
  name: string;
  slug: string;
  tags: string[];
  approval_status: string;
  active: boolean;
  created_at: Date;
}

async function verifyProductionDatabase() {
  const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;

  if (!dbUrl) {
    console.error("❌ DATABASE_URL or DATABASE_PRIVATE_URL environment variable required");
    process.exit(1);
  }

  console.log("🔍 Verifying production database...\n");

  const pool = new Pool({
    connectionString: dbUrl,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
  });

  try {
    // Check if registry_entries table exists
    console.log("1. Checking if registry_entries table exists...");
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'registry_entries'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.log("❌ registry_entries table does NOT exist");
      console.log("\n💡 Run migrations first: npm run db:migrate");
      await pool.end();
      process.exit(1);
    }
    console.log("✅ registry_entries table exists\n");

    // Check migrations table
    console.log("2. Checking applied migrations...");
    const migrations = await pool.query(`
      SELECT name, applied_at
      FROM migrations
      ORDER BY applied_at DESC
      LIMIT 5;
    `);
    console.log(`✅ ${migrations.rowCount} migrations applied`);
    migrations.rows.forEach(m => {
      console.log(`   - ${m.name} (${new Date(m.applied_at).toLocaleDateString()})`);
    });
    console.log();

    // Count agents by type
    console.log("3. Counting registry entries...");
    const counts = await pool.query(`
      SELECT entry_type, COUNT(*) as count
      FROM registry_entries
      WHERE entry_type = 'agent' AND active = true
      GROUP BY entry_type;
    `);

    if (counts.rowCount === 0) {
      console.log("❌ NO AGENTS FOUND in database");
      console.log("\n💡 Seed the database: npm run db:seed");
      await pool.end();
      process.exit(1);
    }

    counts.rows.forEach(row => {
      console.log(`✅ ${row.count} ${row.entry_type}(s)`);
    });
    console.log();

    // List agents by type
    console.log("4. Listing agents by type...");
    const agents = await pool.query<RegistryEntry>(`
      SELECT name, slug, tags, approval_status, active
      FROM registry_entries
      WHERE entry_type = 'agent' AND active = true
      ORDER BY tags[1], name;
    `);

    const byType: { [key: string]: RegistryEntry[] } = {};
    agents.rows.forEach(agent => {
      const type = agent.tags[0] || "unknown";
      if (!byType[type]) byType[type] = [];
      byType[type].push(agent);
    });

    for (const [type, typeAgents] of Object.entries(byType)) {
      console.log(`\n📦 ${type.toUpperCase()} AGENTS (${typeAgents.length}):`);
      typeAgents.forEach(agent => {
        const status = agent.approval_status === "approved" ? "✅" : "⚠️";
        console.log(`   ${status} ${agent.name}`);
        console.log(`      slug: ${agent.slug}`);
        console.log(`      status: ${agent.approval_status}`);
      });
    }

    // Check for specific expected agents
    console.log("\n5. Checking for expected agents...");
    const expectedAgents = [
      { slug: "creative/adcp-creative-agent", type: "creative" },
      { slug: "signals/scope3-signals-agent", type: "signals" },
    ];

    for (const expected of expectedAgents) {
      const result = await pool.query(
        "SELECT name, url FROM registry_entries WHERE slug = $1 AND active = true",
        [expected.slug]
      );

      if (result.rowCount === 0) {
        console.log(`⚠️  Missing: ${expected.slug}`);
      } else {
        console.log(`✅ Found: ${result.rows[0].name}`);
        console.log(`   URL: ${result.rows[0].url}`);
      }
    }

    console.log("\n✅ Database verification complete!");
    console.log("\n📊 Summary:");
    console.log(`   Total agents: ${agents.rowCount}`);
    console.log(`   By type: ${Object.entries(byType).map(([t, a]) => `${t}=${a.length}`).join(", ")}`);

    await pool.end();
    process.exit(0);

  } catch (error: any) {
    console.error("\n❌ Verification failed:", error.message);
    await pool.end();
    process.exit(1);
  }
}

verifyProductionDatabase();
