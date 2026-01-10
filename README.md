# @eldrforge/commands-publish

Publishing workflow commands for kodrdriv - development, publish, and release.

## Installation

```bash
npm install @eldrforge/commands-publish
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
import { development, publish, release } from '@eldrforge/commands-publish';

// Execute development command
await development(config);

// Execute publish command
await publish(config);

// Execute release command
await release(config);
```

## Dependencies

- `@eldrforge/core` - Core utilities and types
- `@eldrforge/commands-git` - Git workflow commands
- `@eldrforge/git-tools` - Git operations
- `@eldrforge/github-tools` - GitHub API interactions
- `@eldrforge/ai-service` - AI-powered content generation

## License

Apache-2.0

