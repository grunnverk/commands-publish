# @grunnverk/commands-publish

Publishing workflow commands for kodrdriv - development, publish, and release.

## Installation

```bash
npm install @grunnverk/commands-publish
```

## Commands

### development

Prepare package for development (bump version with -dev suffix).

```bash
kodrdriv development
```

### publish

Publish package to npm with PR workflow.

```bash
kodrdriv publish --title "Release v1.0.0"
```

### release

Create a GitHub release with changelog.

```bash
kodrdriv release
```

## Usage

```typescript
import { development, publish, release } from '@grunnverk/commands-publish';

// Execute development command
await development(config);

// Execute publish command
await publish(config);

// Execute release command
await release(config);
```

## Lockfile Policy

`kodrdriv publish` enforces `publish.lockfilePolicy` as the canonical lockfile rule.

- `ignore` (default): `package-lock.json` must not be tracked and must be ignored.
- `commit`: `package-lock.json` must exist, be tracked, and not be ignored.

Example config:

```json
{
  "publish": {
    "lockfilePolicy": "ignore"
  }
}
```

### Migration

Move repository to `ignore` policy:

```bash
echo "package-lock.json" >> .gitignore
git rm --cached package-lock.json
git commit -m "chore: enforce lockfile ignore policy"
```

Move repository to `commit` policy:

```bash
npm install --package-lock-only --no-audit --no-fund
git add package-lock.json
git commit -m "chore: track lockfile"
```

## Dependencies

- `@grunnverk/core` - Core utilities and types
- `@grunnverk/commands-git` - Git workflow commands
- `@grunnverk/git-tools` - Git operations
- `@grunnverk/github-tools` - GitHub API interactions
- `@grunnverk/ai-service` - AI-powered content generation

## License

Apache-2.0


<!-- Build: 2026-01-15 15:59:12 UTC -->
