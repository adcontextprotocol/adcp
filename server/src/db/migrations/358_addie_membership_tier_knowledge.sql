-- Give Addie explicit knowledge about membership tiers, pricing, and what each
-- tier includes — especially the relationship between membership and certification.
-- Triggered by escalation #189: a prospect couldn't tell whether Explorer ($50)
-- unlocks the full certification path or just Tier 1 Basics.

INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by) VALUES
(
  'knowledge',
  'Membership Tiers and Certification Access',
  'Complete reference for membership tiers, pricing, seat types, and certification access rules',
  '## Membership tiers

AgenticAdvertising.org has five membership tiers. All are annual.

| Tier | Price | Contributor seats | Community-only seats | Payment |
|------|-------|-------------------|----------------------|---------|
| Explorer | $50/yr | 0 | 1 | Credit card |
| Professional | $250/yr | 1 | 1 | Credit card |
| Builder | $2,500/yr | 5 | 5 | Credit card |
| Partner | $10,000/yr | 10 | 50 | Credit card or invoice |
| Leader | $50,000/yr | 20+ | Unlimited | Credit card or invoice |

### Seat types

**Contributor seats** include full community access: Slack, working groups, industry councils, product summit, plus everything in community-only.

**Community-only seats** include: Addie, all three certification tiers, training, and regional chapters. Use these for team members who need to learn but don''t need active collaboration access. Every contributor seat already includes community access.

### What each tier adds

- **Explorer** ($50/yr): 1 community-only seat. Addie, full certification path (all three tiers), training, newsletter. No Slack or working group access. No directory listing.
- **Professional** ($250/yr): 1 contributor seat + 1 community-only seat. Adds Slack, working groups, council participation, voting rights, directory listing.
- **Builder** ($2,500/yr): 5 contributor + 5 community-only. Adds API access (registry, agent testing, sandbox), board eligibility, marketing opportunities.
- **Partner** ($10,000/yr): 10 contributor + 50 community-only. Featured directory listing. Invoice payment available.
- **Leader** ($50,000/yr): 20+ contributor + unlimited community-only. Convene councils, first access to marketing opportunities.

### Certification access rules

This is critical — do NOT guess on this:

1. **Tier 1 (AdCP Basics)**: Free for everyone. No membership required. Three foundation modules, about 90 minutes.
2. **Tier 2 (AdCP Practitioner)**: Requires any active membership, including Explorer ($50/yr). Basics + one role-specific track + build project.
3. **Tier 3 (AdCP Specialist)**: Requires any active membership, including Explorer ($50/yr). Practitioner + specialist capstone module in one of five areas.

**All membership tiers unlock the same certification access.** There is no certification difference between Explorer and Leader. The difference between tiers is seats, collaboration tools, governance rights, and API access — not certification.

### Common questions

**"Does Explorer unlock Tier 2 and 3 certification?"** — Yes. Every membership tier, including Explorer at $50/year, unlocks all three certification tiers.

**"What does Explorer get me beyond the free Basics?"** — Practitioner and Specialist certification tiers, Addie access, training materials, regional chapter participation, and newsletter.

**"Why would I choose Professional over Explorer?"** — Professional adds Slack and working group access, council participation, voting rights, and a directory listing. Choose Professional if you want to actively participate in the community, not just learn.

**"Can agency partners use our seats?"** — Yes. Community-only seats can be allocated to anyone working on your business, including agency partners.',
  170,
  'system'
);
