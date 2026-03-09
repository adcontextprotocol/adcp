-- Migration: 263_policy_governance_domains.sql
-- Purpose: Add governance_domains column to policies table.
-- This field declares which governance sub-domains (campaign, property, creative, content_standards)
-- a registry policy applies to. Agents use this to discover which policies they can evaluate
-- and declare as registry:{policy_id} features.

ALTER TABLE policies ADD COLUMN governance_domains JSONB DEFAULT '[]'::jsonb;

CREATE INDEX idx_policies_governance_domains ON policies USING gin(governance_domains);

-- Update seed policies with their applicable governance domains

-- Regulations
UPDATE policies SET governance_domains = '["campaign", "property", "content_standards"]'::jsonb WHERE policy_id = 'uk_hfss';
UPDATE policies SET governance_domains = '["campaign", "property"]'::jsonb WHERE policy_id = 'us_coppa';
UPDATE policies SET governance_domains = '["campaign", "property"]'::jsonb WHERE policy_id = 'eu_gdpr_advertising';
UPDATE policies SET governance_domains = '["creative", "content_standards"]'::jsonb WHERE policy_id = 'eu_ai_act_article_50';
UPDATE policies SET governance_domains = '["creative", "content_standards"]'::jsonb WHERE policy_id = 'ca_sb_942';
UPDATE policies SET governance_domains = '["campaign", "property", "creative", "content_standards"]'::jsonb WHERE policy_id = 'us_cannabis';

-- Standards
UPDATE policies SET governance_domains = '["campaign", "property", "creative", "content_standards"]'::jsonb WHERE policy_id = 'alcohol_advertising';
UPDATE policies SET governance_domains = '["campaign", "creative", "content_standards"]'::jsonb WHERE policy_id = 'pharma_us_fda';
UPDATE policies SET governance_domains = '["campaign", "property", "content_standards"]'::jsonb WHERE policy_id = 'gambling_advertising';
UPDATE policies SET governance_domains = '["campaign", "content_standards"]'::jsonb WHERE policy_id = 'financial_services';
UPDATE policies SET governance_domains = '["campaign", "property", "creative", "content_standards"]'::jsonb WHERE policy_id = 'tobacco_nicotine';
