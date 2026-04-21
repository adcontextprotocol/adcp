import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture what the Slack client is asked to send.
const sendChannelMessage = vi.fn();
const sendDirectMessage = vi.fn();
const openGroupDM = vi.fn();

vi.mock("../../src/slack/client.js", () => ({
  sendChannelMessage,
  sendDirectMessage,
  openGroupDM,
}));

// Two admins with Slack mappings — takes us down the group-DM path.
const query = vi.fn();
vi.mock("../../src/db/client.js", () => ({
  query,
}));

beforeEach(() => {
  vi.clearAllMocks();
  sendChannelMessage.mockResolvedValue({ ok: true });
  sendDirectMessage.mockResolvedValue({ ok: true });
  openGroupDM.mockResolvedValue({ channelId: "G_TEST" });

  // Mock query() responses for sendToOrgAdmins → getOrCreateOrgAdminGroupDM
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM slack_user_mappings")) {
      return { rows: [{ slack_user_id: "U1" }, { slack_user_id: "U2" }] };
    }
    if (sql.includes("FROM org_admin_group_dms")) {
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO org_admin_group_dms")) {
      return {
        rows: [
          {
            id: "rec",
            workos_organization_id: "org_acme",
            slack_channel_id: "G_TEST",
            admin_slack_user_ids: ["U1", "U2"],
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      };
    }
    return { rows: [] };
  });
});

describe("notifySubscriptionThankYou — listing disclosure", () => {
  it("omits the listing block when no listing is provided", async () => {
    const { notifySubscriptionThankYou } = await import("../../src/slack/org-group-dm.js");

    await notifySubscriptionThankYou({
      orgId: "org_acme",
      orgName: "Acme Corp",
      adminEmails: ["a@acme.com", "b@acme.com"],
    });

    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
    const message = sendChannelMessage.mock.calls[0][1];
    const rendered = JSON.stringify(message);
    expect(rendered).not.toContain("listing went live");
    expect(rendered).not.toContain("make it private");
    // Still has the welcome header and team CTA
    expect(rendered).toContain("Welcome to AgenticAdvertising.org!");
    expect(rendered).toContain("Manage Team");
  });

  it("adds a listing block with view / edit / make-private links when created", async () => {
    const { notifySubscriptionThankYou } = await import("../../src/slack/org-group-dm.js");

    await notifySubscriptionThankYou({
      orgId: "org_acme",
      orgName: "Acme Corp",
      adminEmails: ["a@acme.com", "b@acme.com"],
      listing: { slug: "acme-corp", action: "created" },
    });

    const message = sendChannelMessage.mock.calls[0][1];
    const rendered = JSON.stringify(message);
    expect(rendered).toContain("listing went live");
    // Discloses *why* it went live — closes the consent loop the issue asked for
    expect(rendered).toContain("We created it when your membership activated");
    // All three links present
    expect(rendered).toContain("/members/acme-corp");
    expect(rendered).toContain("/member-profile?org=org_acme");
    expect(rendered).toContain("#field-is-public");
  });

  it("omits the listing block for a noop (profile already public)", async () => {
    // Contract with the webhook handler: on action === 'noop' the handler
    // passes no `listing` arg. This pins the rendered-message invariant.
    const { notifySubscriptionThankYou } = await import("../../src/slack/org-group-dm.js");

    await notifySubscriptionThankYou({
      orgId: "org_acme",
      orgName: "Acme Corp",
      adminEmails: ["a@acme.com", "b@acme.com"],
      // no listing
    });

    const rendered = JSON.stringify(sendChannelMessage.mock.calls[0][1]);
    expect(rendered).not.toContain("listing went live");
    expect(rendered).not.toContain("make it private");
  });

  it("uses 'published' wording for an existing draft that was flipped public", async () => {
    const { notifySubscriptionThankYou } = await import("../../src/slack/org-group-dm.js");

    await notifySubscriptionThankYou({
      orgId: "org_acme",
      orgName: "Acme Corp",
      adminEmails: ["a@acme.com", "b@acme.com"],
      listing: { slug: "acme-corp", action: "published" },
    });

    const rendered = JSON.stringify(sendChannelMessage.mock.calls[0][1]);
    expect(rendered).toContain("we published it when your membership activated");
    // Should NOT lie about having "created" the listing
    expect(rendered).not.toContain("We created it when your membership activated");
  });

  it("escapes slugs with Slack-sensitive characters in the display text", async () => {
    const { notifySubscriptionThankYou } = await import("../../src/slack/org-group-dm.js");

    await notifySubscriptionThankYou({
      orgId: "org_x",
      orgName: "Evil & Co",
      adminEmails: ["a@x.com", "b@x.com"],
      listing: { slug: "a<b>c", action: "created" },
    });

    const rendered = JSON.stringify(sendChannelMessage.mock.calls[0][1]);
    // The display label must not contain raw < or > (link-injection risk in mrkdwn)
    expect(rendered).toContain("a&lt;b&gt;c");
  });
});
