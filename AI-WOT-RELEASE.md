# ai-wot Release Checklist

## Before Release
- [ ] Update version in `package.json`
- [ ] Update `VERSION` constant in `lib/wot.js`
- [ ] Update version in `PROTOCOL.md` header
- [ ] Update `README.md` (version refs, constants table, test count, changelog)
- [ ] Run `npm test` — all tests must pass
- [ ] Commit with message: `v0.X.0: <summary>`

## Publish
- [ ] `git push origin main` (to GitHub)
- [ ] `npm publish` (to npm registry)

## Deploy Website (aiwot.org)
- [ ] Update `bitcoin/wot/index.html`:
  - Add new attestation types to: CSS badges, type multipliers, color maps, graph legend, type labels (2 places), typeCounts, typeOrder, NIP-07 dropdown
  - Add changelog entry
  - Remove/update any outdated references
- [ ] Deploy: `curl -sk --ftp-ssl -u "$FTP_USER:$FTP_PASS" -T bitcoin/wot/index.html ftp://162.211.81.45/public_html/index.html`
- [ ] Verify: `curl -sk https://aiwot.org/ | grep "v0.X.0"`

## Post-Release
- [ ] Update `MEMORY.md` with new version info
- [ ] Update `memory/YYYY-MM-DD.md` daily log
- [ ] Consider announcing on: Nostr, Clawstr, Colony, Stacker News

## Notes
- npm tokens may need renewal periodically (check `npm whoami`)
- aiwot.org is a single-file static site — FTP deploy, no build step
- The site has type references in ~10 places — search for existing types when adding new ones
