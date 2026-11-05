# Self-hosted CI runner

CI for this repository runs on a self-hosted runner labelled
`self-hosted, dad, macOS`. The single `checks` job (Node 24 + Playwright) targets
that runner so a private repo's CI does not consume GitHub-hosted Actions minutes.

## Runner prerequisites

- **Node.js 24** is installed per-run by `actions/setup-node`.
- The job installs its own Playwright Chromium (no `--with-deps`, since that runs
  `apt-get` and the host is macOS).
- No Docker is required.

## Registration

`CoachCoe` is a GitHub user account, so the runner is registered per-repository
(no org-level runner groups). The host is an Apple Silicon Mac; `macOS`, `ARM64`
and `self-hosted` are auto-added from what the host reports, so only the `dad`
custom label is set at registration. (An earlier `linux` label was a misnomer for
a macOS host and has been removed — do not re-add it.) Register from this repo's
**Settings → Actions → Runners → New self-hosted runner** page:

```sh
./config.sh --url https://github.com/CoachCoe/DAD-Quality \
  --token <TOKEN_FROM_THE_RUNNERS_PAGE> \
  --labels dad --name dad-atm-1
./svc.sh install && ./svc.sh start
```

Do **not** merge this branch until the runner shows **online** on that page, or
CI will hang waiting for a matching runner.
