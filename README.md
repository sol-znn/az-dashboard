# az-dashboard

sol's Accelerator-Z projects, live from Zenon mainnet, with voting through the
Syrius extension.

Live: <https://az.zenon.foo/>

```console
python -m http.server 8147   # then open http://localhost:8147
```

The page reads the chain every 10 seconds while its tab is visible.

Any address can vote. The contract counts only a Pillar's owner or producer and
refuses the rest on receive, but the vote block is still confirmed on chain. The
page lists those as proxy votes and says they are not counted.

Each project's status, links and changelog are in `projects.json`, keyed by project
id. Everything else is read from the chain. Pushing to `main` publishes the page
(`.github/workflows/pages.yml`).
