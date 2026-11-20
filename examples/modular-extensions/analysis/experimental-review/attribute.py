import json, re
d = json.load(open('markers.json'))
ids = d['ids']
PRIMARY_OVERRIDE = {
 ('core/hold-policy.json','/'): 'media_buy.hold_policy',
 ('core/hold-policy.json','/properties/available'): 'media_buy.hold_policy',
 ('core/hold-policy.json','/properties/min_duration'): 'media_buy.hold_policy',
 ('core/hold-policy.json','/properties/max_duration'): 'media_buy.hold_policy',
 ('core/hold-policy.json','/properties/max_total_duration'): 'media_buy.hold_extension',
 ('core/canonical-proposal.json','/properties/holds'): 'media_buy.installment_holds',
 ('core/response-collection.json','/'): 'media_buy.collection_cards',
 ('media-buy/list-collections-request.json','/'): 'media_buy.collection_catalog',
 ('protocol/get-adcp-capabilities-response.json','/properties/media_buy/properties/proposal_refinement/properties/hold_extension'): 'media_buy.hold_extension',
 ('protocol/get-adcp-capabilities-response.json','/properties/media_buy/properties/proposal_refinement/properties/hold_semantics'): 'media_buy.delegated_composition',
 ('media-buy/proposal-refinement.json','/oneOf/1'): 'media_buy.hold_extension',
}
RULES = [
 (r'^trusted-match/', None, 'trusted_match.core'),
 (r'^core/seller-agent-ref\.json$', None, 'trusted_match.core'),
 (r'get-adcp-capabilities-response', r'execution/properties/trusted_match', 'trusted_match.core'),
 (r'^sponsored-intelligence/', None, 'sponsored_intelligence.core'),
 (r'get-adcp-capabilities-response', r'/sponsored_intelligence$', 'sponsored_intelligence.core'),
 (r'^governance/', None, 'governance.campaign'),
 (r'^enums/governance-mode', None, 'governance.campaign'),
 (r'get-adcp-capabilities-response', r'governance_enforcement', 'governance.campaign'),
 (r'^brand/(acquire|get|update)-rights|^brand/rights-', None, 'brand.rights_lifecycle'),
 (r'^enums/right-', None, 'brand.rights_lifecycle'),
 (r'get-adcp-capabilities-response', r'/properties/brand/', 'brand.rights_lifecycle'),
 (r'^brand/search-brands', None, 'UNREG:search_brands'),
 (r'^core/delivery-metrics', r'ooh_metrics', 'UNREG:ooh_metrics'),
 (r'^core/delivery-metrics', r'print_metrics', 'UNREG:print_metrics'),
 (r'^core/placement-evidence', None, 'UNREG:placement_evidence'),
 (r'^error-details/accessibility-violation', None, 'UNREG:accessibility_violation'),
 (r'^core/principal-|^enums/principal-kind|^protocol/(get|sync)-principal|^core/agent-reporting-destination|^enums/delivery-recipient-cloud|^enums/reporting-destination-setup-state', None, 'protocol.principal'),
 (r'^core/reporting-|^media-buy/(sync|get)-reporting-', None, 'media_buy.reporting_delivery'),
 (r'reporting_delivery_configs', None, 'media_buy.reporting_delivery'),
 (r'', r'reporting_delivery_configs', 'media_buy.reporting_delivery'),
 (r'^core/performance-feedback-assertion|^media-buy/provide-performance-feedback-response', None, 'measurement.core'),
 (r'get-adcp-capabilities-response', r'performance_feedback', 'measurement.core'),
 (r'canonical-product|^core/product\.json', r'execution_requirements', 'media_buy.execution_requirements'),
 (r'canonical-product|^core/product\.json', r'/identity$', 'media_buy.product_identity'),
 (r'daypart', None, 'media_buy.daypart_granularity'),
 (r'', r'[dD]aypart', 'media_buy.daypart_granularity'),
 (r'^core/spot-reporting|^enums/spot-status|get-media-buy-delivery-response', None, 'media_buy.spot_lifecycle'),
 (r'build-creative|get-adcp-capabilities-response', r'signal_condition|selection_strategy|conditions_total', 'creative.signal_fanout'),
 (r'sync-audiences-response', None, 'media_buy.audience_activation'),
]
rows=[]
for m in d['markers']:
    key=(m['file'],m['ptr'])
    fid = PRIMARY_OVERRIDE.get(key)
    if not fid and len(m['ids'])==1: fid=m['ids'][0]
    if not fid:
        for fre,pre,v in RULES:
            if re.search(fre,m['file']) and (pre is None or re.search(pre,m['ptr'])):
                fid=v;break
    if not fid and len(m['ids'])>1: fid=m['ids'][0]
    m['fid']=fid or 'UNKNOWN'
    rows.append(m)
json.dump(rows,open('attributed.json','w'),indent=1)
from collections import Counter
c=Counter(r['fid'] for r in rows)
for k,v in sorted(c.items()): print(v,k)
print(sum(c.values()))
