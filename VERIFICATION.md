# Verifying the Poof API

This repository's releases are the API: the server behind `https://api.usepoof.chat`, which creates quant-rooms, relays connection details between browsers (signaling) and holds the 4-word-phrase mailboxes. It never sees keys or message content; those stay in the browser. This page explains how to check which code a release is, and what that does and doesn't prove.

Below, `RUN_ID` is the number of a run of the Deploy workflow on GitHub, and `COMMIT` is the commit it deployed.

## How a release is made

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on GitHub on every push to `main` (or when someone with write access starts it):

1. The tests run ([`ci.yml`](.github/workflows/ci.yml)), including a check that bundling the API twice gives identical bytes.
2. The API is bundled, and `worker-checksums.sha256` is written for the bundle.
3. GitHub signs the checksum and the bundle with a [build provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations) that ties them to the commit and the workflow run.
4. Exactly that bundle is deployed (uploaded without rebundling, so the attested bytes are what goes live), with the commit baked in.
5. The workflow checks that the live API reports that commit.

The files from step 3 are attached to the run as the artifact `release` for 90 days.

## 1. Which commit is live

```bash
curl -s https://api.usepoof.chat/api/health
# {"ok":true,"version":"1","commit":"<COMMIT>"}
```

A deployment that reports `"commit":"dev"` was not made by the Deploy workflow.

## 2. Check the release

```bash
gh run download RUN_ID --repo usepoofchat/poof-app -n release -D release
gh attestation verify release/worker-checksums.sha256 --repo usepoofchat/poof-app
gh attestation verify release/worker-bundle/index.js --repo usepoofchat/poof-app
```

## 3. Rebuild it yourself

The bundle is reproducible, so you can compare the attested checksum with your own build of the same commit:

```bash
git clone https://github.com/usepoofchat/poof-app && cd poof-app && git checkout COMMIT
pnpm install --frozen-lockfile
pnpm --filter @poof/worker run bundle ../out
sha256sum out/index.js        # compare with release/worker-checksums.sha256
```

Use Node 22 and pnpm 10, as CI does.

## What this proves, and what it doesn't

**Proves:** the attested bundle was built by GitHub Actions, from that public commit, by the repository's own workflow, and that is what the workflow uploaded to our hosting provider.

**Doesn't prove:**

- **What runs on the server right now.** Nobody outside our hosting provider can download the code that's running. `/api/health` reports a commit, but a server could report anything, and someone with access to the hosting account could deploy something else. The API never sees keys or message content, so this matters for metadata (who connects when), not for what you say.
- **Which code your browser runs.** The web app at `https://usepoof.chat` is hosted separately and is not covered by these releases.
- **Anything about your device**, your browser or its extensions.
