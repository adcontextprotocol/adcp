-- Deep Prebid RTD module expertise for Addie.
-- Enables Addie to help debug publisher setups and advise orchestrator
-- builders on Prebid integration — without putting this in the core docs.
-- Supplements migrations 218 (Prebid basics) and 219 (AXE/orchestrator).

INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by) VALUES
(
  'knowledge',
  'Prebid RTD Module Internals',
  'Deep technical knowledge of Prebid RTD module architecture, submodule API, Scope3 implementation specifics, and debugging techniques',
  '## Prebid RTD Module Architecture

The RTD (Real-Time Data) infrastructure in Prebid.js is a core framework module (rtdModule) that orchestrates submodules. The core module manages auction timing and data merging; submodules do the actual data enrichment.

### Submodule Interface

RTD submodules implement RtdProviderSpec with these hooks:

**Required:**
- `name` (string) - Must match publisher''s dataProviders[].name config
- `init(config, consent) => boolean` - Validate config, return false to disable

**Data Hooks (implement one or both):**
- `getBidRequestData(request, callback, config, consent, timeout)` - Pre-auction. Modify bid requests via ortb2Fragments before they go to SSPs/exchanges. MUST call callback() when done, even on error.
- `getTargetingData(adUnitCodes, config, consent, auction) => object` - Post-auction. Return ad server targeting key-values per ad unit code (e.g., {''ad-unit-1'': {axei: ''seg123''}}).

**Event Hooks (optional):**
- `onAuctionInitEvent`, `onAuctionEndEvent`, `onBidRequestEvent`, `onBidResponseEvent`, `onBidAcceptedEvent`

**Registration:** `submodule(''realTimeData'', mySubModule);`

### Data Injection Patterns (Prebid v7+)

IMPORTANT: Since Prebid v7, global ortb2 config is frozen at auction start. Submodules MUST modify ortb2Fragments on the request object, not call mergeConfig.

Three injection targets:
1. `reqBidsConfigObj.ortb2Fragments.global` - All bidders see this (site.ext.data, user.data, etc.)
2. `reqBidsConfigObj.ortb2Fragments.bidder[''bidderName'']` - Per-bidder data
3. `reqBidsConfigObj.adUnits[].ortb2Imp` - Per-ad-unit impression data

### Auction Timing: auctionDelay + waitForIt

Publisher config:
```
pbjs.setConfig({
  realTimeData: {
    auctionDelay: 200,  // Max ms to wait
    dataProviders: [{
      name: ''scope3'',
      waitForIt: true    // This module can delay the auction
    }]
  }
});
```

How it works:
- Only modules with waitForIt: true AND auctionDelay > 0 can delay the auction
- auctionDelay is a ceiling, not a fixed delay — auction proceeds as soon as all waitForIt modules call back
- If timeout fires before callbacks, auction proceeds without the data
- Non-waitForIt modules run in parallel but never block

### Privacy and Storage

All hooks receive userConsent with: gdpr (TCF), usp (CCPA), gpp (Global Privacy Platform), coppa (boolean).
Modules must use getStorageManager() for cookie/localStorage access, not direct browser APIs.

## Scope3 RTD Module Specifics

Scope3''s scope3RtdProvider implements AXE for Prebid. Key details:

**Publisher params:**
- orgId (required) - Scope3 organization identifier
- endpoint (default: https://prebid.scope3.com/prebid) - AXE API endpoint
- timeout (default: 1000ms) - Request timeout
- includeKey (default: ''axei'') - GAM targeting key for include segments
- excludeKey (default: ''axex'') - GAM targeting key for exclude segments
- macroKey (default: ''axem'') - GAM targeting key for macro data

**How it works:**
1. getBidRequestData: Extracts OpenRTB data from ortb2Fragments.global, builds imp array from adUnits, POSTs to Scope3 endpoint
2. Scope3 evaluates segments and returns: include[] (opaque targeting codes), exclude[] (suppression codes), macro (base64 contextual payload), bidders.{name}.segments/deals
3. Module distributes signals to: ortb2Fragments.global (all bidders), ortb2Fragments.bidder (per-bidder segments/deals), adUnit.ortb2Imp (per-slot)
4. getTargetingData: Returns cached signals as axei/axex/axem key-values per ad unit for GAM

**Caching:** Responses cached by domain+page+user key, configurable TTL (default 5 min).

## Common Debugging

**Module not loading:**
- Check pbjs.installedModules includes ''scope3RtdProvider'' (or the module name)
- Verify rtdModule is also in the build: gulp build --modules=rtdModule,scope3RtdProvider
- Check browser console for "RTD provider ''scope3'': error in ''init''" messages

**Data not reaching bidders:**
- Verify getBidRequestData callback is being called (auction won''t proceed for waitForIt modules otherwise)
- Check ortb2Fragments modification — must modify the request object, not global config
- Inspect bid requests in network tab for expected ortb2 data

**Key-values not in ad server request:**
- getTargetingData must return data keyed by ad unit code: {''div-gpt-ad-123'': {axei: ''value''}}
- Check GAM targeting in browser: googletag.pubads().getTargeting(''axei'')
- Verify line items in GAM target the correct keys (axei, axex, axem)

**Auction proceeding without RTD data:**
- Check auctionDelay is set and > 0
- Check waitForIt: true on the module''s dataProviders config
- If the module''s endpoint is slow, increase auctionDelay (but watch total page latency)
- Module must always call callback(), even on error — if it doesn''t, auction waits until auctionDelay timeout

**How to inspect a publisher''s setup:**
- pbjs.installedModules — list all loaded modules
- pbjs.getConfig(''realTimeData'') — see RTD configuration
- pbjs.getConfig(''ortb2'') — see first-party data config
- Network tab: filter for the orchestrator''s endpoint (e.g., prebid.scope3.com)
- GAM request: look for axei/axex/axem in key-value params

Note: Prebid and Scope3 are external projects. For their latest API details, use search_repos with repo_ids "prebid-docs", "prebid-js", or "prebid-server". The above is operational knowledge to help users debug — always verify against current Prebid documentation for the definitive API.',
  164,
  'system'
);
