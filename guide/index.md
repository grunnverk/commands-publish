# @eldrforge/commands-publish - Agentic Guide

## Purpose

Publishing workflow commands for kodrdriv. Provides:
- Development version bumping
- NPM publish workflow with PR creation
- GitHub release creation

## Quick Reference

For AI agents working with this package:
- Development command: Bumps version with -dev suffix
- Publish command: Creates PR, publishes to npm
- Release command: Creates GitHub release

## Key Exports

```typescript
// Publishing commands
import { development, publish, release } from '@eldrforge/commands-publish';

// Execute commands
await development(config);
await publish(config);
await release(config);
```

## Dependencies

- @eldrforge/core - Core utilities
- @eldrforge/commands-git - Git workflow commands
- @eldrforge/git-tools - Git operations
- @eldrforge/github-tools - GitHub API
- @eldrforge/ai-service - AI content generation

## Command Workflows

### development

1. Check current branch
2. Bump version with -dev suffix
3. Create development branch

### publish

1. Run precommit checks
2. Bump version
3. Create PR
4. Publish to npm

### release

1. Generate changelog
2. Create GitHub release
3. Tag version

