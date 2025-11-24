---
---

Add database-backed registry for partner onboarding framework.

Introduces UnifiedRegistry that transparently supports both file-based and PostgreSQL-backed agent/partner data storage. The system uses fail-fast initialization - if database configuration is provided but connection fails, the system will not fall back to file mode.

**New features:**
- Database schema with migrations for agents, partners, and authorization entries
- UnifiedRegistry abstraction providing consistent interface across storage backends
- CLI tools for database migration and management
- SSL/TLS configuration via DATABASE_SSL environment variables
- property_ids support for scoping agent authorization to specific properties

**Implementation notes:**
- Database mode is opt-in via DATABASE_URL environment variable
- Schema supports 'agent' and 'partner' entry types
- Migrations tracked in schema_migrations table
- All existing file-based registry tests continue to pass

This is an infrastructure change that does not affect the AdCP protocol specification or public APIs.
