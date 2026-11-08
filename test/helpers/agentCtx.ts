/** A user's world for agent tests: connected accounts, audience lists, no usage yet. */
import type { Context } from "../../server/agent/policy.ts";

export function makeCtx(over: Partial<Context> = {}): Context {
  return {
    connections: [
      { id: "x1", kind: "social", platform: "x", label: "Studio on X" },
      { id: "x2", kind: "social", platform: "x", label: "Second X account" },
      { id: "ig", kind: "social", platform: "instagram", label: "Studio on Instagram" },
      { id: "host", kind: "hosting", label: "Website hosting" },
      { id: "mail", kind: "email", label: "Newsletter" },
      { id: "sms", kind: "sms", label: "Texts" },
      { id: "ads", kind: "ads", label: "Ads account" },
      { id: "reg", kind: "registrar", label: "Domain registrar" },
    ],
    lists: [
      { id: "news", kind: "email", source: "opt_in", size: 100, consentRecords: 100 },
      { id: "bought", kind: "email", source: "purchased", size: 5000, consentRecords: 0 },
      { id: "texters", kind: "sms", source: "opt_in", size: 50, consentRecords: 50 },
      { id: "partial", kind: "sms", source: "opt_in", size: 50, consentRecords: 49 },
    ],
    recentPosts: [],
    usageToday: {},
    spendCapCents: 0,
    spentThisMonthCents: 0,
    siteScans: {},
    siteDigests: {},
    ...over,
  };
}

export const post = (over: Record<string, unknown> = {}) => ({
  connectionId: "x1", text: "Beginner pottery class this Saturday at 10am. All materials included.",
  link: "https://example.com/class", sponsored: false, mediaRefs: [] as string[], ...over,
});
