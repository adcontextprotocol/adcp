-- Migration: 265_policy_registry.sql
-- Purpose: Shared policy registry for governance domains.
-- Policies are standardized, machine-readable advertising regulations and standards
-- that governance agents resolve and evaluate at runtime.

-- =============================================================================
-- 1. Policies table
-- =============================================================================

CREATE TABLE policies (
  policy_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('regulation', 'standard')),
  enforcement TEXT NOT NULL CHECK (enforcement IN ('must', 'should', 'may')),
  jurisdictions JSONB DEFAULT '[]'::jsonb,
  region_aliases JSONB DEFAULT '{}'::jsonb,
  verticals JSONB DEFAULT '[]'::jsonb,
  channels JSONB,
  effective_date TEXT,
  sunset_date TEXT,
  governance_domains JSONB DEFAULT '[]'::jsonb,
  source_url TEXT,
  source_name TEXT,
  policy TEXT NOT NULL,
  guidance TEXT,
  exemplars JSONB,
  ext JSONB,
  source_type TEXT NOT NULL DEFAULT 'community' CHECK (source_type IN ('registry', 'community')),
  review_status TEXT NOT NULL DEFAULT 'approved' CHECK (review_status IN ('pending', 'approved')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_policies_category ON policies(category);
CREATE INDEX idx_policies_enforcement ON policies(enforcement);
CREATE INDEX idx_policies_source_type ON policies(source_type);
CREATE INDEX idx_policies_review_status ON policies(review_status);
CREATE INDEX idx_policies_name_search ON policies USING gin(to_tsvector('english', name || ' ' || COALESCE(description, '')));
CREATE INDEX idx_policies_governance_domains ON policies USING gin(governance_domains);

-- =============================================================================
-- 2. Policy revisions (append-only changelog)
-- =============================================================================

CREATE TABLE policy_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id TEXT NOT NULL REFERENCES policies(policy_id),
  revision_number INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  editor_user_id VARCHAR(255) NOT NULL,
  editor_email VARCHAR(255),
  editor_name VARCHAR(255),
  edit_summary TEXT NOT NULL,
  is_rollback BOOLEAN DEFAULT FALSE,
  rolled_back_to INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(policy_id, revision_number)
);

CREATE INDEX idx_policy_revisions_policy ON policy_revisions(policy_id);
CREATE INDEX idx_policy_revisions_editor ON policy_revisions(editor_user_id);
CREATE INDEX idx_policy_revisions_created ON policy_revisions(created_at);

-- =============================================================================
-- 3. Seed policies
-- =============================================================================

-- ── Regulations (enforcement: must) ─────────────────────────────

INSERT INTO policies (policy_id, version, name, description, category, enforcement, jurisdictions, region_aliases, verticals, channels, effective_date, governance_domains, source_url, source_name, policy, exemplars, source_type, review_status)
VALUES

-- UK HFSS
('uk_hfss', '1.0.0', 'UK HFSS Advertising Restrictions',
 'UK ban on paid online advertising of less healthy food and drink products.',
 'regulation', 'must',
 '["GB"]'::jsonb, '{}'::jsonb,
 '["food", "beverage"]'::jsonb, NULL,
 '2025-10-01',
 '["campaign", "property", "content_standards"]'::jsonb,
 'https://www.legislation.gov.uk/ukpga/2022/17/contents',
 'UK Parliament',
 'The UK Health and Social Care Act 2022 restricts paid online advertising of food and drink products classified as "less healthy" under the Nutrient Profiling Model (NPM). Products scoring 4 or above (food) or 1 or above (drinks) on the NPM are restricted.

Scope: Applies to businesses with 250 or more employees. Small and medium enterprises are exempt. Covers paid-for online advertising including display, video, social media, and search advertising. Does not apply to owned media (brand websites, packaging) or audio-only advertising.

TV restrictions: Less healthy food and drink advertising is prohibited on TV and on-demand programme services before 9:00 PM (watershed). After 9:00 PM, restrictions apply to programming likely to appeal to children.

Exemptions: Brand-only advertising that does not identify a specific less healthy product is permitted. Advertising for out-of-home dining establishments is exempt where the ad promotes the business rather than specific less healthy items.',
 '{"pass": [{"scenario": "A breakfast cereal brand (250+ employees) runs a display ad featuring their low-sugar granola (NPM score 2) on UK websites.", "explanation": "The product scores below the NPM threshold (4 for food), so it is not classified as less healthy and can be advertised without restriction."}, {"scenario": "A confectionery brand runs a brand awareness campaign showing only their logo and tagline, with no specific products pictured.", "explanation": "Brand-only advertising that does not identify specific less healthy products is explicitly exempt from HFSS restrictions."}], "fail": [{"scenario": "A large snack company runs paid Instagram ads in the UK featuring their crisps (NPM score 8) at 2:00 PM.", "explanation": "The product is less healthy (NPM >= 4), the company has 250+ employees, and paid online ads for less healthy products are prohibited regardless of time of day."}, {"scenario": "A beverage company with 500 employees runs YouTube pre-roll ads for an energy drink (NPM score 5) targeting UK viewers.", "explanation": "The drink scores above the NPM threshold (1 for drinks) and the company exceeds the employee threshold. Paid online video advertising of this product is restricted."}]}'::jsonb,
 'registry', 'approved'),

-- US COPPA
('us_coppa', '1.0.0', 'US COPPA',
 'Children''s Online Privacy Protection Act requirements for advertising.',
 'regulation', 'must',
 '["US"]'::jsonb, '{}'::jsonb,
 '[]'::jsonb, NULL,
 '2000-04-21',
 '["campaign", "property"]'::jsonb,
 'https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa',
 'US Federal Trade Commission',
 'The Children''s Online Privacy Protection Act (COPPA) regulates the collection, use, and disclosure of personal information from children under 13 years of age. For advertising purposes, COPPA imposes strict requirements on ad targeting and data collection.

No collection of personal information from children under 13 without verifiable parental consent. Personal information includes persistent identifiers used for behavioral advertising (cookies, device IDs, advertising IDs).

No behavioral targeting of audiences known to be under 13. Contextual advertising is permitted on child-directed sites, but interest-based or behavioral advertising is not, unless verifiable parental consent has been obtained.

Operators of websites or online services directed to children, or that have actual knowledge they are collecting information from children under 13, must post a clear privacy policy, provide notice to parents, and obtain verifiable parental consent before collection. The FTC applies a totality-of-factors test to determine whether a site is "directed to children."',
 '{"pass": [{"scenario": "A toy brand runs contextual display ads on a children''s gaming site, using no cookies or behavioral targeting. The ad is served based on page content only.", "explanation": "Contextual advertising on child-directed sites is permitted under COPPA. No personal information is collected for targeting purposes."}, {"scenario": "An advertiser excludes all audiences flagged as under-13 from their programmatic campaigns and uses no data from child-directed properties.", "explanation": "By excluding under-13 audiences and avoiding child-directed property data, the advertiser avoids COPPA obligations for this campaign."}], "fail": [{"scenario": "An advertiser uses a third-party data segment labeled ''Kids 6-12'' to target display ads across the open web.", "explanation": "Using behavioral data segments of children under 13 for ad targeting violates COPPA. The data was collected from children without verifiable parental consent."}, {"scenario": "A children''s app collects device advertising IDs to build behavioral profiles for ad targeting without parental consent.", "explanation": "Device advertising IDs are persistent identifiers under COPPA. Collecting them from children under 13 for behavioral advertising requires verifiable parental consent."}]}'::jsonb,
 'registry', 'approved'),

-- EU GDPR Advertising
('eu_gdpr_advertising', '1.0.0', 'EU GDPR Advertising Requirements',
 'GDPR requirements for personal data processing in advertising.',
 'regulation', 'must',
 '[]'::jsonb,
 '{"EU": ["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE"]}'::jsonb,
 '[]'::jsonb, NULL,
 '2018-05-25',
 '["campaign", "property"]'::jsonb,
 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
 'European Parliament and Council',
 'The General Data Protection Regulation (GDPR) requires a valid legal basis for processing personal data for advertising purposes. For most advertising use cases, freely given, specific, informed, and unambiguous consent is the appropriate legal basis.

Consent must be obtained before processing personal data for ad targeting. Pre-ticked boxes, bundled consent, or consent walls do not constitute valid consent. Users must be able to withdraw consent as easily as they gave it.

Purpose limitation: Personal data collected for one purpose cannot be repurposed for advertising without additional consent. Data minimization: Only data strictly necessary for the stated advertising purpose may be processed.

Age of digital consent varies by member state (13-16 years). For users below the applicable age, parental consent is required. Data Protection Impact Assessments may be required for large-scale profiling for advertising purposes.

Data subjects have the right to object to processing for direct marketing purposes at any time, and this right must be explicitly brought to their attention.',
 '{"pass": [{"scenario": "A publisher in Germany collects explicit opt-in consent via a CMP before enabling interest-based advertising. Users can withdraw consent from the same interface.", "explanation": "Valid GDPR consent is collected before processing. Consent is freely given, specific, and revocable through the same mechanism."}, {"scenario": "An advertiser uses only contextual signals (page content, URL) to serve ads in EU markets, with no personal data processing.", "explanation": "Contextual advertising that processes no personal data does not require consent under GDPR. No personal data is collected or processed."}], "fail": [{"scenario": "An advertiser runs retargeting campaigns in France using cookie data collected before the user interacted with any consent mechanism.", "explanation": "Processing personal data (cookies) before obtaining consent violates GDPR. Consent must be collected before data processing begins."}, {"scenario": "A publisher bundles advertising consent with terms of service acceptance, requiring users to accept both or leave the site.", "explanation": "Bundled consent is not freely given under GDPR. Advertising consent must be separable from service access."}]}'::jsonb,
 'registry', 'approved'),

-- EU AI Act Article 50
('eu_ai_act_article_50', '1.0.0', 'EU AI Act Transparency Obligations',
 'EU AI Act requirements for AI-generated advertising content disclosure.',
 'regulation', 'must',
 '[]'::jsonb,
 '{"EU": ["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE"]}'::jsonb,
 '[]'::jsonb, NULL,
 '2026-08-02',
 '["creative", "content_standards"]'::jsonb,
 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
 'European Parliament and Council',
 'Article 50 of the EU AI Act establishes transparency obligations for AI-generated content. When AI systems generate synthetic audio, image, video, or text content that could reasonably be mistaken for authentic, it must be disclosed.

Providers of AI systems that generate synthetic content must ensure outputs are marked in a machine-readable format. The C2PA (Coalition for Content Provenance and Authenticity) standard is recognized as an appropriate technical solution for provenance marking.

Deployers of AI systems (including advertisers using AI to generate creative content) must disclose that content has been artificially generated or manipulated. This applies to advertising content including AI-generated images, video, voiceovers, and copy.

Exceptions: Content that undergoes human editorial review and where a natural person holds editorial responsibility may have reduced disclosure obligations. Purely assistive AI use (spell-checking, grammar) does not trigger disclosure requirements.',
 '{"pass": [{"scenario": "A brand creates an AI-generated video ad and embeds C2PA provenance metadata in the file. The ad includes a visible ''AI-generated content'' label in the EU market.", "explanation": "Both machine-readable (C2PA) and human-readable (visible label) disclosure requirements are met."}, {"scenario": "A creative agency uses AI to generate initial ad concepts, but a human designer substantially reworks the final creative. The agency documents the human editorial process.", "explanation": "Content where a human holds editorial responsibility and substantially modifies the output has reduced disclosure obligations under Article 50."}], "fail": [{"scenario": "A brand uses AI to generate photorealistic product lifestyle images for display ads in EU markets, with no disclosure or provenance marking.", "explanation": "AI-generated images that could be mistaken for authentic photographs must be disclosed and marked with machine-readable provenance metadata."}, {"scenario": "An advertiser runs AI-generated voiceover ads across EU markets without disclosing the synthetic nature of the audio.", "explanation": "Synthetic audio in advertising must be disclosed under Article 50. The voiceover could reasonably be mistaken for a human speaker."}]}'::jsonb,
 'registry', 'approved'),

-- California SB 942
('ca_sb_942', '1.0.0', 'California AI Transparency Act',
 'California requirements for labeling AI-generated content on large platforms.',
 'regulation', 'must',
 '["US"]'::jsonb, '{}'::jsonb,
 '[]'::jsonb, NULL,
 '2026-01-01',
 '["creative", "content_standards"]'::jsonb,
 'https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202320240SB942',
 'California State Legislature',
 'The California AI Transparency Act (SB 942) requires large online platforms (those with more than 1 million monthly users in California) to detect and label AI-generated content, including content used in advertising.

Platforms must provide tools for users to disclose AI-generated content and must develop detection capabilities for undisclosed AI content. Covered content types include images, video, and audio that are generated or substantially modified by AI.

For advertising: AI-generated image, video, and audio content in ads served on covered platforms must be labeled. The platform is responsible for providing the labeling infrastructure, but advertisers are responsible for accurate disclosure.

Provenance data: Platforms must make reasonable efforts to preserve provenance metadata (such as C2PA) attached to content uploaded to the platform. Stripping or obscuring provenance data is prohibited.',
 '{"pass": [{"scenario": "An advertiser uploads an AI-generated video ad to a large social media platform, marking it as AI-generated using the platform''s disclosure tool. The platform displays an ''AI-generated'' label.", "explanation": "The advertiser has disclosed and the platform has labeled the AI-generated content, satisfying SB 942 requirements."}, {"scenario": "A brand uploads product photos (taken by a human photographer) as ad creative on a covered platform. No AI disclosure is needed.", "explanation": "Content not generated or substantially modified by AI does not require labeling under SB 942."}], "fail": [{"scenario": "An advertiser uses AI to generate photorealistic model images for ads on a covered platform without disclosing the AI origin.", "explanation": "AI-generated images in advertising on platforms with 1M+ California monthly users must be disclosed. The advertiser failed to use the platform''s disclosure tools."}, {"scenario": "A platform strips C2PA metadata from an uploaded AI-generated ad creative, preventing downstream detection.", "explanation": "SB 942 prohibits platforms from stripping provenance metadata. The platform must make reasonable efforts to preserve C2PA data."}]}'::jsonb,
 'registry', 'approved'),

-- US Cannabis
('us_cannabis', '1.0.0', 'US Cannabis Advertising Restrictions',
 'Cannabis advertising compliance requirements across US jurisdictions.',
 'regulation', 'must',
 '["US"]'::jsonb, '{}'::jsonb,
 '["cannabis", "marijuana"]'::jsonb, NULL,
 '2024-01-01',
 '["campaign", "property", "creative", "content_standards"]'::jsonb,
 'https://www.ncsl.org/health/state-medical-cannabis-laws',
 'National Conference of State Legislatures',
 'Cannabis advertising in the United States is subject to a patchwork of state-level regulations. There is no federal advertising framework because cannabis remains a Schedule I substance federally. Advertisers must comply with the specific regulations of each state where ads will be served.

Audience composition: Most states with legal cannabis require that advertising audiences be composed of at least 71.6% adults (21+). This threshold comes from guidance that the audience should reasonably be expected to be of legal age. Some states set higher thresholds. Audience verification must use reliable data sources.

Content restrictions: No advertising that appeals to minors. This includes cartoon characters, imagery associated with youth culture, depictions of consumption by anyone under 21, or placement adjacent to youth-oriented content. No health or medical claims unless specifically permitted by state regulation.

Geographic restrictions: Ads may only be served in states where the advertised product is legal. State-by-state legality must be verified before campaign launch. Some states restrict advertising near schools, playgrounds, and youth facilities (typically 500-1000 foot buffer zones for physical media).

Platform restrictions: Many digital platforms prohibit cannabis advertising entirely. Where permitted, platform-specific guidelines must also be followed.',
 '{"pass": [{"scenario": "A licensed dispensary runs geo-targeted display ads in Colorado, verified to serve only to users 21+, with no cartoon imagery or youth-appeal elements.", "explanation": "The ad is geo-targeted to a legal state, age-gated appropriately, and avoids youth-appeal content restrictions."}, {"scenario": "A cannabis brand excludes all states where recreational cannabis is not legal from their programmatic campaign targeting.", "explanation": "By restricting delivery to legal jurisdictions only, the advertiser complies with geographic restrictions."}], "fail": [{"scenario": "A cannabis delivery service runs Instagram-style ads featuring animated characters and bright colors clearly appealing to a young audience.", "explanation": "Content that appeals to minors through cartoon characters and youth-oriented design violates cannabis advertising restrictions in all legal states."}, {"scenario": "A cannabis brand runs untargeted display ads across the US without geographic or age restrictions.", "explanation": "Cannabis ads must be restricted to legal jurisdictions and age-gated. Untargeted national delivery will serve ads in states where cannabis is illegal and to underage users."}]}'::jsonb,
 'registry', 'approved'),

-- ── Standards (enforcement: should) ─────────────────────────────

-- Alcohol Advertising
('alcohol_advertising', '1.0.0', 'Alcohol Advertising Standards',
 'Industry best practices for responsible alcohol advertising.',
 'standard', 'should',
 '[]'::jsonb, '{}'::jsonb,
 '["alcohol", "beverage", "spirits", "beer", "wine"]'::jsonb, NULL,
 '2024-01-01',
 '["campaign", "property", "creative", "content_standards"]'::jsonb,
 'https://www.iard.org/resources/digital-guiding-principles/',
 'International Alliance for Responsible Drinking',
 'Alcohol advertising should follow responsible marketing practices to prevent underage exposure and promote responsible consumption. These standards represent industry consensus across major markets.

Age gating: All alcohol advertising should be age-gated to the legal drinking age of the target market (21+ in the US, 18+ in most other markets). Digital platforms should use age-verification mechanisms before serving alcohol ads. Audience composition should meet or exceed 71.6% legal drinking age adults.

Content standards: Advertising should not depict excessive or irresponsible consumption. No association between alcohol and driving, operating machinery, or risky physical activities. No implication that alcohol improves social, sexual, or professional success. No targeting of pregnant women.

Youth appeal: Advertising should not use imagery, language, or cultural references primarily appealing to people below the legal drinking age. This includes certain music, fashion, slang, or social media trends predominantly associated with underage audiences. No use of persons or models who appear to be under 25 years of age.

Responsible messaging: Include responsible drinking messaging where feasible (e.g., "Drink Responsibly", "Must be 21+"). Avoid promoting high alcohol content as a selling point.',
 '{"pass": [{"scenario": "A spirits brand runs programmatic video ads with 21+ age gating in the US, featuring adults in a relaxed social setting with a ''Please drink responsibly'' message.", "explanation": "The ad is properly age-gated, features adults, includes a responsible consumption message, and does not associate alcohol with risky behavior."}, {"scenario": "A beer brand runs display ads in the UK targeting users 18+ with verified age data, showing adults enjoying a meal with beer at a restaurant.", "explanation": "Age gating matches the UK legal drinking age. The setting depicts moderate consumption with food, following responsible advertising standards."}], "fail": [{"scenario": "A vodka brand runs social media ads featuring college party scenes with young-looking models and no age gate.", "explanation": "No age verification, models who may appear under 25, and party scenes that could appeal to underage audiences all violate alcohol advertising standards."}, {"scenario": "A beer brand runs a campaign associating their product with extreme sports and high-speed driving.", "explanation": "Associating alcohol with risky activities (extreme sports, driving) violates responsible alcohol advertising standards."}]}'::jsonb,
 'registry', 'approved'),

-- Pharma US FDA
('pharma_us_fda', '1.0.0', 'US Pharmaceutical Advertising Standards',
 'FDA-aligned best practices for pharmaceutical and healthcare advertising.',
 'standard', 'should',
 '["US"]'::jsonb, '{}'::jsonb,
 '["pharmaceutical", "healthcare", "biotech"]'::jsonb, NULL,
 '2024-01-01',
 '["campaign", "creative", "content_standards"]'::jsonb,
 'https://www.fda.gov/drugs/drug-information-consumers/prescription-drug-advertising',
 'US Food and Drug Administration',
 'Pharmaceutical advertising should present a fair balance of benefit and risk information. These standards align with FDA guidance for prescription drug advertising and extend to digital formats.

Fair balance: Benefits and risks must be presented together with comparable prominence. Major side effects and contraindications must be disclosed in the ad or in immediately accessible linked content. "Major statement" requirements apply to broadcast-style ads (video, audio).

Indication limitations: Ads should clearly state what the drug is approved to treat. No implied efficacy for unapproved indications (off-label promotion). Comparative claims must be supported by substantial evidence.

Digital considerations: For space-constrained formats (banner ads, social posts), a clear and prominent link to full prescribing information must be provided. Scrollable or expandable ad units should present risk information with the same prominence as benefit claims.

Not a substitute for medical advice: All pharmaceutical advertising should include language directing consumers to consult their healthcare provider. Direct-to-consumer ads should not replace the patient-physician relationship.',
 '{"pass": [{"scenario": "A pharmaceutical brand runs a video ad for a cholesterol medication that presents both efficacy data and common side effects with equal screen time and visual prominence.", "explanation": "Fair balance is achieved by presenting benefits and risks with comparable prominence in the same ad unit."}, {"scenario": "A display ad for an arthritis drug includes the approved indication and links to full prescribing information. The landing page includes complete risk information.", "explanation": "The ad states the approved indication and provides accessible risk information through a clear link to prescribing details."}], "fail": [{"scenario": "A pharmaceutical company runs social media ads highlighting a drug''s benefits in large text with side effects listed in barely readable fine print.", "explanation": "Risk information presented with significantly less prominence than benefit claims violates fair balance requirements."}, {"scenario": "An ad implies a drug is effective for conditions beyond its FDA-approved indication without supporting evidence.", "explanation": "Suggesting efficacy for unapproved indications constitutes off-label promotion, violating pharmaceutical advertising standards."}]}'::jsonb,
 'registry', 'approved'),

-- Gambling Advertising
('gambling_advertising', '1.0.0', 'Gambling Advertising Standards',
 'Industry best practices for responsible gambling advertising.',
 'standard', 'should',
 '[]'::jsonb, '{}'::jsonb,
 '["gambling", "gaming", "betting", "casino", "lottery"]'::jsonb, NULL,
 '2024-01-01',
 '["campaign", "property", "content_standards"]'::jsonb,
 'https://iclg.com/practice-areas/gambling-laws-and-regulations',
 'International Comparative Legal Guides',
 'Gambling advertising should promote responsible gambling and protect vulnerable populations. These standards synthesize best practices from major regulated markets.

Self-exclusion integration: Advertising systems should integrate with self-exclusion registries where available. Users who have self-excluded from gambling should not be targeted with gambling advertising. Where technical integration is not possible, best efforts should be made to suppress delivery.

Responsible messaging: All gambling advertising should include responsible gambling messaging and links to problem gambling resources (e.g., national helplines). Messaging should be prominent, not buried in fine print.

Vulnerable populations: No targeting of people identified as problem gamblers or those who have shown signs of gambling harm (e.g., frequent deposit limit changes, self-exclusion attempts). No targeting of financially vulnerable populations. Age gating to 21+ (US) or 18+ (most markets) is required.

Content restrictions: No portrayal of gambling as a guaranteed way to make money. No implication that gambling can solve financial problems. No association of gambling with social or professional success. Odds and terms must be clearly stated.',
 '{"pass": [{"scenario": "A sports betting platform runs pre-game display ads with 21+ age gating, prominent responsible gambling messaging, and a link to the National Council on Problem Gambling.", "explanation": "The ad is age-gated, includes responsible gambling messaging, and links to support resources, following best practices."}, {"scenario": "A casino app excludes users on the state self-exclusion registry from all advertising campaigns.", "explanation": "Integrating with self-exclusion registries and suppressing ads to self-excluded users is a core responsible gambling advertising practice."}], "fail": [{"scenario": "A betting app runs ads with the tagline ''Turn $10 into $10,000!'' with no risk disclaimers or responsible gambling messaging.", "explanation": "Implying guaranteed returns and omitting responsible gambling messaging violates gambling advertising standards."}, {"scenario": "A gambling platform retargets users who recently set deposit limits with promotional bonus offers.", "explanation": "Targeting users showing signs of gambling harm (deposit limit changes) with promotional offers violates vulnerable population protections."}]}'::jsonb,
 'registry', 'approved'),

-- Financial Services
('financial_services', '1.0.0', 'Financial Services Advertising Standards',
 'Best practices for financial product and services advertising.',
 'standard', 'should',
 '[]'::jsonb, '{}'::jsonb,
 '["financial_services", "insurance", "banking", "fintech", "investment"]'::jsonb, NULL,
 '2024-01-01',
 '["campaign", "content_standards"]'::jsonb,
 'https://www.consumerfinance.gov/rules-policy/',
 'Consumer Financial Protection Bureau',
 'Financial services advertising should be transparent about costs, risks, and terms. These standards apply to advertising for banking products, insurance, investment services, lending, and fintech products.

Rate and fee disclosure: When advertising interest rates, the Annual Percentage Rate (APR) must be stated with equal or greater prominence than any introductory or promotional rate. All material fees must be disclosed. "From" rates must indicate that the advertised rate is not available to all applicants.

Risk warnings: Investment product advertising must include appropriate risk warnings. Past performance disclosures must state that past results do not guarantee future performance. High-risk products (cryptocurrencies, leveraged instruments, derivatives) require prominent risk warnings.

No misleading claims: No guarantees of returns, income, or financial outcomes unless legally backed (e.g., FDIC insurance). No misleading comparisons to savings accounts or fixed-income products. Claims of "no fees" must be accurate and complete.

Terms accessibility: Full terms and conditions must be accessible from the ad (linked or expandable). Material terms affecting the consumer must be in the ad itself, not only in linked content. Calculation examples must use representative scenarios.',
 '{"pass": [{"scenario": "A bank runs display ads for a savings account showing the APR prominently, stating ''Rates may vary'' and linking to full terms and conditions.", "explanation": "The APR is prominently displayed, variable rate nature is disclosed, and full terms are accessible via link."}, {"scenario": "An investment platform runs video ads that include ''Past performance does not guarantee future results'' and ''Capital at risk'' disclaimers with the same visual prominence as return figures.", "explanation": "Appropriate risk disclaimers are presented with comparable prominence to performance claims, following fair disclosure standards."}], "fail": [{"scenario": "A lending app advertises ''0% interest!'' in large text without disclosing that this is an introductory rate that increases to 24.9% APR after 6 months.", "explanation": "Advertising an introductory rate without disclosing the standard APR with equal prominence is misleading and violates disclosure requirements."}, {"scenario": "A crypto exchange runs ads stating ''Guaranteed 20% annual returns'' on their staking product.", "explanation": "Guaranteeing investment returns is misleading. Crypto products carry significant risk that must be disclosed, and returns cannot be guaranteed."}]}'::jsonb,
 'registry', 'approved'),

-- Tobacco/Nicotine
('tobacco_nicotine', '1.0.0', 'Tobacco and Nicotine Advertising Standards',
 'Best practices for tobacco, nicotine, and vaping product advertising.',
 'standard', 'should',
 '[]'::jsonb, '{}'::jsonb,
 '["tobacco", "nicotine", "vaping", "e-cigarettes"]'::jsonb, NULL,
 '2024-01-01',
 '["campaign", "property", "creative", "content_standards"]'::jsonb,
 'https://www.who.int/publications/i/item/9789240077164',
 'World Health Organization',
 'Tobacco and nicotine product advertising, where permitted, should follow strict responsible marketing practices. Many jurisdictions ban tobacco advertising entirely; these standards apply where digital advertising is legally permitted.

Age verification: Age verification must occur before ad delivery, not just at point of sale. Minimum age is 21+ in the US (federal Tobacco 21 law) and 18+ in most other markets. Reliable age-verification mechanisms are required, not just self-declared age.

Youth appeal: No imagery, language, music, or cultural references that primarily appeal to minors. No cartoon characters, mascots, or animated elements. No celebrity endorsements by persons likely to appeal to youth. No placement adjacent to youth-oriented content.

Health warnings: Health warning placement and content must comply with jurisdiction-specific requirements. Where no specific requirement exists, a prominent health warning should be included. Warnings should not be obscured, minimized, or placed where they are unlikely to be noticed.

Flavor restrictions: In jurisdictions where flavored products are restricted, advertising should not emphasize flavoring as a primary selling point. No imagery suggesting candy, fruit, or dessert flavors when such products are restricted.',
 '{"pass": [{"scenario": "A vaping company runs age-verified display ads in a US state where vaping ads are permitted, with a prominent Surgeon General warning and no youth-appeal imagery.", "explanation": "Ads are age-verified (21+), include required health warnings, and avoid youth-appeal content, meeting responsible advertising standards."}, {"scenario": "A tobacco company excludes all content categories associated with minors and uses verified 21+ audience segments for their US digital campaigns.", "explanation": "Strict age gating and exclusion of minor-associated content follows responsible tobacco advertising standards."}], "fail": [{"scenario": "A vaping brand runs social media ads featuring colorful candy-themed imagery and popular youth slang with no age gate.", "explanation": "Candy-themed imagery, youth slang, and no age verification all violate tobacco/nicotine advertising standards. The ad appeals to minors."}, {"scenario": "An e-cigarette company runs programmatic display ads with no health warnings and no age-verification requirements.", "explanation": "Missing health warnings and no age verification violate basic tobacco/nicotine advertising standards across all markets."}]}'::jsonb,
 'registry', 'approved')

ON CONFLICT (policy_id) DO NOTHING;
