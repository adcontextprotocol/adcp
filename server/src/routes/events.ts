/**
 * Events routes module
 *
 * This module contains both admin and public event API routes.
 * - Admin routes: Create, update, delete events; manage registrations
 * - Public routes: List events, get event details, register for events
 */

import { Router, type Request, type Response } from "express";
import { parse as parseCsvLib } from "csv-parse/sync";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import { eventsDb } from "../db/events-db.js";
import { OrganizationDatabase } from "../db/organization-db.js";
import {
  createCheckoutSession,
  createStripeCustomer,
  createEventSponsorshipProduct,
  type CheckoutSessionData,
} from "../billing/stripe-client.js";
import type {
  CreateEventInput,
  UpdateEventInput,
  CreateEventRegistrationInput,
  CreateEventSponsorshipInput,
  EventStatus,
  EventType,
  EventFormat,
  RegistrationStatus,
} from "../types.js";

/**
 * Luma CSV row structure
 */
interface LumaCsvRow {
  api_id: string;
  name: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string;
  created_at: string;
  approval_status: string;
  checked_in_at: string;
  custom_source: string;
  qr_code_url: string;
  amount: string;
  amount_tax: string;
  amount_discount: string;
  currency: string;
  coupon_code: string;
  eth_address: string;
  solana_address: string;
  survey_response_rating: string;
  survey_response_feedback: string;
  ticket_type_id: string;
  ticket_name: string;
}

// Max CSV size: 5MB
const MAX_CSV_SIZE = 5 * 1024 * 1024;

/**
 * Parse CSV string into rows using proper CSV library
 */
function parseCsv(csvContent: string): LumaCsvRow[] {
  const records = parseCsvLib(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  return records as LumaCsvRow[];
}

/**
 * Parse date string, returning undefined for invalid dates
 */
function parseDate(dateStr: string | undefined): Date | undefined {
  if (!dateStr) return undefined;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return undefined;
  }
  return date;
}

/**
 * Map Luma approval_status to our registration_status
 */
function mapLumaStatus(lumaStatus: string): RegistrationStatus {
  switch (lumaStatus.toLowerCase()) {
    case 'approved':
      return 'registered';
    case 'pending_approval':
      return 'registered'; // Treat pending as registered for historical imports
    case 'waitlist':
      return 'waitlisted';
    case 'declined':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'registered';
  }
}

const orgDb = new OrganizationDatabase();

const logger = createLogger("events-routes");

/**
 * Create events routes
 * Returns separate routers for:
 * - pageRouter: Page routes (/admin/events, /events, /events/:slug)
 * - adminApiRouter: Admin API routes (/api/admin/events/*)
 * - publicApiRouter: Public API routes (/api/events/*)
 */
export function createEventsRouter(): {
  pageRouter: Router;
  adminApiRouter: Router;
  publicApiRouter: Router;
} {
  const pageRouter = Router();
  const adminApiRouter = Router();
  const publicApiRouter = Router();

  // =========================================================================
  // ADMIN PAGE ROUTES (mounted at /admin)
  // =========================================================================

  // Admin events management page
  pageRouter.get("/events", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "admin-events.html").catch((err) => {
      logger.error({ err }, "Error serving admin events page");
      res.status(500).send("Internal server error");
    });
  });

  // =========================================================================
  // PUBLIC PAGE ROUTES (mounted at /)
  // =========================================================================

  // Public events listing page
  pageRouter.get("/events", (req, res, next) => {
    // Skip if this is the admin route (handled above)
    if (req.baseUrl === "/admin") {
      return next();
    }
    serveHtmlWithConfig(req, res, "events.html").catch((err) => {
      logger.error({ err }, "Error serving events page");
      res.status(500).send("Internal server error");
    });
  });

  // Public event detail page
  pageRouter.get("/events/:slug", (req, res) => {
    serveHtmlWithConfig(req, res, "event-detail.html").catch((err) => {
      logger.error({ err }, "Error serving event detail page");
      res.status(500).send("Internal server error");
    });
  });

  // =========================================================================
  // ADMIN API ROUTES (mounted at /api/admin/events)
  // =========================================================================

  // GET /api/admin/events - List all events (including drafts)
  adminApiRouter.get("/", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const status = req.query.status as EventStatus | undefined;
      const event_type = req.query.event_type as EventType | undefined;
      const event_format = req.query.event_format as EventFormat | undefined;
      const search = req.query.search as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

      const events = await eventsDb.listEvents({
        status,
        event_type,
        event_format,
        search,
        limit,
        offset,
      });

      res.json({ events });
    } catch (error) {
      logger.error({ err: error }, "Error listing events");
      res.status(500).json({
        error: "Failed to list events",
        message: "An unexpected error occurred",
      });
    }
  });

  // POST /api/admin/events - Create a new event
  adminApiRouter.post("/", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const input: CreateEventInput = {
        ...req.body,
        created_by_user_id: user.id,
      };

      // Validate required fields
      if (!input.slug || !input.title || !input.start_time) {
        return res.status(400).json({
          error: "Missing required fields",
          message: "slug, title, and start_time are required",
        });
      }

      // Check slug availability
      const slugAvailable = await eventsDb.isSlugAvailable(input.slug);
      if (!slugAvailable) {
        return res.status(400).json({
          error: "Slug already in use",
          message: "Please choose a different slug",
        });
      }

      // Validate sponsorship tiers if provided
      if (input.sponsorship_tiers && input.sponsorship_tiers.length > 0) {
        for (const tier of input.sponsorship_tiers) {
          if (!tier.tier_id || typeof tier.tier_id !== "string" || tier.tier_id.length > 100) {
            return res.status(400).json({
              error: "Invalid tier_id",
              message: "Each tier must have a valid tier_id (string, max 100 chars)",
            });
          }
          if (typeof tier.price_cents !== "number" || tier.price_cents < 0 || tier.price_cents > 100000000) {
            return res.status(400).json({
              error: "Invalid price_cents",
              message: "Tier price must be between 0 and $1,000,000",
            });
          }
          if (tier.max_sponsors !== undefined && (tier.max_sponsors < 0 || tier.max_sponsors > 1000)) {
            return res.status(400).json({
              error: "Invalid max_sponsors",
              message: "max_sponsors must be between 0 and 1000",
            });
          }
        }
      }

      // Auto-create Stripe product if sponsorship tiers are defined
      if (input.sponsorship_enabled && input.sponsorship_tiers && input.sponsorship_tiers.length > 0) {
        try {
          // Use the highest tier price as default, or first tier if not specified
          const highestTier = input.sponsorship_tiers.reduce((max, tier) =>
            (tier.price_cents || 0) > (max.price_cents || 0) ? tier : max
          , input.sponsorship_tiers[0]);

          const stripeProductId = await createEventSponsorshipProduct({
            eventId: input.slug, // Use slug temporarily since we don't have ID yet
            eventSlug: input.slug,
            eventTitle: input.title,
            defaultAmountCents: highestTier.price_cents,
          });

          if (stripeProductId) {
            input.stripe_product_id = stripeProductId;
            logger.info({ stripeProductId, slug: input.slug }, "Auto-created Stripe product for event sponsorship");
          }
        } catch (stripeError) {
          logger.warn({ err: stripeError, slug: input.slug }, "Failed to auto-create Stripe product for sponsorship");
          // Continue without Stripe product - admin can manually set up later
        }
      }

      const event = await eventsDb.createEvent(input);

      // Update the Stripe product metadata with the real event ID
      if (event.stripe_product_id) {
        try {
          const { stripe } = await import("../billing/stripe-client.js");
          if (stripe) {
            await stripe.products.update(event.stripe_product_id, {
              metadata: {
                event_id: event.id,
                managed_by: "event",
              },
            });
          }
        } catch (updateError) {
          logger.warn({ err: updateError }, "Failed to update Stripe product with event ID");
        }
      }

      logger.info({ eventId: event.id, slug: event.slug, userId: user.id }, "Event created");

      res.status(201).json({ event });
    } catch (error) {
      logger.error({ err: error }, "Error creating event");
      res.status(500).json({
        error: "Failed to create event",
        message: "An unexpected error occurred",
      });
    }
  });

  // GET /api/admin/events/:id - Get event by ID
  adminApiRouter.get("/:id", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const event = await eventsDb.getEventById(id);
      if (!event) {
        return res.status(404).json({
          error: "Event not found",
          message: "No event found with that ID",
        });
      }

      // Also get registration and sponsorship counts
      const registrations = await eventsDb.getEventRegistrations(id);
      const sponsorships = await eventsDb.getEventSponsorships(id);

      res.json({
        event,
        registration_count: registrations.length,
        attendance_count: registrations.filter((r) => r.attended).length,
        sponsorship_count: sponsorships.filter((s) => s.payment_status === "paid").length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error getting event");
      res.status(500).json({
        error: "Failed to get event",
        message: "An unexpected error occurred",
      });
    }
  });

  // PUT /api/admin/events/:id - Update an event
  adminApiRouter.put("/:id", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updates: UpdateEventInput = req.body;

      // Get current event to check for sponsorship changes
      const currentEvent = await eventsDb.getEventById(id);
      if (!currentEvent) {
        return res.status(404).json({
          error: "Event not found",
          message: "No event found with that ID",
        });
      }

      // Validate sponsorship tiers if provided
      if (updates.sponsorship_tiers && updates.sponsorship_tiers.length > 0) {
        for (const tier of updates.sponsorship_tiers) {
          if (!tier.tier_id || typeof tier.tier_id !== "string" || tier.tier_id.length > 100) {
            return res.status(400).json({
              error: "Invalid tier_id",
              message: "Each tier must have a valid tier_id (string, max 100 chars)",
            });
          }
          if (typeof tier.price_cents !== "number" || tier.price_cents < 0 || tier.price_cents > 100000000) {
            return res.status(400).json({
              error: "Invalid price_cents",
              message: "Tier price must be between 0 and $1,000,000",
            });
          }
          if (tier.max_sponsors !== undefined && (tier.max_sponsors < 0 || tier.max_sponsors > 1000)) {
            return res.status(400).json({
              error: "Invalid max_sponsors",
              message: "max_sponsors must be between 0 and 1000",
            });
          }
        }
      }

      // Auto-create Stripe product if sponsorship is being enabled with tiers
      // and no product exists yet
      const sponsorshipEnabled = updates.sponsorship_enabled ?? currentEvent.sponsorship_enabled;
      const sponsorshipTiers = updates.sponsorship_tiers ?? currentEvent.sponsorship_tiers;
      const hasStripeProduct = updates.stripe_product_id ?? currentEvent.stripe_product_id;

      if (sponsorshipEnabled && sponsorshipTiers && sponsorshipTiers.length > 0 && !hasStripeProduct) {
        try {
          // Use the highest tier price as default
          const highestTier = sponsorshipTiers.reduce((max, tier) =>
            (tier.price_cents || 0) > (max.price_cents || 0) ? tier : max
          , sponsorshipTiers[0]);

          const eventTitle = updates.title ?? currentEvent.title;
          const eventSlug = currentEvent.slug; // slug is not updatable

          const stripeProductId = await createEventSponsorshipProduct({
            eventId: id,
            eventSlug,
            eventTitle,
            defaultAmountCents: highestTier.price_cents,
          });

          if (stripeProductId) {
            updates.stripe_product_id = stripeProductId;
            logger.info({ stripeProductId, eventId: id }, "Auto-created Stripe product for event sponsorship");
          }
        } catch (stripeError) {
          logger.warn({ err: stripeError, eventId: id }, "Failed to auto-create Stripe product for sponsorship");
          // Continue without Stripe product - admin can manually set up later
        }
      }

      const event = await eventsDb.updateEvent(id, updates);
      if (!event) {
        return res.status(404).json({
          error: "Event not found",
          message: "No event found with that ID",
        });
      }

      logger.info({ eventId: id }, "Event updated");

      res.json({ event });
    } catch (error) {
      logger.error({ err: error }, "Error updating event");
      res.status(500).json({
        error: "Failed to update event",
        message: "An unexpected error occurred",
      });
    }
  });

  // POST /api/admin/events/:id/publish - Publish an event
  adminApiRouter.post("/:id/publish", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const event = await eventsDb.publishEvent(id);
      if (!event) {
        return res.status(404).json({
          error: "Event not found",
          message: "No event found with that ID",
        });
      }

      logger.info({ eventId: id }, "Event published");

      res.json({ event });
    } catch (error) {
      logger.error({ err: error }, "Error publishing event");
      res.status(500).json({
        error: "Failed to publish event",
        message: "An unexpected error occurred",
      });
    }
  });

  // DELETE /api/admin/events/:id - Delete an event
  adminApiRouter.delete("/:id", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const deleted = await eventsDb.deleteEvent(id);
      if (!deleted) {
        return res.status(404).json({
          error: "Event not found",
          message: "No event found with that ID",
        });
      }

      logger.info({ eventId: id }, "Event deleted");

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, "Error deleting event");
      res.status(500).json({
        error: "Failed to delete event",
        message: "An unexpected error occurred",
      });
    }
  });

  // GET /api/admin/events/:id/registrations - Get registrations for an event
  adminApiRouter.get(
    "/:id/registrations",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;

        const registrations = await eventsDb.getEventRegistrations(id);

        res.json({ registrations });
      } catch (error) {
        logger.error({ err: error }, "Error getting registrations");
        res.status(500).json({
          error: "Failed to get registrations",
          message: "An unexpected error occurred",
        });
      }
    }
  );

  // POST /api/admin/events/:id/registrations - Add a registration (admin)
  adminApiRouter.post(
    "/:id/registrations",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const input: CreateEventRegistrationInput = {
          ...req.body,
          event_id: id,
          registration_source: "admin",
        };

        const registration = await eventsDb.createRegistration(input);

        logger.info({ registrationId: registration.id, eventId: id }, "Registration added by admin");

        res.status(201).json({ registration });
      } catch (error) {
        logger.error({ err: error }, "Error creating registration");
        res.status(500).json({
          error: "Failed to create registration",
          message: "An unexpected error occurred",
        });
      }
    }
  );

  // POST /api/admin/events/:eventId/registrations/:regId/check-in - Check in attendee
  adminApiRouter.post(
    "/:eventId/registrations/:regId/check-in",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const { regId } = req.params;

        const registration = await eventsDb.checkInAttendee(regId);
        if (!registration) {
          return res.status(404).json({
            error: "Registration not found",
            message: "No registration found with that ID",
          });
        }

        logger.info({ registrationId: regId }, "Attendee checked in");

        res.json({ registration });
      } catch (error) {
        logger.error({ err: error }, "Error checking in attendee");
        res.status(500).json({
          error: "Failed to check in attendee",
          message: "An unexpected error occurred",
        });
      }
    }
  );

  // GET /api/admin/events/:id/sponsorships - Get sponsorships for an event
  adminApiRouter.get(
    "/:id/sponsorships",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;

        const sponsorships = await eventsDb.getEventSponsorships(id);

        res.json({ sponsorships });
      } catch (error) {
        logger.error({ err: error }, "Error getting sponsorships");
        res.status(500).json({
          error: "Failed to get sponsorships",
          message: "An unexpected error occurred",
        });
      }
    }
  );

  // POST /api/admin/events/:id/import-luma - Import registrations from Luma CSV
  adminApiRouter.post(
    "/:id/import-luma",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { csv_content } = req.body;

        if (!csv_content || typeof csv_content !== 'string') {
          return res.status(400).json({
            error: "Missing CSV content",
            message: "Please provide csv_content in the request body",
          });
        }

        // Check CSV size limit
        if (csv_content.length > MAX_CSV_SIZE) {
          return res.status(400).json({
            error: "CSV too large",
            message: `CSV must be smaller than ${MAX_CSV_SIZE / 1024 / 1024}MB`,
          });
        }

        // Verify event exists
        const event = await eventsDb.getEventById(id);
        if (!event) {
          return res.status(404).json({
            error: "Event not found",
            message: "No event found with that ID",
          });
        }

        // Parse CSV
        const rows = parseCsv(csv_content);
        if (rows.length === 0) {
          return res.status(400).json({
            error: "Invalid CSV",
            message: "CSV must have a header row and at least one data row",
          });
        }

        // Get existing registrations by luma_guest_id for deduplication
        const existingRegistrations = await eventsDb.getEventRegistrations(id);
        const existingByLumaId = new Map(
          existingRegistrations
            .filter(r => r.luma_guest_id)
            .map(r => [r.luma_guest_id, r])
        );
        const existingByEmail = new Map(
          existingRegistrations
            .filter(r => r.email)
            .map(r => [r.email!.toLowerCase(), r])
        );

        let created = 0;
        let updated = 0;
        let skipped = 0;
        const errors: string[] = [];

        for (const row of rows) {
          try {
            if (!row.email) {
              skipped++;
              continue;
            }

            const email = row.email.toLowerCase();
            const name = row.name || `${row.first_name || ''} ${row.last_name || ''}`.trim();
            const registrationStatus = mapLumaStatus(row.approval_status);
            const checkedInAt = parseDate(row.checked_in_at);
            const attended = !!checkedInAt;

            // Check for existing registration
            const existingByLuma = existingByLumaId.get(row.api_id);
            const existingByEmailReg = existingByEmail.get(email);
            const existing = existingByLuma || existingByEmailReg;

            if (existing) {
              // Update existing registration with attendance info
              if (attended && !existing.attended) {
                await eventsDb.updateRegistration(existing.id, {
                  attended: true,
                  checked_in_at: checkedInAt,
                  luma_guest_id: row.api_id,
                  registration_status: registrationStatus,
                });
                updated++;
              } else {
                skipped++;
              }
            } else {
              // Create new registration
              const newReg = await eventsDb.createRegistration({
                event_id: id,
                email,
                name: name || undefined,
                registration_status: registrationStatus,
                registration_source: 'import',
                luma_guest_id: row.api_id,
                ticket_type: row.ticket_name || 'general',
                registration_data: {
                  luma_created_at: row.created_at,
                  luma_approval_status: row.approval_status,
                  imported_at: new Date().toISOString(),
                },
              });

              // If they checked in, update attendance using returned registration ID
              if (attended && newReg) {
                await eventsDb.updateRegistration(newReg.id, {
                  attended: true,
                  checked_in_at: checkedInAt,
                });
              }

              created++;
            }
          } catch (rowError) {
            errors.push(`Row ${row.email}: ${rowError instanceof Error ? rowError.message : 'Unknown error'}`);
          }
        }

        logger.info(
          { eventId: id, created, updated, skipped, errors: errors.length },
          "Luma CSV import completed"
        );

        res.json({
          success: true,
          summary: {
            total_rows: rows.length,
            created,
            updated,
            skipped,
            errors: errors.length,
          },
          errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
        });
      } catch (error) {
        logger.error({ err: error }, "Error importing Luma CSV");
        res.status(500).json({
          error: "Failed to import",
          message: "An unexpected error occurred",
        });
      }
    }
  );

  // =========================================================================
  // PUBLIC API ROUTES (mounted at /api/events)
  // =========================================================================

  // GET /api/events - List published upcoming events
  publicApiRouter.get("/", async (req: Request, res: Response) => {
    try {
      const event_type = req.query.event_type as EventType | undefined;
      const event_format = req.query.event_format as EventFormat | undefined;
      const upcoming_only = req.query.upcoming !== "false"; // Default to upcoming only
      const past_only = req.query.past === "true";

      const events = await eventsDb.listEvents({
        status: "published",
        event_type,
        event_format,
        upcoming_only: past_only ? false : upcoming_only,
        past_only,
      });

      res.json({ events });
    } catch (error) {
      logger.error({ err: error }, "Error listing public events");
      res.status(500).json({
        error: "Failed to list events",
        message: "An unexpected error occurred",
      });
    }
  });

  // GET /api/events/upcoming - Get upcoming events with counts
  publicApiRouter.get("/upcoming", async (req: Request, res: Response) => {
    try {
      const events = await eventsDb.getUpcomingEvents();

      res.json({ events });
    } catch (error) {
      logger.error({ err: error }, "Error getting upcoming events");
      res.status(500).json({
        error: "Failed to get upcoming events",
        message: "An unexpected error occurred",
      });
    }
  });

  // GET /api/events/:slug - Get event by slug (public)
  publicApiRouter.get("/:slug", async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;

      const event = await eventsDb.getEventBySlug(slug);
      if (!event || event.status !== "published") {
        return res.status(404).json({
          error: "Event not found",
          message: "No published event found with that slug",
        });
      }

      // Get sponsors for display
      const sponsors = await eventsDb.getEventSponsorsForDisplay(event.id);

      // Get registration count (but not full list)
      const registrations = await eventsDb.getEventRegistrations(event.id);
      const registrationCount = registrations.filter(
        (r) => r.registration_status === "registered"
      ).length;

      res.json({
        event,
        sponsors,
        registration_count: registrationCount,
      });
    } catch (error) {
      logger.error({ err: error }, "Error getting event");
      res.status(500).json({
        error: "Failed to get event",
        message: "An unexpected error occurred",
      });
    }
  });

  // POST /api/events/:slug/register - Register for an event (requires auth)
  publicApiRouter.post("/:slug/register", requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const user = req.user!;

      const event = await eventsDb.getEventBySlug(slug);
      if (!event || event.status !== "published") {
        return res.status(404).json({
          error: "Event not found",
          message: "No published event found with that slug",
        });
      }

      // Check if already registered
      const alreadyRegistered = await eventsDb.isUserRegistered(event.id, user.id);
      if (alreadyRegistered) {
        return res.status(400).json({
          error: "Already registered",
          message: "You are already registered for this event",
        });
      }

      // Check capacity
      if (event.max_attendees) {
        const registrations = await eventsDb.getEventRegistrations(event.id);
        const activeCount = registrations.filter(
          (r) => r.registration_status === "registered"
        ).length;
        if (activeCount >= event.max_attendees) {
          return res.status(400).json({
            error: "Event is full",
            message: "This event has reached capacity",
          });
        }
      }

      const registration = await eventsDb.createRegistration({
        event_id: event.id,
        workos_user_id: user.id,
        email: user.email,
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || undefined,
        registration_source: "direct",
      });

      logger.info(
        { registrationId: registration.id, eventId: event.id, userId: user.id },
        "User registered for event"
      );

      res.status(201).json({ registration });
    } catch (error) {
      logger.error({ err: error }, "Error registering for event");
      res.status(500).json({
        error: "Failed to register",
        message: "An unexpected error occurred",
      });
    }
  });

  // GET /api/events/:slug/my-registration - Get current user's registration
  publicApiRouter.get("/:slug/my-registration", requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const user = req.user!;

      const event = await eventsDb.getEventBySlug(slug);
      if (!event) {
        return res.status(404).json({
          error: "Event not found",
          message: "No event found with that slug",
        });
      }

      const registrations = await eventsDb.getUserRegistrations(user.id);
      const registration = registrations.find((r) => r.event_id === event.id);

      res.json({ registration: registration || null });
    } catch (error) {
      logger.error({ err: error }, "Error getting registration");
      res.status(500).json({
        error: "Failed to get registration",
        message: "An unexpected error occurred",
      });
    }
  });

  // POST /api/events/:slug/cancel-registration - Cancel registration
  publicApiRouter.post(
    "/:slug/cancel-registration",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const { slug } = req.params;
        const user = req.user!;

        const event = await eventsDb.getEventBySlug(slug);
        if (!event) {
          return res.status(404).json({
            error: "Event not found",
            message: "No event found with that slug",
          });
        }

        const registrations = await eventsDb.getUserRegistrations(user.id);
        const registration = registrations.find((r) => r.event_id === event.id);

        if (!registration) {
          return res.status(404).json({
            error: "Registration not found",
            message: "You are not registered for this event",
          });
        }

        const cancelled = await eventsDb.cancelRegistration(registration.id);

        logger.info(
          { registrationId: registration.id, eventId: event.id, userId: user.id },
          "User cancelled registration"
        );

        res.json({ registration: cancelled });
      } catch (error) {
        logger.error({ err: error }, "Error cancelling registration");
        res.status(500).json({
          error: "Failed to cancel registration",
          message: "An unexpected error occurred",
        });
      }
    }
  );

  // =========================================================================
  // SPONSORSHIP CHECKOUT ROUTES
  // =========================================================================

  // GET /api/events/:slug/sponsorship-tiers - Get available sponsorship tiers
  publicApiRouter.get("/:slug/sponsorship-tiers", async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;

      const event = await eventsDb.getEventBySlug(slug);
      if (!event || event.status !== "published") {
        return res.status(404).json({
          error: "Event not found",
          message: "No published event found with that slug",
        });
      }

      if (!event.sponsorship_enabled) {
        return res.status(400).json({
          error: "Sponsorships not available",
          message: "This event does not have sponsorships enabled",
        });
      }

      // Get current sponsor counts per tier
      const sponsorships = await eventsDb.getEventSponsorships(event.id);
      const paidByTier: Record<string, number> = {};
      for (const s of sponsorships) {
        if (s.payment_status === "paid") {
          paidByTier[s.tier_id] = (paidByTier[s.tier_id] || 0) + 1;
        }
      }

      // Add availability info to tiers
      const tiersWithAvailability = event.sponsorship_tiers.map((tier) => ({
        ...tier,
        sponsors_count: paidByTier[tier.tier_id] || 0,
        available: tier.max_sponsors
          ? (paidByTier[tier.tier_id] || 0) < tier.max_sponsors
          : true,
      }));

      res.json({ tiers: tiersWithAvailability });
    } catch (error) {
      logger.error({ err: error }, "Error getting sponsorship tiers");
      res.status(500).json({
        error: "Failed to get sponsorship tiers",
        message: "An unexpected error occurred",
      });
    }
  });

  // POST /api/events/:slug/sponsor - Create sponsorship checkout session (requires auth)
  publicApiRouter.post("/:slug/sponsor", requireAuth, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const { tier_id, org_id } = req.body;
      const user = req.user!;

      if (!tier_id) {
        return res.status(400).json({
          error: "Missing tier_id",
          message: "Please specify which sponsorship tier you want",
        });
      }

      if (!org_id) {
        return res.status(400).json({
          error: "Missing org_id",
          message: "Please specify which organization is sponsoring",
        });
      }

      // Get event
      const event = await eventsDb.getEventBySlug(slug);
      if (!event || event.status !== "published") {
        return res.status(404).json({
          error: "Event not found",
          message: "No published event found with that slug",
        });
      }

      if (!event.sponsorship_enabled) {
        return res.status(400).json({
          error: "Sponsorships not available",
          message: "This event does not have sponsorships enabled",
        });
      }

      // Find the tier
      const tier = event.sponsorship_tiers.find((t) => t.tier_id === tier_id);
      if (!tier) {
        return res.status(400).json({
          error: "Invalid tier",
          message: "The specified sponsorship tier does not exist",
        });
      }

      // Check if tier is available
      if (tier.max_sponsors) {
        const count = await eventsDb.countTierSponsors(event.id, tier_id);
        if (count >= tier.max_sponsors) {
          return res.status(400).json({
            error: "Tier sold out",
            message: "This sponsorship tier is no longer available",
          });
        }
      }

      // Get organization
      const org = await orgDb.getOrganization(org_id);
      if (!org) {
        return res.status(404).json({
          error: "Organization not found",
          message: "The specified organization does not exist",
        });
      }

      // Check if org already has this tier
      const existingSponsorship = await eventsDb.hasSponsorship(event.id, org_id, tier_id);
      if (existingSponsorship) {
        return res.status(400).json({
          error: "Already sponsored",
          message: "Your organization already has this sponsorship tier",
        });
      }

      // Create pending sponsorship record
      const sponsorship = await eventsDb.createSponsorship({
        event_id: event.id,
        organization_id: org_id,
        purchased_by_user_id: user.id,
        tier_id: tier.tier_id,
        tier_name: tier.name,
        amount_cents: tier.price_cents,
        currency: tier.currency || "USD",
      });

      // Ensure Stripe customer exists
      let stripeCustomerId = org.stripe_customer_id;
      if (!stripeCustomerId) {
        stripeCustomerId = await createStripeCustomer({
          email: user.email,
          name: org.name,
          metadata: { workos_organization_id: org_id },
        });
        if (stripeCustomerId) {
          await orgDb.setStripeCustomerId(org_id, stripeCustomerId);
        }
      }

      // Create a one-time price for this sponsorship
      // Note: In production, you might want to create products/prices in Stripe admin
      // and reference them by lookup_key instead of creating prices dynamically
      const host = req.get("host");
      const protocol = req.protocol;
      const baseUrl = `${protocol}://${host}`;

      // For now, we'll use a dynamic price approach
      // The frontend should handle the case where Stripe is not configured
      const checkoutData: CheckoutSessionData = {
        priceId: "", // Will be set below
        customerId: stripeCustomerId || undefined,
        customerEmail: stripeCustomerId ? undefined : user.email,
        successUrl: `${baseUrl}/events/${slug}?sponsorship=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl}/events/${slug}?sponsorship=cancelled`,
        workosOrganizationId: org_id,
        workosUserId: user.id,
        eventId: event.id,
        eventSponsorshipId: sponsorship.id,
        sponsorshipTierId: tier_id,
      };

      // Note: This endpoint expects a priceId. In a full implementation, you would either:
      // 1. Create Stripe products/prices in advance and store the price_id in the sponsorship tier
      // 2. Use Stripe's price_data to create a one-time price inline
      // For now, we return the sponsorship info and let the frontend handle Stripe integration

      logger.info(
        {
          sponsorshipId: sponsorship.id,
          eventId: event.id,
          orgId: org_id,
          tierId: tier_id,
        },
        "Sponsorship created (pending payment)"
      );

      res.status(201).json({
        sponsorship,
        checkout_url: null, // Stripe checkout URL would go here
        message: "Sponsorship reserved. Please contact finance@agenticadvertising.org to complete payment.",
      });
    } catch (error) {
      logger.error({ err: error }, "Error creating sponsorship");
      res.status(500).json({
        error: "Failed to create sponsorship",
        message: "An unexpected error occurred",
      });
    }
  });

  return { pageRouter, adminApiRouter, publicApiRouter };
}
