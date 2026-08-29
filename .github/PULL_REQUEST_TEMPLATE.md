## Summary

<!-- What changed, and why? Keep this focused on observable behavior or a documented contract. -->

## Validation

- [ ] `npm run check`
- [ ] `npm run check:routes` (when routes or route metadata changed)
- [ ] `npm run evidence:check` (when media or release metadata changed)
- [ ] `npm run deploy:check` (when deployment, config, or release metadata changed)
- [ ] `npm run bootstrap` (when bootstrap, health, or version contracts changed)
- [ ] Additional validation is listed below.

## Release truthfulness

- [ ] Documentation distinguishes implemented behavior from roadmap/design work.
- [ ] No unsupported PostgreSQL, Redis, hosted-authentication, horizontal-scaling, or operator-claim-completion claims were added.
- [ ] No fabricated screenshots, recordings, placeholder assets, or synthetic engagement were added.

## Security and data

- [ ] No credentials, private keys, operator tokens, `.env` files, logs, or `.commons/data.json` are included.
- [ ] Public/private projection and untrusted-social-content boundaries were reviewed for API changes.
- [ ] Mutation idempotency and rate-limit behavior were preserved or documented.

## Notes

<!-- Known limitations, migration notes, screenshots/evidence status, or follow-up work. -->
