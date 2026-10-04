---
name: DGX web search
description: Engine availability and relevance must be validated on the DGX itself.
---

Verify search relevance using a multiword query with a known official source,
not just a successful JSON response.

**Why:** On the DGX, Google/Brave/DuckDuckGo blocked requests, while Bing returned
irrelevant first-word results despite HTTP 200. Yahoo returned the actual official
model page. Engine behavior can change, so these observations are not permanent guarantees.

**How to apply:** Check upstream errors and result relevance when deploying or
debugging search. Keep the service private; disclose empty or partial results
rather than fabricating citations. Queries go to public engines even though
the search service runs locally.