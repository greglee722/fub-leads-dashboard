'use strict';
const https = require('https');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const VERSION = '0.4.0';
const DATA_FILE = path.join(__dirname, 'public', 'data.json');

// Boston metro ZIP → neighborhood (matches active-ads-combine)
const ZIP_NEIGHBORHOODS = {
  '02108': 'Beacon Hill', '02109': 'North End', '02110': 'Downtown', '02111': 'Chinatown',
  '02113': 'North End', '02114': 'Beacon Hill', '02115': 'Fenway', '02116': 'Back Bay',
  '02118': 'South End', '02119': 'Roxbury', '02120': 'Mission Hill', '02121': 'Dorchester',
  '02122': 'Dorchester', '02124': 'Dorchester', '02125': 'Dorchester', '02126': 'Mattapan',
  '02127': 'South Boston', '02128': 'East Boston', '02129': 'Charlestown',
  '02130': 'Jamaica Plain', '02131': 'Roslindale', '02132': 'West Roxbury',
  '02134': 'Allston', '02135': 'Brighton', '02136': 'Hyde Park',
  '02163': 'Allston', '02199': 'Back Bay', '02210': 'Seaport', '02215': 'Fenway/Kenmore',
  '02138': 'Cambridge (Harvard Sq)', '02139': 'Cambridge (Central Sq)',
  '02140': 'Cambridge (Porter Sq)', '02141': 'East Cambridge', '02142': 'East Cambridge',
  '02143': 'Somerville (Union Sq)', '02144': 'Somerville (Davis Sq)', '02145': 'Somerville (Winter Hill)',
  '02445': 'Brookline', '02446': 'Brookline (Coolidge Corner)', '02447': 'Brookline',
  '02459': 'Newton', '02460': 'Newton', '02461': 'Newton', '02458': 'Newton',
};

// Mon → pull Fri+Sat+Sun; Tue–Fri → pull yesterday
// Set BACKFILL_DAYS=30 env var for a one-time historical backfill
function getDateRange() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const backfillDays = process.env.BACKFILL_DAYS ? parseInt(process.env.BACKFILL_DAYS, 10) : null;
  if (backfillDays) {
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - backfillDays);
    return { startDate, endDate: today };
  }

  const startDate = new Date(today);
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon...6=Sat

  if (dayOfWeek === 1) {
    startDate.setDate(today.getDate() - 3); // back to Friday
  } else {
    startDate.setDate(today.getDate() - 1); // yesterday
  }

  return { startDate, endDate: today };
}

function httpsGet(url, apiKey) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const req = https.get(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'User-Agent': `fub-leads-dashboard/${VERSION}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`FUB API ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Bad JSON from FUB: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── YGL Integration ───────────────────────────────────────────────────────────

// Only fetch inventory for these 5 neighborhoods
const YGL_TARGET_ZIPS = {
  'Fenway':      ['02115', '02215'],
  'Back Bay':    ['02116', '02117', '02199'],
  'South End':   ['02118'],
  'North End':   ['02109', '02113'],
  'Beacon Hill': ['02108', '02114'],
};
const YGL_TARGET_ZIP_SET = new Set(Object.values(YGL_TARGET_ZIPS).flat());

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)<\/${tag}>`));
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
}

function normalizeYGLBeds(bedInfo) {
  if (!bedInfo) return null;
  const s = String(bedInfo).toLowerCase().trim();
  if (s === 'studio' || s === '0') return 0;
  const n = parseInt(s, 10);
  return isNaN(n) || n < 0 ? null : n;
}

function parseYGLXml(raw) {
  const blocks = raw.match(/<Listing>[\s\S]*?<\/Listing>/g) || [];
  return blocks.map(block => {
    const zip = xmlTag(block, 'Zip').replace(/\D/g, '').slice(0, 5);
    return {
      id:             xmlTag(block, 'ID'),
      address:        `${xmlTag(block, 'StreetNumber')} ${xmlTag(block, 'StreetName')}`.trim(),
      unit:           xmlTag(block, 'Unit'),
      city:           xmlTag(block, 'City'),
      zip,
      neighborhood:   zip ? (ZIP_NEIGHBORHOODS[zip] || null) : null,
      beds:           normalizeYGLBeds(xmlTag(block, 'BedInfo') || xmlTag(block, 'Beds')),
      price:          parseInt(xmlTag(block, 'Price'), 10) || null,
      available_date: xmlTag(block, 'AvailableDate'),
      fee:            xmlTag(block, 'Fee') === '1',
    };
  }).filter(l => l.id);
}

async function fetchYGLListings(apiKey) {
  // YGL API doesn't support zip filtering — fetch all and filter post-fetch to 5 target neighborhoods
  return new Promise((resolve) => {
    const body = `key=${encodeURIComponent(apiKey)}&status=ONMARKET`;
    const req = require('https').request({
      hostname: 'www.yougotlistings.com',
      path: '/api/rentals/search.php',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const all = parseYGLXml(raw);
          const listings = all.filter(l => YGL_TARGET_ZIP_SET.has(l.zip));
          const byNbhd = {};
          for (const l of listings) {
            byNbhd[l.neighborhood] = (byNbhd[l.neighborhood] || 0) + 1;
          }
          console.log(`  Got ${listings.length}/${all.length} YGL listings (5 target neighborhoods)`);
          Object.entries(byNbhd).forEach(([n, c]) => console.log(`    ${n}: ${c}`));
          resolve(listings);
        } catch (e) {
          console.warn('  YGL parse error:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => { console.warn('  YGL fetch error:', e.message); resolve([]); });
    req.write(body);
    req.end();
  });
}

function extractZip(address) {
  const match = (address || '').match(/\b(\d{5})\b/);
  return match ? match[1] : null;
}

function getNeighborhood(zip) {
  return zip ? (ZIP_NEIGHBORHOODS[zip] || null) : null;
}

function normalizeBeds(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseInt(raw, 10);
  return isNaN(n) || n < 0 ? null : n;
}

// Fetch Property Inquiry events for a person and extract the best property data.
// FUB events have a `property` object with street, city, state, code (ZIP), bedrooms, price, url.
async function fetchPropertyData(apiKey, personId) {
  try {
    const data = await httpsGet(
      `https://api.followupboss.com/v1/events?personId=${personId}&limit=20`,
      apiKey
    );
    const events = (data.events || []).filter(e => e.property != null);
    if (!events.length) return null;
    // Prefer the event with the most data
    events.sort((a, b) => {
      const score = e => (e.property.street ? 2 : 0) + (e.property.bedrooms != null ? 1 : 0);
      return score(b) - score(a);
    });
    return events[0].property;
  } catch {
    return null;
  }
}

function propertyToAddress(prop) {
  if (!prop) return null;
  return [prop.street, prop.city, prop.state, prop.code].filter(Boolean).join(', ') || null;
}

async function fetchFubPeople(apiKey, startDate, endDate) {
  const results = [];
  let offset = 0;
  const limit = 100;
  let page = 1;

  while (true) {
    const url = `https://api.followupboss.com/v1/people?sort=-created&limit=${limit}&offset=${offset}`;
    console.log(`  Fetching page ${page} (offset ${offset})...`);

    const data = await httpsGet(url, apiKey);
    const people = data.people || [];
    if (people.length === 0) break;

    let hitOldDate = false;
    for (const p of people) {
      const created = new Date(p.created);
      if (created < startDate) { hitOldDate = true; break; }
      if (created < endDate) results.push(p);
    }

    if (hitOldDate || people.length < limit) break;
    offset += limit;
    page++;
  }

  return results;
}

function toEasternDate(isoString) {
  const d = new Date(isoString);
  const parts = d.toLocaleDateString('en-US', { timeZone: 'America/New_York' }).split('/');
  if (parts.length !== 3) return null;
  return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
}

async function processLead(person, apiKey) {
  const prop = await fetchPropertyData(apiKey, person.id);
  const address = propertyToAddress(prop) || null;
  const zip = prop?.code || extractZip(address);

  return {
    fub_id: String(person.id),
    agent_name: person.assignedTo || null,
    lead_date: person.created ? toEasternDate(person.created) : null,
    address,
    zip,
    neighborhood: getNeighborhood(zip),
    beds: prop?.bedrooms != null ? normalizeBeds(prop.bedrooms) : null,
    price: prop?.price ? parseInt(prop.price, 10) || null : null,
    zillow_url: (prop?.url && String(prop.url).includes('zillow')) ? prop.url : null,
    lead_name: person.name || [person.firstName, person.lastName].filter(Boolean).join(' ') || null,
    source: person.source || null,
    stage: person.stage || null,
  };
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS fub_leads (
      id           SERIAL PRIMARY KEY,
      fub_id       VARCHAR UNIQUE NOT NULL,
      agent_name   VARCHAR,
      lead_date    DATE NOT NULL,
      address      TEXT,
      zip          VARCHAR(10),
      neighborhood VARCHAR,
      beds         INTEGER,
      price        INTEGER,
      zillow_url   TEXT,
      lead_name    VARCHAR,
      source       VARCHAR,
      stage        VARCHAR,
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_fub_leads_date ON fub_leads(lead_date)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_fub_leads_agent ON fub_leads(agent_name)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_fub_leads_neighborhood ON fub_leads(neighborhood)`);
}

async function ensureZillowPricesTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS zillow_prices (
      address    TEXT PRIMARY KEY,
      price      INTEGER,
      beds       INTEGER,
      scraped_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

const EXCLUDED_SOURCES = ['Website', 'Apartments.com'];

async function upsertLeads(client, leads) {
  for (const lead of leads) {
    if (!lead.lead_date) continue;
    if (lead.source && EXCLUDED_SOURCES.includes(lead.source)) continue;
    await client.query(`
      INSERT INTO fub_leads
        (fub_id, agent_name, lead_date, address, zip, neighborhood, beds, price, zillow_url, lead_name, source, stage)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (fub_id) DO UPDATE SET
        agent_name   = EXCLUDED.agent_name,
        lead_date    = EXCLUDED.lead_date,
        address      = COALESCE(EXCLUDED.address, fub_leads.address),
        zip          = COALESCE(EXCLUDED.zip, fub_leads.zip),
        neighborhood = COALESCE(EXCLUDED.neighborhood, fub_leads.neighborhood),
        beds         = COALESCE(EXCLUDED.beds, fub_leads.beds),
        price        = COALESCE(EXCLUDED.price, fub_leads.price),
        zillow_url   = COALESCE(EXCLUDED.zillow_url, fub_leads.zillow_url),
        lead_name    = EXCLUDED.lead_name,
        source       = EXCLUDED.source,
        stage        = EXCLUDED.stage
    `, [
      lead.fub_id, lead.agent_name, lead.lead_date, lead.address, lead.zip,
      lead.neighborhood, lead.beds, lead.price, lead.zillow_url,
      lead.lead_name, lead.source, lead.stage,
    ]);
  }
  console.log(`  Upserted ${leads.length} leads`);
}

// ── Zillow Price Enrichment (Google CSE → zpid → Unofficial Zillow API) ────────

// Step 1: Serper.dev Google search → find Zillow homedetails URL → extract zpid
// Tries exact address first, then falls back to street + city (no unit/zip) for better hit rate
function serperSearch(query, serperApiKey) {
  const body = JSON.stringify({ q: query, num: 5 });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'google.serper.dev',
      path: '/search',
      method: 'POST',
      headers: {
        'X-API-KEY': serperApiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function extractZpidFromResults(results) {
  for (const r of (results || [])) {
    const match = (r.link || '').match(/\/(\d+)_zpid/);
    if (match) return match[1];
  }
  return null;
}

// Build address format variations for the same unit
// FUB: "127 Myrtle St #3, Boston, MA, 02114"
// Zillow may index as: "127 Myrtle St APT 3" or "127 Myrtle St 3"
function getAddressVariations(address) {
  const variations = [];
  const parts = address.split(',').map(s => s.trim());
  const street = parts[0] || '';
  const city = parts[1] || '';

  // Extract unit from "#X" pattern
  const unitMatch = street.match(/^(.+?)\s*#(\S+)$/);
  if (unitMatch) {
    const base = unitMatch[1];
    const unit = unitMatch[2];
    // Try: "Street APT Unit, City" then "Street Unit, City"
    variations.push(`${base} APT ${unit}, ${city}`);
    variations.push(`${base} ${unit}, ${city}`);
  }
  return variations;
}

async function fetchZpidFromSerper(address, serperApiKey) {
  // Try 1: exact address match
  const exact = await serperSearch(`"${address}" site:zillow.com/homedetails`, serperApiKey);
  const zpid = extractZpidFromResults(exact?.organic);
  if (zpid) return zpid;

  // Try 2-3: unit format variations (# → APT, # → bare number)
  const variations = getAddressVariations(address);
  for (const variant of variations) {
    await new Promise(r => setTimeout(r, 500));
    const result = await serperSearch(`"${variant}" site:zillow.com/homedetails`, serperApiKey);
    const found = extractZpidFromResults(result?.organic);
    if (found) return found;
  }
  return null;
}

// Step 2: Unofficial Zillow API → /property/all?zpid=xxx → extract rental price
async function fetchZpidPrice(zpid, rapidApiKey) {
  return new Promise(resolve => {
    const opts = {
      hostname: 'unofficial-zillow-api2.p.rapidapi.com',
      path: `/property/all?zpid=${zpid}`,
      method: 'GET',
      headers: {
        'x-rapidapi-host': 'unofficial-zillow-api2.p.rapidapi.com',
        'x-rapidapi-key': rapidApiKey,
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          const beds = r.bedrooms || null;
          const history = r.priceHistory || [];
          // Rental prices are monthly (< $20k); sale prices are much higher
          const rentalEntry = history.find(e => e.price && e.price < 20000);
          if (rentalEntry) {
            resolve({ price: parseInt(rentalEntry.price, 10), beds });
            return;
          }
          resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function enrichZillowPrices(client, rapidApiKey, serperApiKey) {
  const backfillDays = process.env.ZILLOW_BACKFILL ? parseInt(process.env.ZILLOW_BACKFILL, 10) : 2;
  const { rows } = await client.query(`
    SELECT DISTINCT fl.address FROM fub_leads fl
    LEFT JOIN zillow_prices zp ON zp.address = fl.address
    WHERE fl.address IS NOT NULL
      AND fl.lead_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      AND zp.address IS NULL
    ORDER BY fl.address
  `, [backfillDays]);

  if (!rows.length) { console.log('  No new addresses to price'); return; }
  console.log(`  Fetching Zillow prices for ${rows.length} address(es) (last ${backfillDays} days)...`);

  let priced = 0;
  for (const { address } of rows) {
    const zpid = await fetchZpidFromSerper(address, serperApiKey);
    if (!zpid) {
      console.log(`    No zpid found: ${address}`);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    const result = await fetchZpidPrice(zpid, rapidApiKey);
    if (result && result.price) {
      await client.query(`
        INSERT INTO zillow_prices (address, price, beds, scraped_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (address) DO UPDATE SET
          price = EXCLUDED.price,
          beds = EXCLUDED.beds,
          scraped_at = NOW()
      `, [address, result.price, result.beds]);
      priced++;
      console.log(`    ${address} → zpid ${zpid} → $${result.price}`);
    } else {
      console.log(`    No rental price: ${address} (zpid ${zpid})`);
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  console.log(`  Priced ${priced}/${rows.length} address(es)`);
}

async function generateDataJson(client, yglListings = []) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 180);

  const { rows } = await client.query(`
    SELECT id, fub_id, agent_name, lead_date, address, zip, neighborhood,
           beds, price, zillow_url, lead_name, source, stage
    FROM fub_leads
    WHERE lead_date >= $1
      AND (source IS NULL OR source NOT IN ('Website', 'Apartments.com'))
    ORDER BY lead_date DESC, id DESC
  `, [cutoff.toISOString().split('T')[0]]);

  const leads = rows.map(r => ({
    id: r.id,
    fub_id: r.fub_id,
    agent: r.agent_name,
    date: r.lead_date instanceof Date
      ? r.lead_date.toISOString().split('T')[0]
      : String(r.lead_date).split('T')[0],
    address: r.address,
    zip: r.zip,
    neighborhood: r.neighborhood,
    beds: r.beds,
    price: r.price,
    zillow_url: r.zillow_url,
    lead_name: r.lead_name,
    source: r.source,
    stage: r.stage,
  }));

  const agents = [...new Set(leads.map(l => l.agent).filter(Boolean))].sort();
  const neighborhoods = [...new Set(leads.map(l => l.neighborhood).filter(Boolean))].sort();

  let zillowPrices = {};
  try {
    const { rows: priceRows } = await client.query('SELECT address, price, beds FROM zillow_prices');
    for (const r of priceRows) {
      zillowPrices[r.address] = { price: r.price, beds: r.beds };
    }
    console.log(`  Loaded ${priceRows.length} Zillow prices`);
  } catch {
    // table doesn't exist yet — no prices available
  }

  fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ generated: new Date().toISOString(), version: VERSION, agents, neighborhoods, leads, yglListings, zillowPrices }, null, 2));
  console.log(`  Wrote ${leads.length} leads → public/data.json`);
}

async function enrichNullAddressLeads(client, apiKey) {
  const { rows } = await client.query(`
    SELECT fub_id FROM fub_leads
    WHERE address IS NULL
      AND lead_date >= CURRENT_DATE - INTERVAL '14 days'
      AND (source IS NULL OR source NOT IN ('Website', 'Apartments.com'))
    ORDER BY lead_date DESC
  `);

  if (!rows.length) { console.log('  No null-address leads to enrich'); return; }
  console.log(`  Enriching ${rows.length} null-address lead(s) from last 14 days...`);

  let enriched = 0;
  for (const { fub_id } of rows) {
    const prop = await fetchPropertyData(apiKey, fub_id);
    const address = prop ? (propertyToAddress(prop) || null) : null;

    if (address) {
      const zip = prop?.code || extractZip(address);
      const neighborhood = getNeighborhood(zip);
      const beds = prop?.bedrooms != null ? normalizeBeds(prop.bedrooms) : null;
      const price = prop?.price ? parseInt(prop.price, 10) || null : null;
      const zillow_url = (prop?.url && String(prop.url).includes('zillow')) ? prop.url : null;
      await client.query(`
        UPDATE fub_leads SET
          address      = COALESCE(address, $1),
          zip          = COALESCE(zip, $2),
          neighborhood = COALESCE(neighborhood, $3),
          beds         = COALESCE(beds, $4),
          price        = COALESCE(price, $5),
          zillow_url   = COALESCE(zillow_url, $6)
        WHERE fub_id = $7 AND address IS NULL
      `, [address, zip, neighborhood, beds, price, zillow_url, fub_id]);
      enriched++;
    }

    await new Promise(r => setTimeout(r, 700));
  }
  console.log(`  Enriched ${enriched}/${rows.length} lead(s)`);
}

async function main() {
  const apiKey = process.env.FUB_API_KEY;
  const dbUrl = process.env.DATABASE_URL;
  if (!apiKey) { console.error('FUB_API_KEY required'); process.exit(1); }
  if (!dbUrl)  { console.error('DATABASE_URL required'); process.exit(1); }

  const { startDate, endDate } = getDateRange();
  console.log(`FUB Leads Dashboard Sync v${VERSION}`);
  console.log(`Date range: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);

  console.log('\nFetching leads from FUB...');
  const people = await fetchFubPeople(apiKey, startDate, endDate);
  console.log(`Found ${people.length} lead(s)`);

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await ensureTable(client);
  await ensureZillowPricesTable(client);

  if (people.length > 0) {
    console.log('\nFetching property data from events...');
    // Batch event fetches to avoid FUB rate limits
    // Backfill (large sets): 3 concurrent, 1s between batches (~180 req/min)
    // Daily sync (small sets): 10 concurrent, 200ms between batches
    const isBackfill = people.length > 100;
    const BATCH = isBackfill ? 3 : 10;
    const DELAY = isBackfill ? 1000 : 200;
    const leads = [];
    for (let i = 0; i < people.length; i += BATCH) {
      const batch = people.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(p => processLead(p, apiKey)));
      leads.push(...results);
      if (i + BATCH < people.length) await new Promise(r => setTimeout(r, DELAY));
      if (i > 0 && Math.round(i / people.length * 20) > Math.round((i - BATCH) / people.length * 20)) {
        const pct = Math.min(100, Math.round((i + BATCH) / people.length * 100));
        console.log(`  ${pct}% (${Math.min(i + BATCH, people.length)}/${people.length})`);
      }
    }
    const withAddress = leads.filter(l => l.address).length;
    const withBeds = leads.filter(l => l.beds !== null).length;
    console.log(`  ${withAddress}/${leads.length} have address | ${withBeds}/${leads.length} have beds`);
    console.log('\nUpserting to database...');
    await upsertLeads(client, leads);
  } else {
    console.log('No new leads — regenerating data.json from existing DB records');
  }

  if (!process.env.BACKFILL_DAYS) {
    console.log('\nEnriching null-address leads...');
    await enrichNullAddressLeads(client, apiKey);
  }

  const rapidApiKey = process.env.RAPIDAPI_KEY;
  const serperApiKey = process.env.SERPER_API_KEY;
  if (rapidApiKey && serperApiKey) {
    console.log('\nEnriching Zillow prices...');
    await enrichZillowPrices(client, rapidApiKey, serperApiKey);
  } else {
    const missing = ['RAPIDAPI_KEY', 'SERPER_API_KEY'].filter(k => !process.env[k]);
    console.log(`\nZillow price enrichment skipped (missing: ${missing.join(', ')})`);
  }

  console.log('\nFetching YGL inventory...');
  const yglApiKey = process.env.YGL_API_KEY;
  const yglListings = yglApiKey ? await fetchYGLListings(yglApiKey) : [];
  if (!yglApiKey) console.log('  YGL_API_KEY not set — skipping');

  console.log('\nGenerating data.json...');
  await generateDataJson(client, yglListings);
  await client.end();
  console.log('\nDone!');
}

main().catch(err => { console.error('Sync failed:', err.message); process.exit(1); });
