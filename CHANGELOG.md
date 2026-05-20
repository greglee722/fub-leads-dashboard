# Changelog

## v0.1.0 — 2026-05-20

- Initial build: FUB → Postgres → data.json → GitHub Pages dashboard
- Mon–Fri cron via GitHub Actions (12:00 UTC = 7am EST / 8am EDT)
- Monday pulls Fri–Sun; Tue–Fri pulls yesterday
- ZIP → neighborhood mapping (Boston metro, same table as active-ads-combine)
- Phase 1 diagnostic: logs raw FUB API fields to determine if beds/price come through
- Lead cards with Zillow URL (if available) or Google search fallback
- Top-3 daily ad recommendations based on lead volume
- Heat table: neighborhood × beds volume grid
