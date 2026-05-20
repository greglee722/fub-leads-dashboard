'use strict';
const https = require('https');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const VERSION = '0.1.0';
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
function getDateRange() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

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

async function upsertLeads(client, leads) {
  for (const lead of leads) {
    if (!lead.lead_date) continue;
    await client.query(`
      INSERT INTO fub_leads
        (fub_id, agent_name, lead_date, address, zip, neighborhood, beds, price, zillow_url, lead_name, source, stage)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (fub_id) DO UPDATE SET
        agent_name   = EXCLUDED.agent_name,
        lead_date    = EXCLUDED.lead_date,
        address      = EXCLUDED.address,
        zip          = EXCLUDED.zip,
        neighborhood = EXCLUDED.neighborhood,
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

async function generateDataJson(client) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 180);

  const { rows } = await client.query(`
    SELECT id, fub_id, agent_name, lead_date, address, zip, neighborhood,
           beds, price, zillow_url, lead_name, source, stage
    FROM fub_leads
    WHERE lead_date >= $1
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

  fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ generated: new Date().toISOString(), version: VERSION, agents, neighborhoods, leads }, null, 2));
  console.log(`  Wrote ${leads.length} leads → public/data.json`);
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

  if (people.length > 0) {
    console.log('\nFetching property data from events...');
    const leads = await Promise.all(people.map(p => processLead(p, apiKey)));
    const withAddress = leads.filter(l => l.address).length;
    const withBeds = leads.filter(l => l.beds !== null).length;
    console.log(`  ${withAddress}/${leads.length} have address | ${withBeds}/${leads.length} have beds`);
    console.log('\nUpserting to database...');
    await upsertLeads(client, leads);
  } else {
    console.log('No new leads — regenerating data.json from existing DB records');
  }

  console.log('\nGenerating data.json...');
  await generateDataJson(client);
  await client.end();
  console.log('\nDone!');
}

main().catch(err => { console.error('Sync failed:', err.message); process.exit(1); });
