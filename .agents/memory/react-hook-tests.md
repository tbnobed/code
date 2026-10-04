---
name: React hook tests
description: Avoid scheduler hangs when bundling React hook tests for Node.
---
Keep React and react-test-renderer external when bundling hook tests.

**Why:** Bundling React's development test runtime caused passing tests to hang instead of exiting; its dynamic scheduling imports do not survive bundling reliably. Native package imports exited cleanly.

**How to apply:** Resolve the external packages from the frontend package. Node's --test discovery excludes node_modules even with an explicit test path in this environment; a node:test entrypoint stored there can be run directly with node.