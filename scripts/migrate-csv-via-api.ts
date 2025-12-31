#!/usr/bin/env npx tsx
/**
 * CSV Migration via Admin API
 *
 * This script imports prospect data from a CSV file by calling the admin API.
 * This ensures all prospects get real WorkOS organization IDs and proper enrichment.
 *
 * Usage:
 *   npx tsx scripts/migrate-csv-via-api.ts --file <path-to-csv> --api-url <url> --cookie <session-cookie> [--dry-run]
 *
 * For local testing:
 *   npx tsx scripts/migrate-csv-via-api.ts --file prospects.csv --api-url http://localhost:3000 --cookie "wos-session=xxx"
 *
 * Supports two formats:
 * 1. Simple format: columns name, company_type, domain, contact_name, contact_email, notes, source
 * 2. AdCP Target List format: Google Sheet export with Company, Category, Who Owns Outreach, etc.
 *
 * Options:
 *   --file      Path to the CSV file
 *   --api-url   Base URL of the API (e.g., http://localhost:3000 or https://your-app.fly.dev)
 *   --cookie    Session cookie for authentication (must be admin)
 *   --dry-run   Show what would be imported without actually importing
 */

import * as fs from 'fs';

// Category to company_type mapping (for Google Sheet format)
const CATEGORY_TO_TYPE: Record<string, string> = {
  'Ad Tech': 'adtech',
  'Agency': 'agency',
  'Brand': 'brand',
  'Publisher': 'publisher',
  'Consulting': 'other',
  adtech: 'adtech',
  agency: 'agency',
  brand: 'brand',
  publisher: 'publisher',
  other: 'other',
};

// Map prospect owners from CSV to actual admin emails
const OWNER_MAPPING: Record<string, string> = {
  'Brian': 'brian@agenticadvertising.org',
  '(Brian)': 'brian@agenticadvertising.org',
  'brian': 'brian@agenticadvertising.org',
  'Matt': 'matt@journeysparkconsulting.com',
  'matt': 'matt@journeysparkconsulting.com',
  'Matt (Brian)': 'matt@journeysparkconsulting.com',
  'Randy': 'randall@randallrothenberg.com',
  'randy': 'randall@randallrothenberg.com',
  'Randy (Brian)': 'randall@randallrothenberg.com',
  '(Scope3)': 'brian@agenticadvertising.org',
  '(Swivel)': 'joe@swivel.ai',
};

// Interview status to prospect status mapping
const INTERVIEW_STATUS_MAPPING: Record<string, string> = {
  'Complete': 'responded',
  'Scheduled': 'contacted',
  'Scheduling': 'contacted',
  'Asked to do in Jan': 'contacted',
};

// Common company name to domain mappings for well-known companies
// This helps with enrichment when the CSV doesn't have domains
const KNOWN_DOMAINS: Record<string, string> = {
  'google': 'google.com',
  'meta': 'meta.com',
  'facebook': 'meta.com',
  'amazon': 'amazon.com',
  'apple': 'apple.com',
  'microsoft': 'microsoft.com',
  'netflix': 'netflix.com',
  'adobe': 'adobe.com',
  'salesforce': 'salesforce.com',
  'oracle': 'oracle.com',
  'ibm': 'ibm.com',
  'nvidia': 'nvidia.com',
  'openai': 'openai.com',
  'anthropic': 'anthropic.com',
  'thetradedesk': 'thetradedesk.com',
  'the trade desk': 'thetradedesk.com',
  'pubmatic': 'pubmatic.com',
  'magnite': 'magnite.com',
  'liveramp': 'liveramp.com',
  'nielsen': 'nielsen.com',
  'comscore': 'comscore.com',
  'criteo': 'criteo.com',
  'taboola': 'taboola.com',
  'outbrain': 'outbrain.com',
  'spotify': 'spotify.com',
  'roku': 'roku.com',
  'disney': 'disney.com',
  'walmart': 'walmart.com',
  'target': 'target.com',
  'coca-cola': 'coca-cola.com',
  'the coca-cola company': 'coca-cola.com',
  'pepsi': 'pepsico.com',
  'pepsico': 'pepsico.com',
  'unilever': 'unilever.com',
  'procter & gamble': 'pg.com',
  'p&g': 'pg.com',
  'loreal': 'loreal.com',
  "l'oreal": 'loreal.com',
  'estee lauder': 'elcompanies.com',
  'nike': 'nike.com',
  'adidas': 'adidas.com',
  'uber': 'uber.com',
  'airbnb': 'airbnb.com',
  'booking': 'booking.com',
  'expedia': 'expedia.com',
  'hilton': 'hilton.com',
  'marriott': 'marriott.com',
  'starbucks': 'starbucks.com',
  'mcdonalds': 'mcdonalds.com',
  "mcdonald's": 'mcdonalds.com',
  'chipotle': 'chipotle.com',
  'dominos': 'dominos.com',
  "domino's": 'dominos.com',
  'jpmorgan': 'jpmorgan.com',
  'jpmc': 'jpmorgan.com',
  'mastercard': 'mastercard.com',
  'visa': 'visa.com',
  'paypal': 'paypal.com',
  'stripe': 'stripe.com',
  'snowflake': 'snowflake.com',
  'databricks': 'databricks.com',
  'cloudflare': 'cloudflare.com',
  'twilio': 'twilio.com',
  'hubspot': 'hubspot.com',
  'mailchimp': 'mailchimp.com',
  'zendesk': 'zendesk.com',
  'shopify': 'shopify.com',
  'squarespace': 'squarespace.com',
  'wix': 'wix.com',
  'canva': 'canva.com',
  'figma': 'figma.com',
  'slack': 'slack.com',
  'zoom': 'zoom.us',
  'dropbox': 'dropbox.com',
  'box': 'box.com',
  'asana': 'asana.com',
  'monday': 'monday.com',
  'notion': 'notion.so',
  'airtable': 'airtable.com',
  // Ad tech / Marketing tech
  'scope3': 'scope3.com',
  'classify': 'classify.com',
  'ebiquity': 'ebiquity.com',
  'mediaocean': 'mediaocean.com',
  'media ocean': 'mediaocean.com',
  'innovid': 'mediaocean.com',
  'doubleverify': 'doubleverify.com',
  'integral ad science': 'integralads.com',
  'ias': 'integralads.com',
  'index exchange': 'indexexchange.com',
  'openx': 'microsoft.com',
  'appnexus': 'microsoft.com',
  'xandr': 'microsoft.com',
  'triplelift': 'triplelift.com',
  'viant': 'viantinc.com',
  'tremor': 'nexxen.com',
  'freewheel': 'freewheel.com',
  'springserve': 'magnite.com',
  'kargo': 'kargo.com',
  'gumgum': 'gumgum.com',
  'sharethrough': 'equativ.com',
  'equativ': 'equativ.com',
  'seedtag': 'seedtag.com',
  'teads': 'teads.com',
  'outfront': 'outfrontmedia.com',
  'clear channel': 'clearchannel.com',
  'lamar': 'lamar.com',
  // Agencies
  'wpp': 'wpp.com',
  'omnicom': 'omnicomgroup.com',
  'omnicom group': 'omnicomgroup.com',
  'publicis': 'publicisgroupe.com',
  'publicis groupe': 'publicisgroupe.com',
  'dentsu': 'dentsu.com',
  'ipg': 'omnicomgroup.com',
  'interpublic': 'omnicomgroup.com',
  'havas': 'havas.com',
  'accenture': 'accenture.com',
  'accenture song': 'accenture.com',
  'deloitte': 'deloitte.com',
  'deloitte digital': 'deloitte.com',
  'mckinsey': 'mckinsey.com',
  'bain': 'bain.com',
  'bcg': 'bcg.com',
  'boston consulting': 'bcg.com',
  'ogilvy': 'ogilvy.com',
  'mccann': 'mccann.com',
  'bbdo': 'bbdo.com',
  'ddb': 'ddb.com',
  'tbwa': 'tbwa.com',
  'grey': 'grey.com',
  'leo burnett': 'leoburnett.com',
  'saatchi': 'saatchi.com',
  'droga5': 'accenture.com',
  'r/ga': 'rga.com',
  'rga': 'rga.com',
  'huge': 'hugeinc.com',
  'razorfish': 'razorfish.com',
  'sapient': 'sapient.com',
  'merkle': 'merkle.com',
  'epsilon': 'epsilon.com',
  'acxiom': 'acxiom.com',
  'horizon media': 'horizonmedia.com',
  'mediacom': 'essencemediacom.com',
  'mindshare': 'mindshareworld.com',
  'wavemaker': 'wavemakerglobal.com',
  'groupm': 'wppmedia.com',
  'zenith': 'zenithmedia.com',
  'starcom': 'starcomww.com',
  'carat': 'carat.com',
  'dentsu creative': 'dentsucreative.com',
  // Publishers
  'new york times': 'nytimes.com',
  'nyt': 'nytimes.com',
  'washington post': 'washingtonpost.com',
  'wall street journal': 'dowjones.com',
  'wsj': 'dowjones.com',
  'bloomberg': 'bloomberg.com',
  'reuters': 'reuters.com',
  'associated press': 'ap.org',
  'ap': 'ap.org',
  'cnn': 'cnn.com',
  'fox': 'fox.com',
  'nbc': 'nbcuniversal.com',
  'nbcuniversal': 'nbcuniversal.com',
  'cbs': 'cbscorporation.com',
  'abc': 'abc.com',
  'espn': 'espn.com',
  'vox': 'voxmedia.com',
  'vox media': 'voxmedia.com',
  'buzzfeed': 'buzzfeed.com',
  'huffpost': 'huffpost.com',
  'vice': 'vice.com',
  'conde nast': 'condenast.com',
  'hearst': 'hearst.com',
  'meredith': 'meredith.com',
  'dotdash': 'dotdash.com',
  'dotdash meredith': 'dotdashmeredith.com',
  'gannett': 'gannett.com',
  'usa today': 'usatoday.com',
  'tribune': 'tribpub.com',
  'guardian': 'theguardian.com',
  'the guardian': 'theguardian.com',
  'bbc': 'bbc.com',
  'atlantic': 'theatlantic.com',
  'the atlantic': 'theatlantic.com',
  'reddit': 'reddit.com',
  'twitter': 'twitter.com',
  'x': 'x.com',
  'linkedin': 'linkedin.com',
  'pinterest': 'pinterest.com',
  'snapchat': 'snap.com',
  'snap': 'snap.com',
  'tiktok': 'tiktok.com',
  'bytedance': 'bytedance.com',
  'youtube': 'youtube.com',
  'twitch': 'twitch.tv',
  'yahoo': 'yahoo.com',
  'yahoo advertising': 'yahooinc.com',
  'verizon media': 'verizonmedia.com',
  'comcast': 'comcast.com',
  'nbcu': 'nbcuniversal.com',
  'peacock': 'peacocktv.com',
  'paramount': 'paramount.com',
  'paramount global': 'paramount.com',
  'warner bros': 'warnerbros.com',
  'warner bros discovery': 'wbd.com',
  'discovery': 'discovery.com',
  'hbo': 'hbo.com',
  'max': 'max.com',
  'hulu': 'hulu.com',
  'accuweather': 'accuweather.com',
  'weather company': 'weather.com',
  'the weather company': 'weather.com',
  'iheartmedia': 'iheartmedia.com',
  'iheart': 'iheartmedia.com',
  'audacy': 'audacy.com',
  'cumulus': 'cumulus.com',
  'sirius': 'siriusxm.com',
  'siriusxm': 'siriusxm.com',
  'scribd': 'scribd.com',
  // Brands - Retail
  'amazon': 'amazon.com',
  'ebay': 'ebay.com',
  'etsy': 'etsy.com',
  'wayfair': 'wayfair.com',
  'kroger': 'kroger.com',
  'costco': 'costco.com',
  'home depot': 'homedepot.com',
  'the home depot': 'homedepot.com',
  'lowes': 'lowes.com',
  "lowe's": 'lowes.com',
  'best buy': 'bestbuy.com',
  'cvs': 'cvs.com',
  'walgreens': 'walgreens.com',
  'walgreens boots alliance': 'walgreensbootsalliance.com',
  'rite aid': 'riteaid.com',
  'sephora': 'sephora.com',
  'ulta': 'ulta.com',
  'nordstrom': 'nordstrom.com',
  'macys': 'macys.com',
  "macy's": 'macys.com',
  'kohls': 'kohls.com',
  "kohl's": 'kohls.com',
  'gap': 'gap.com',
  'old navy': 'oldnavy.com',
  'zara': 'zara.com',
  'hm': 'hm.com',
  'h&m': 'hm.com',
  'ikea': 'ikea.com',
  // CPG / Food & Beverage
  'kraft heinz': 'kraftheinzcompany.com',
  'general mills': 'generalmills.com',
  'kellogg': 'kelloggs.com',
  "kellogg's": 'kelloggs.com',
  'mondelez': 'mondelezinternational.com',
  'nestle': 'nestle.com',
  'mars': 'mars.com',
  'hershey': 'thehersheycompany.com',
  "hershey's": 'thehersheycompany.com',
  'clorox': 'thecloroxcompany.com',
  'colgate': 'colgatepalmolive.com',
  'colgate-palmolive': 'colgatepalmolive.com',
  'johnson & johnson': 'jnj.com',
  'j&j': 'jnj.com',
  'coty': 'coty.com',
  'revlon': 'revlon.com',
  'diageo': 'diageo.com',
  'anheuser-busch': 'anheuser-busch.com',
  'ab inbev': 'ab-inbev.com',
  'constellation brands': 'cbrands.com',
  'brown-forman': 'brown-forman.com',
  // Auto / Transport
  'ford': 'ford.com',
  'gm': 'gm.com',
  'general motors': 'gm.com',
  'toyota': 'toyota.com',
  'honda': 'honda.com',
  'bmw': 'bmw.com',
  'mercedes': 'mercedes-benz.com',
  'mercedes-benz': 'mercedes-benz.com',
  'volkswagen': 'volkswagen.com',
  'vw': 'volkswagen.com',
  'audi': 'audi.com',
  'tesla': 'tesla.com',
  'rivian': 'rivian.com',
  'lyft': 'lyft.com',
  // Telecom
  'verizon': 'verizon.com',
  'at&t': 'att.com',
  'att': 'att.com',
  't-mobile': 't-mobile.com',
  'tmobile': 't-mobile.com',
  'sprint': 'sprint.com',
  'comcast xfinity': 'xfinity.com',
  'xfinity': 'xfinity.com',
  'charter': 'charter.com',
  'spectrum': 'spectrum.com',
  // Finance
  'bank of america': 'bankofamerica.com',
  'bofa': 'bankofamerica.com',
  'wells fargo': 'wellsfargo.com',
  'citi': 'citi.com',
  'citibank': 'citi.com',
  'goldman sachs': 'goldmansachs.com',
  'morgan stanley': 'morganstanley.com',
  'american express': 'americanexpress.com',
  'amex': 'americanexpress.com',
  'capital one': 'capitalone.com',
  'discover': 'discover.com',
  'fidelity': 'fidelity.com',
  'charles schwab': 'schwab.com',
  'schwab': 'schwab.com',
  'robinhood': 'robinhood.com',
  'coinbase': 'coinbase.com',
  'square': 'squareup.com',
  'block': 'block.xyz',
  'sofi': 'sofi.com',
  'affirm': 'affirm.com',
  'klarna': 'klarna.com',
  // Entertainment / Gaming
  'activision': 'activision.com',
  'blizzard': 'blizzard.com',
  'activision blizzard': 'activisionblizzard.com',
  'ea': 'ea.com',
  'electronic arts': 'ea.com',
  'take-two': 'take2games.com',
  'ubisoft': 'ubisoft.com',
  'epic games': 'epicgames.com',
  'epic': 'epicgames.com',
  'roblox': 'roblox.com',
  'unity': 'unity.com',
  'sony': 'sony.com',
  'playstation': 'playstation.com',
  'xbox': 'xbox.com',
  'nintendo': 'nintendo.com',
  // DTC Brands
  'warby parker': 'warbyparker.com',
  'glossier': 'glossier.com',
  'allbirds': 'allbirds.com',
  'casper': 'casper.com',
  'away': 'awaytravel.com',
  'dollar shave club': 'dollarshaveclub.com',
  'harrys': 'harrys.com',
  "harry's": 'harrys.com',
  'peloton': 'onepeloton.com',
  'noom': 'noom.com',
  'hims': 'forhims.com',
  'hers': 'forhers.com',
  'hims & hers': 'hims.com',
  'roman': 'ro.co',
  'ro': 'ro.co',
  'curology': 'curology.com',
  'stitch fix': 'stitchfix.com',
  'rent the runway': 'renttherunway.com',
  'blue apron': 'blueapron.com',
  'hellofresh': 'hellofresh.com',
  'chewy': 'chewy.com',
  'bark': 'bark.co',
  'barkbox': 'bark.co',
  // Match Group
  'match group': 'match.com',
  'match': 'match.com',
  'tinder': 'tinder.com',
  'hinge': 'hinge.co',
  'okcupid': 'okcupid.com',
  'bumble': 'bumble.com',
  // Additional ad tech companies from target list
  'nativo': 'nativo.com',
  'sambatv': 'samba.tv',
  'samba tv': 'samba.tv',
  'smartly': 'smartly.io',
  'swivel': 'swivel.cloud',
  'applovin': 'applovin.com',
  'app lovin': 'applovin.com',
  'appsflyer': 'appsflyer.com',
  'apps flyer': 'appsflyer.com',
  'celtra': 'celtra.com',
  'demandbase': 'demandbase.com',
  'dun & bradstreet': 'dnb.com',
  'experian': 'experian.com',
  'human': 'humansecurity.com',
  'human security': 'humansecurity.com',
  'ispot.tv': 'ispot.tv',
  'ispot': 'ispot.tv',
  'iterable': 'iterable.com',
  'jasper': 'jasper.ai',
  'jasper ai': 'jasper.ai',
  'kochava': 'kochava.com',
  'loopme': 'loopme.com',
  'loop me': 'loopme.com',
  'media.net': 'media.net',
  'medianet': 'media.net',
  'mistral ai': 'mistral.ai',
  'mistral': 'mistral.ai',
  'mntn': 'mountain.com',
  'moloco': 'moloco.com',
  'optimizely': 'optimizely.com',
  'perion': 'perion.com',
  'permutive': 'permutive.com',
  'stackadapt': 'stackadapt.com',
  'stack adapt': 'stackadapt.com',
  'transunion': 'transunion.com',
  'trans union': 'transunion.com',
  'videoamp': 'videoamp.com',
  'video amp': 'videoamp.com',
  'vidmob': 'vidmob.com',
  'raptive': 'raptive.com',
  'elevenlabs': 'elevenlabs.io',
  'eleven labs': 'elevenlabs.io',
  'stability ai': 'stability.ai',
  'stability': 'stability.ai',
  'bloomreach': 'bloomreach.com',
  'creatoriq': 'creatoriq.com',
  'creator iq': 'creatoriq.com',
  // Additional agencies from target list
  'edelman': 'edelman.com',
  'wieden+kennedy': 'wk.com',
  'wieden kennedy': 'wk.com',
  'w+k': 'wk.com',
  'stagwell': 'stagwellglobal.com',
  'anomaly': 'anomaly.com',
  's4 capital': 's4capital.com',
  's4capital': 's4capital.com',
  'media.monks': 'mediamonks.com',
  'mediamonks': 'mediamonks.com',
  'vml': 'vml.com',
  'code and theory': 'codeandtheory.com',
  'tombras': 'tombras.com',
  'kinesso': 'kinesso.com',
  // Additional publishers from target list
  'the new york times': 'nytimes.com',
  'new york times': 'nytimes.com',
  'the washington post': 'washingtonpost.com',
  'the wall street journal': 'wsj.com',
  'the guardian u.s.': 'theguardian.com',
  'newscorp': 'newscorp.com',
  'news corp': 'newscorp.com',
  'axel springer': 'axelspringer.com',
  'televisa univision': 'televisaunivision.com',
  'univision': 'univision.com',
  'iheartmedia/triton': 'iheartmedia.com',
  'comcast nbcu': 'nbcuniversal.com',
  'linkedin (microsoft)': 'linkedin.com',
  'twitter / x': 'x.com',
  'max / warner bros. discovery': 'wbd.com',
  'peacock / nbcuniversal': 'nbcuniversal.com',
  // Additional brands from target list
  'e.l.f. beauty': 'elfcosmetics.com',
  'e.l.f.': 'elfcosmetics.com',
  'elf beauty': 'elfcosmetics.com',
  'elf': 'elfcosmetics.com',
  'mondelez international': 'mondelezinternational.com',
  'eight sleep': 'eightsleep.com',
  'hydrow': 'hydrow.com',
  'magic spoon': 'magicspoon.com',
  'on running': 'on-running.com',
  'on': 'on-running.com',
  'skims': 'skims.com',
  'vuori': 'vuori.com',
  'whoop': 'whoop.com',
  'yum! brands': 'yum.com',
  'yum brands': 'yum.com',
  'carvana': 'carvana.com',
  "sam's club": 'samsclub.com',
  'sams club': 'samsclub.com',
  'ulta beauty': 'ulta.com',
  "mcdonald's (u.s.)": 'mcdonalds.com',
  'restaurant brands international': 'rbi.com',
  'rbi': 'rbi.com',
  "the wendy's company": 'wendys.com',
  "wendy's": 'wendys.com',
  'wendys': 'wendys.com',
  'bath & body works': 'bathandbodyworks.com',
  'bath and body works': 'bathandbodyworks.com',
  'function of beauty': 'functionofbeauty.com',
  'care/of': 'takecareof.com',
  'careof': 'takecareof.com',
  'prose': 'prose.com',
  'ruggable': 'ruggable.com',
  'lovevery': 'lovevery.com',
  'good american': 'goodamerican.com',
  'cariuma': 'cariuma.com',
  'pair eyewear': 'paireyewear.com',
  'athletic greens': 'athleticgreens.com',
  'ag1': 'athleticgreens.com',
  'athletic greens (ag1)': 'athleticgreens.com',
  'qualcomm': 'qualcomm.com',
  'qualcom': 'qualcomm.com',
  // Ad tech startups (many use .ai or .io domains)
  'newton research': 'newtonresearch.ai',
  'newtonresearch': 'newtonresearch.ai',
  'hypd': 'hypd.ai',
  'agentio': 'agentio.com',
  'airops': 'airops.com',
  'air ops': 'airops.com',
  'arcspan': 'arcspan.ai',
  'beehiiv': 'beehiiv.com',
  'black crow ai': 'blackcrow.ai',
  'blackcrow': 'blackcrow.ai',
  'chalice ai': 'chalice.ai',
  'chalice': 'chalice.ai',
  'danads': 'danads.com',
  'dan ads': 'danads.com',
  'haus': 'haus.io',
  'kerv interactive': 'kervit.com',
  'kerv': 'kervit.com',
  'lovable': 'lovable.dev',
  'luma ai': 'lumalabs.ai',
  'luma': 'lumalabs.ai',
  'mobian': 'mobian.io',
  'optimove': 'optimove.com',
  'pecan': 'pecan.ai',
  'pecan ai': 'pecan.ai',
  'peec ai': 'peec.ai',
  'peec': 'peec.ai',
  'twelve labs': 'twelvelabs.io',
  'twelvelabs': 'twelvelabs.io',
  'veylan': 'veylan.com',
  'optable': 'optable.co',
  'openads': 'openads.ai',
  'open ads': 'openads.ai',
  'bidcliq': 'bidcliq.com',
  'adgent': 'adgent.ai',
  'moment science': 'momentscience.com',
  'fal': 'fal.ai',
  'cognitiv': 'cognitiv.ai',
  'pixis': 'pixis.ai',
  'akkio': 'akkio.com',
  'silverside ai': 'silverside.ai',
  'silverside': 'silverside.ai',
  // Agencies from target list
  'butler/till': 'butlertill.com',
  'butlertill': 'butlertill.com',
  "pereira o'dell": 'pereiraodell.com',
  'pereira odell': 'pereiraodell.com',
  'huge (part of ipg)': 'hugeinc.com',
  'kiln': 'kiln.co',
  'the product counsel': 'theproductcounsel.com',
  'avenue z': 'avenuez.com',
  'assembly (omnicom)': 'assemblymarketing.com',
  'assembly': 'assemblymarketing.com',
  'carat (dentsu)': 'carat.com',
  'essencemediacom': 'essencemediacom.com',
  'essence mediacom': 'essencemediacom.com',
  'firsthand': 'firsthand.co',
  'groupm uk': 'wppmedia.com',
  'inbeat': 'inbeat.co',
  'interpublic group (ipg)': 'omnicomgroup.com',
  'keenfolks': 'keenfolks.com',
  'known': 'known.is',
  'left field labs': 'leftfieldlabs.com',
  'leo (leo burnett + publicis worldwide)': 'leoburnett.com',
  'maison meta': 'maisonmeta.io',
  'matrix marketing group': 'matrixmarketinggroup.com',
  'moloch': 'moloch.media',
  'nogood': 'nogood.io',
  'ogilvy one': 'ogilvy.com',
  'sixeastern': 'sixeastern.com',
  'tbwa melbourne': 'tbwa.com',
  'tbwa next': 'tbwa.com',
  'tbwa plex': 'tbwa.com',
  'tbwa worldhealth': 'tbwa.com',
  'tbwa worldwide': 'tbwa.com',
  // Publishers with specific formats
  'gannett / usa today network': 'gannett.com',
  'huffpost / buzzfeed inc.': 'huffpost.com',
  'bleacher report / wbd streaming': 'bleacherreport.com',
  'bleacher report': 'bleacherreport.com',
  'axel springer/business insider': 'axelspringer.com',
  'dotdash meredith (iac)': 'dotdashmeredith.com',
  'iheartmedia (duplicate)': 'iheartmedia.com',
  'wall street journal / dow jones': 'dowjones.com',
  'hypermindz': 'hypermindz.com',
  'telegraph': 'telegraph.co.uk',
  'the telegraph': 'telegraph.co.uk',
  'channel 4 (uk)': 'channel4.com',
  'channel 4': 'channel4.com',
  'dpg media (nl)': 'dpgmedia.nl',
  'dpg media': 'dpgmedia.nl',
  'schibsted (no)': 'schibsted.com',
  'schibsted': 'schibsted.com',
  'jcdecaux': 'jcdecaux.com',
  // More brands
  'brandtech': 'brandtechgroup.com',
  'cadent': 'cadent.tv',
  'caraway': 'carawayhome.com',
  'carewell': 'carewell.com',
  'channel factory': 'channelfactory.com',
  'converge digital': 'convergedigital.com',
  'covatic': 'covatic.com',
  'hellofresh (u.s.)': 'hellofresh.com',
  'ozone project': 'ozoneproject.com',
  'roman (ro)': 'ro.co',
  'booking holdings': 'bookingholdings.com',
  // International/other
  'draft digital (small nl agency)': 'draftdigital.nl',
  'draft digital': 'draftdigital.nl',
  'navigator (uk ad tech)': 'navigatoradtech.com',
  'navigator': 'navigatoradtech.com',
  'subjective.tv': 'subjective.tv',
  'subjective': 'subjective.tv',
  'above data': 'abovedata.com',
  'flexitive': 'flexitive.com',
  'adfidence': 'adfidence.com',
  'atomic ads': 'atomicads.com',
  'charter/spectrum': 'charter.com',
  'madconnect': 'madconnect.io',
  // Major brands
  'hp': 'hp.com',
  'hewlett-packard': 'hp.com',
  'hewlett packard': 'hp.com',
  'lg': 'lg.com',
  'lg electronics': 'lg.com',
  'comcast': 'comcast.com',
  'comcast / xfinity': 'comcast.com',
  'xfinity': 'xfinity.com',
  "mcdonald's": 'mcdonalds.com',
  "mcdonald's (u.s.)": 'mcdonalds.com',
  'mcdonalds': 'mcdonalds.com',
  "sam's club": 'samsclub.com',
  'sams club': 'samsclub.com',
  "the wendy's company": 'wendys.com',
  "wendy's": 'wendys.com',
  'wendys': 'wendys.com',
  'twitter': 'x.com',
  'twitter / x (xai)': 'x.com',
  'x': 'x.com',
  // Agencies
  'droga5': 'accenture.com',
  'droga5 são paulo': 'accenture.com',
  'droga5 sao paulo': 'accenture.com',
  'um': 'umww.com',
  'um (universal mccann)': 'umww.com',
  'universal mccann': 'umww.com',
  // Ad tech with variants
  'adgent (moment science)': 'momentscience.com',
  'rembrand': 'rembrand.com',
  'atomic ads (jeet)': 'atomicads.com',
};

/**
 * Try to derive a domain from company name using known mappings
 */
function deriveDomain(companyName: string): string | undefined {
  // Normalize Unicode apostrophes and quotes to ASCII
  const normalized = companyName
    .toLowerCase()
    .trim()
    .replace(/[\u2018\u2019\u201B]/g, "'")  // Curly single quotes to straight
    .replace(/[\u201C\u201D\u201F]/g, '"'); // Curly double quotes to straight

  // Direct lookup
  if (KNOWN_DOMAINS[normalized]) {
    return KNOWN_DOMAINS[normalized];
  }

  // Try removing common suffixes
  const withoutSuffix = normalized
    .replace(/\s+(inc|llc|ltd|corp|corporation|company|co|group|holdings|media|digital|advertising|marketing)\.?$/i, '')
    .trim();

  if (KNOWN_DOMAINS[withoutSuffix]) {
    return KNOWN_DOMAINS[withoutSuffix];
  }

  // Try common transformations
  const simplified = withoutSuffix.replace(/[^a-z0-9]/g, '');
  if (KNOWN_DOMAINS[simplified]) {
    return KNOWN_DOMAINS[simplified];
  }

  return undefined;
}

interface ParsedRow {
  name: string;
  company_type?: string;
  domain?: string;
  contact_name?: string;
  contact_email?: string;
  contact_title?: string;
  notes?: string;
  source?: string;
  owner?: string;
  status?: string;
  // Additional metadata from AdCP target list
  advisory_council?: boolean;
  steerco_priority?: boolean;
}

interface ImportResult {
  name: string;
  status: 'created' | 'exists' | 'error';
  orgId?: string;
  error?: string;
}

/**
 * Parse CSV with proper handling of quoted fields
 */
function parseCSV(content: string): string[][] {
  const rows: string[][] = [];
  const lines = content.split('\n');

  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        currentRow.push(currentCell.trim());
        currentCell = '';
      } else {
        currentCell += char;
      }
    }

    if (inQuotes) {
      currentCell += '\n';
      lineIndex++;
    } else {
      currentRow.push(currentCell.trim());
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      lineIndex++;
    }
  }

  if (currentRow.length > 0 || currentCell.trim()) {
    currentRow.push(currentCell.trim());
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Detect if this is the AdCP Target List format (Google Sheet export)
 */
function isAdCPTargetListFormat(headerRow: string[]): boolean {
  // Check for characteristic columns from the AdCP target list
  const headers = headerRow.map(h => h.toLowerCase());
  return headers.includes('company') &&
         (headers.includes('category') || headers.some(h => h.includes('advisory council')));
}

/**
 * Extract owner from the "Who Owns Outreach" field
 * Handles formats like "Brian", "(Brian)", "Randy (Brian)", etc.
 */
function extractOwner(rawOwner: string | undefined): string | undefined {
  if (!rawOwner) return undefined;
  const cleaned = rawOwner.trim();
  if (!cleaned) return undefined;

  // Check direct mappings first
  if (OWNER_MAPPING[cleaned]) return OWNER_MAPPING[cleaned];

  // Extract primary owner (first name mentioned)
  const match = cleaned.match(/^([A-Za-z]+)/);
  if (match) {
    const name = match[1];
    return OWNER_MAPPING[name] || name;
  }

  return undefined;
}

/**
 * Parse contact info from "Steerco - names" or "Executive Roster" columns
 * These often contain multiple contacts with titles
 */
function parseContactInfo(steercoNames: string | undefined, execRoster: string | undefined): {
  contact_name?: string;
  contact_title?: string;
} {
  // Try steerco names first (format: "Name, Title")
  if (steercoNames) {
    const parts = steercoNames.split(',').map(s => s.trim());
    if (parts.length >= 2) {
      return {
        contact_name: parts[0],
        contact_title: parts.slice(1).join(', '),
      };
    } else if (parts[0]) {
      return { contact_name: parts[0] };
    }
  }

  // Fall back to executive roster (may have more detailed info)
  if (execRoster) {
    // Take just the first line/entry
    const firstEntry = execRoster.split('\n')[0].split(';')[0].trim();
    if (firstEntry) {
      // Try to extract name and title if format is "Name - Title" or "Name (Title)"
      const dashMatch = firstEntry.match(/^([^-–]+)\s*[-–]\s*(.+)$/);
      if (dashMatch) {
        return {
          contact_name: dashMatch[1].trim(),
          contact_title: dashMatch[2].trim(),
        };
      }
      return { contact_name: firstEntry };
    }
  }

  return {};
}

/**
 * Build notes from various columns in AdCP target list
 */
function buildNotes(row: string[], colMap: Record<string, number>): string {
  const parts: string[] = [];

  // Add description if present
  const descCol = colMap['description'];
  if (descCol !== undefined && row[descCol]?.trim()) {
    parts.push(row[descCol].trim());
  }

  // Add executive roster as additional context
  const execCol = colMap['executive_roster/ai_champions'];
  if (execCol !== undefined && row[execCol]?.trim()) {
    parts.push(`\n\nKey contacts: ${row[execCol].trim()}`);
  }

  // Add interview status if present
  const interviewCol = colMap['interview_status'];
  if (interviewCol !== undefined && row[interviewCol]?.trim()) {
    parts.push(`\nInterview status: ${row[interviewCol].trim()}`);
  }

  return parts.join('');
}

/**
 * Parse CSV file into structured data
 * Supports both simple format and AdCP Target List format
 */
function parseFile(filePath: string): ParsedRow[] {
  const content = fs.readFileSync(filePath, 'utf8');
  let rows = parseCSV(content);

  if (rows.length < 2) {
    throw new Error('File must have at least a header row and one data row');
  }

  // Check if first row is a metadata/count row (AdCP target list has "Count,182,25,37,..." as first row)
  // The actual header row will have "Company" in the first column
  let headerRowIndex = 0;
  if (rows[0][0]?.toLowerCase() === 'count' && rows.length > 2) {
    // Skip the count row
    headerRowIndex = 1;
    console.log('Skipping metadata row (Count row detected)');
  }

  // First actual row is header
  const headerRow = rows[headerRowIndex];
  const colMap: Record<string, number> = {};
  headerRow.forEach((h, i) => {
    // Normalize header names
    colMap[h.toLowerCase().replace(/\s+/g, '_').replace(/[()]/g, '')] = i;
  });

  // Adjust rows to skip metadata and header
  rows = rows.slice(headerRowIndex + 1);

  console.log('Found columns:', Object.keys(colMap));

  const isTargetList = isAdCPTargetListFormat(headerRow);
  console.log(`Format detected: ${isTargetList ? 'AdCP Target List' : 'Simple CSV'}`);

  // Required column: name or company
  const nameCol = colMap['name'] ?? colMap['company'];
  if (nameCol === undefined) {
    throw new Error('Could not find "name" or "company" column');
  }

  // Column mappings (handle both formats)
  const typeCol = colMap['company_type'] ?? colMap['category'] ?? colMap['type'];
  const domainCol = colMap['domain'] ?? colMap['email_domain'];
  const contactNameCol = colMap['contact_name'] ?? colMap['contact'] ?? colMap['steerco_-_names'];
  const contactEmailCol = colMap['contact_email'] ?? colMap['email'];
  const notesCol = colMap['notes'] ?? colMap['description'];
  const sourceCol = colMap['source'] ?? colMap['source_list'];
  const ownerCol = colMap['who_owns_outreach'] ?? colMap['owner'];
  const interviewStatusCol = colMap['interview_status'];
  const advisoryCouncilCol = colMap['advisory_council_120'];
  const steercoPriorityCol = colMap['steerco_priorities_20-25'];
  const execRosterCol = colMap['executive_roster/ai_champions'];

  const results: ParsedRow[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row[nameCol]?.trim();

    if (!name || name.length < 2) continue;

    // Skip header-like rows or metadata rows
    if (name.toLowerCase() === 'company' || name.match(/^count$/i)) continue;

    // Skip section headers and notes rows (like "Randall duplicates", "Christina list", etc.)
    if (name.match(/^(randall|christina|brian|other|note:|a few others)/i) && !row[typeCol]?.trim()) continue;

    // Skip duplicate entries within the file
    const normalizedName = name.toLowerCase();
    if (seenNames.has(normalizedName)) continue;
    seenNames.add(normalizedName);

    // Determine company type
    const categoryValue = typeCol !== undefined ? row[typeCol]?.trim() : undefined;
    const companyType = categoryValue ? CATEGORY_TO_TYPE[categoryValue] || 'other' : undefined;

    // Parse contact info for target list format
    let contactName: string | undefined;
    let contactTitle: string | undefined;
    if (isTargetList) {
      const steercoNames = contactNameCol !== undefined ? row[contactNameCol]?.trim() : undefined;
      const execRoster = execRosterCol !== undefined ? row[execRosterCol]?.trim() : undefined;
      const contactInfo = parseContactInfo(steercoNames, execRoster);
      contactName = contactInfo.contact_name;
      contactTitle = contactInfo.contact_title;
    } else {
      contactName = contactNameCol !== undefined ? row[contactNameCol]?.trim() : undefined;
    }

    // Determine prospect status based on interview status
    let status: string | undefined;
    if (interviewStatusCol !== undefined) {
      const interviewStatus = row[interviewStatusCol]?.trim();
      status = interviewStatus ? INTERVIEW_STATUS_MAPPING[interviewStatus] : undefined;
    }

    // Build notes for target list format
    const notes = isTargetList
      ? buildNotes(row, colMap)
      : (notesCol !== undefined ? row[notesCol]?.trim() : undefined);

    // Determine source
    let source = sourceCol !== undefined ? row[sourceCol]?.trim() : undefined;
    if (!source) source = 'target_list_import';

    // Check advisory council and steerco priority flags
    const advisoryCouncil = advisoryCouncilCol !== undefined
      ? row[advisoryCouncilCol]?.trim()?.toLowerCase() === 'yes'
      : false;
    const steercoPriority = steercoPriorityCol !== undefined
      ? row[steercoPriorityCol]?.trim()?.toLowerCase() === 'yes'
      : false;

    // Get domain from CSV or derive from company name
    let domain = domainCol !== undefined ? row[domainCol]?.trim() || undefined : undefined;
    if (!domain) {
      domain = deriveDomain(name);
    }

    results.push({
      name,
      company_type: companyType,
      domain,
      contact_name: contactName || undefined,
      contact_email: contactEmailCol !== undefined ? row[contactEmailCol]?.trim() || undefined : undefined,
      contact_title: contactTitle || undefined,
      notes: notes || undefined,
      source,
      owner: extractOwner(ownerCol !== undefined ? row[ownerCol] : undefined),
      status,
      advisory_council: advisoryCouncil,
      steerco_priority: steercoPriority,
    });
  }

  return results;
}

/**
 * Create a prospect via the admin API
 */
async function createProspectViaAPI(
  apiUrl: string,
  cookie: string,
  prospect: ParsedRow
): Promise<{ success: boolean; orgId?: string; alreadyExists?: boolean; error?: string }> {
  // Build notes that include advisory council / steerco priority flags
  let notes = prospect.notes || '';
  const flags: string[] = [];
  if (prospect.advisory_council) flags.push('Advisory Council target');
  if (prospect.steerco_priority) flags.push('Steerco Priority');
  if (flags.length > 0) {
    notes = `[${flags.join(', ')}]\n\n${notes}`.trim();
  }

  const response = await fetch(`${apiUrl}/api/admin/prospects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({
      name: prospect.name,
      company_type: prospect.company_type,
      domain: prospect.domain,
      prospect_contact_name: prospect.contact_name,
      prospect_contact_email: prospect.contact_email,
      prospect_contact_title: prospect.contact_title,
      prospect_notes: notes,
      prospect_source: prospect.source,
      prospect_owner: prospect.owner,
      prospect_status: prospect.status,
    }),
  });

  if (response.status === 409) {
    const data = await response.json();
    return { success: false, alreadyExists: true, orgId: data.organization?.workos_organization_id };
  }

  if (!response.ok) {
    const text = await response.text();
    return { success: false, error: `HTTP ${response.status}: ${text}` };
  }

  const data = await response.json();
  return { success: true, orgId: data.organization?.workos_organization_id };
}

/**
 * Main migration function
 */
async function migrate(options: {
  file: string;
  apiUrl: string;
  cookie: string;
  dryRun: boolean;
}): Promise<void> {
  console.log('='.repeat(60));
  console.log('CSV Migration via Admin API');
  console.log('='.repeat(60));
  console.log(`File: ${options.file}`);
  console.log(`API URL: ${options.apiUrl}`);
  console.log(`Dry run: ${options.dryRun}`);
  console.log('');

  // Parse the file
  console.log('Parsing CSV file...');
  const prospects = parseFile(options.file);
  console.log(`Found ${prospects.length} unique companies`);

  // Show breakdown by type
  const byType: Record<string, number> = {};
  prospects.forEach((p) => {
    const type = p.company_type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  });
  console.log('\nBy company type:');
  Object.entries(byType).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });

  // Show domain stats
  const withDomain = prospects.filter(p => p.domain).length;
  const withoutDomain = prospects.filter(p => !p.domain);
  console.log(`\nDomain coverage: ${withDomain}/${prospects.length} (${Math.round(withDomain/prospects.length*100)}%)`);
  console.log('  (Domains enable automatic enrichment with Lusha)');

  if (withoutDomain.length > 0 && withoutDomain.length <= 30) {
    console.log(`\nCompanies without domains (${withoutDomain.length}):`);
    withoutDomain.forEach(p => {
      console.log(`  - ${p.name} (${p.company_type || 'unknown'})`);
    });
  }

  if (options.dryRun) {
    console.log('\n--- DRY RUN MODE ---');
    console.log('No changes will be made.\n');
    console.log('Sample prospects to import:');
    prospects.slice(0, 15).forEach((p) => {
      console.log(`  - ${p.name} (${p.company_type || 'unknown'})`);
      if (p.domain) console.log(`    Domain: ${p.domain} ✓ (will auto-enrich)`);
      if (p.contact_name) console.log(`    Contact: ${p.contact_name}`);
      if (p.owner) console.log(`    Owner: ${p.owner}`);
      if (p.status) console.log(`    Status: ${p.status}`);
      if (p.advisory_council || p.steerco_priority) {
        const flags = [];
        if (p.advisory_council) flags.push('Advisory Council');
        if (p.steerco_priority) flags.push('Steerco Priority');
        console.log(`    Flags: ${flags.join(', ')}`);
      }
    });
    return;
  }

  // Verify API access
  console.log('\nVerifying API access...');
  const testResponse = await fetch(`${options.apiUrl}/api/admin/prospects?limit=1`, {
    headers: { Cookie: options.cookie },
  });
  if (!testResponse.ok) {
    throw new Error(
      `API access failed: ${testResponse.status} ${testResponse.statusText}. Make sure you have admin access and the cookie is valid.`
    );
  }
  console.log('API access verified.\n');

  // Import prospects
  const results: ImportResult[] = [];
  let processed = 0;

  for (const prospect of prospects) {
    processed++;
    process.stdout.write(`\rProcessing ${processed}/${prospects.length}: ${prospect.name.substring(0, 30)}...`);

    try {
      const result = await createProspectViaAPI(options.apiUrl, options.cookie, prospect);

      if (result.success) {
        results.push({ name: prospect.name, status: 'created', orgId: result.orgId });
      } else if (result.alreadyExists) {
        results.push({ name: prospect.name, status: 'exists', orgId: result.orgId });
      } else {
        results.push({ name: prospect.name, status: 'error', error: result.error });
      }

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      results.push({
        name: prospect.name,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  console.log('\n\n' + '='.repeat(60));
  console.log('MIGRATION COMPLETE');
  console.log('='.repeat(60));

  const created = results.filter((r) => r.status === 'created').length;
  const exists = results.filter((r) => r.status === 'exists').length;
  const errors = results.filter((r) => r.status === 'error').length;

  console.log(`Created: ${created}`);
  console.log(`Already exists: ${exists}`);
  console.log(`Errors: ${errors}`);

  if (errors > 0) {
    console.log('\nErrors:');
    results
      .filter((r) => r.status === 'error')
      .slice(0, 20)
      .forEach((r) => {
        console.log(`  - ${r.name}: ${r.error}`);
      });
    if (errors > 20) {
      console.log(`  ... and ${errors - 20} more errors`);
    }
  }
}

// Parse command line arguments
function parseArgs(): { file: string; apiUrl: string; cookie: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  const options = {
    file: '',
    apiUrl: '',
    cookie: '',
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      options.file = args[i + 1];
      i++;
    } else if (args[i] === '--api-url' && args[i + 1]) {
      options.apiUrl = args[i + 1];
      i++;
    } else if (args[i] === '--cookie' && args[i + 1]) {
      options.cookie = args[i + 1];
      i++;
    } else if (args[i] === '--dry-run') {
      options.dryRun = true;
    }
  }

  if (!options.file) {
    console.error('Usage: npx tsx scripts/migrate-csv-via-api.ts --file <path-to-csv> --api-url <url> --cookie <session-cookie> [--dry-run]');
    console.error('\nExample:');
    console.error('  npx tsx scripts/migrate-csv-via-api.ts --file prospects.csv --api-url http://localhost:3000 --cookie "wos-session=xxx" --dry-run');
    process.exit(1);
  }

  if (!options.apiUrl && !options.dryRun) {
    console.error('Error: --api-url is required (unless using --dry-run)');
    process.exit(1);
  }

  if (!options.cookie && !options.dryRun) {
    console.error('Error: --cookie is required (unless using --dry-run)');
    process.exit(1);
  }

  if (!fs.existsSync(options.file)) {
    console.error(`File not found: ${options.file}`);
    process.exit(1);
  }

  return options;
}

// Run
const options = parseArgs();
migrate(options).catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
