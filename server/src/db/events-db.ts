import { query } from './client.js';
import type {
  Event,
  CreateEventInput,
  UpdateEventInput,
  ListEventsOptions,
  EventRegistration,
  CreateEventRegistrationInput,
  EventSponsorship,
  CreateEventSponsorshipInput,
  EventWithCounts,
  EventSponsorDisplay,
  SponsorshipTier,
  RegistrationStatus,
} from '../types.js';

/**
 * Escape LIKE pattern wildcards to prevent SQL injection
 */
function escapeLikePattern(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

/**
 * Database operations for events
 */
export class EventsDatabase {
  // =====================================================
  // EVENTS CRUD
  // =====================================================

  /**
   * Create a new event
   */
  async createEvent(input: CreateEventInput): Promise<Event> {
    const result = await query<Event>(
      `INSERT INTO events (
        slug, title, description, short_description,
        event_type, event_format,
        start_time, end_time, timezone,
        venue_name, venue_address, venue_city, venue_state, venue_country,
        venue_lat, venue_lng,
        virtual_url, virtual_platform,
        luma_event_id, luma_url,
        featured_image_url,
        sponsorship_enabled, sponsorship_tiers, stripe_product_id,
        status, max_attendees,
        created_by_user_id, organization_id, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29
      )
      RETURNING *`,
      [
        input.slug,
        input.title,
        input.description || null,
        input.short_description || null,
        input.event_type || 'meetup',
        input.event_format || 'in_person',
        input.start_time,
        input.end_time || null,
        input.timezone || 'America/New_York',
        input.venue_name || null,
        input.venue_address || null,
        input.venue_city || null,
        input.venue_state || null,
        input.venue_country || null,
        input.venue_lat || null,
        input.venue_lng || null,
        input.virtual_url || null,
        input.virtual_platform || null,
        input.luma_event_id || null,
        input.luma_url || null,
        input.featured_image_url || null,
        input.sponsorship_enabled ?? false,
        JSON.stringify(input.sponsorship_tiers || []),
        input.stripe_product_id || null,
        input.status || 'draft',
        input.max_attendees || null,
        input.created_by_user_id || null,
        input.organization_id || null,
        JSON.stringify(input.metadata || {}),
      ]
    );

    return this.deserializeEvent(result.rows[0]);
  }

  /**
   * Get event by ID
   */
  async getEventById(id: string): Promise<Event | null> {
    const result = await query<Event>(
      'SELECT * FROM events WHERE id = $1',
      [id]
    );

    return result.rows[0] ? this.deserializeEvent(result.rows[0]) : null;
  }

  /**
   * Get event by slug
   */
  async getEventBySlug(slug: string): Promise<Event | null> {
    const result = await query<Event>(
      'SELECT * FROM events WHERE slug = $1',
      [slug]
    );

    return result.rows[0] ? this.deserializeEvent(result.rows[0]) : null;
  }

  /**
   * Update an event
   */
  async updateEvent(id: string, updates: UpdateEventInput): Promise<Event | null> {
    const COLUMN_MAP: Record<keyof UpdateEventInput, string> = {
      title: 'title',
      description: 'description',
      short_description: 'short_description',
      event_type: 'event_type',
      event_format: 'event_format',
      start_time: 'start_time',
      end_time: 'end_time',
      timezone: 'timezone',
      venue_name: 'venue_name',
      venue_address: 'venue_address',
      venue_city: 'venue_city',
      venue_state: 'venue_state',
      venue_country: 'venue_country',
      venue_lat: 'venue_lat',
      venue_lng: 'venue_lng',
      virtual_url: 'virtual_url',
      virtual_platform: 'virtual_platform',
      luma_event_id: 'luma_event_id',
      luma_url: 'luma_url',
      featured_image_url: 'featured_image_url',
      sponsorship_enabled: 'sponsorship_enabled',
      sponsorship_tiers: 'sponsorship_tiers',
      stripe_product_id: 'stripe_product_id',
      status: 'status',
      published_at: 'published_at',
      max_attendees: 'max_attendees',
      metadata: 'metadata',
    };

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      const columnName = COLUMN_MAP[key as keyof UpdateEventInput];
      if (!columnName) continue;

      setClauses.push(`${columnName} = $${paramIndex++}`);
      if (key === 'metadata' || key === 'sponsorship_tiers') {
        params.push(JSON.stringify(value));
      } else {
        params.push(value);
      }
    }

    if (setClauses.length === 0) {
      return this.getEventById(id);
    }

    params.push(id);
    const sql = `
      UPDATE events
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await query<Event>(sql, params);
    return result.rows[0] ? this.deserializeEvent(result.rows[0]) : null;
  }

  /**
   * Delete an event
   */
  async deleteEvent(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM events WHERE id = $1',
      [id]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * List events with filtering
   */
  async listEvents(options: ListEventsOptions = {}): Promise<Event[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(options.status);
    }

    if (options.event_type) {
      conditions.push(`event_type = $${paramIndex++}`);
      params.push(options.event_type);
    }

    if (options.event_format) {
      conditions.push(`event_format = $${paramIndex++}`);
      params.push(options.event_format);
    }

    if (options.upcoming_only) {
      conditions.push(`start_time > NOW()`);
    }

    if (options.past_only) {
      conditions.push(`start_time < NOW()`);
    }

    if (options.search) {
      conditions.push(`(
        title ILIKE $${paramIndex} OR
        description ILIKE $${paramIndex} OR
        short_description ILIKE $${paramIndex} OR
        venue_name ILIKE $${paramIndex} OR
        venue_city ILIKE $${paramIndex}
      )`);
      params.push(`%${escapeLikePattern(options.search)}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    let sql = `
      SELECT * FROM events
      ${whereClause}
      ORDER BY start_time ASC
    `;

    if (options.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await query<Event>(sql, params);
    return result.rows.map(row => this.deserializeEvent(row));
  }

  /**
   * Get upcoming published events with counts
   */
  async getUpcomingEvents(): Promise<EventWithCounts[]> {
    const result = await query<EventWithCounts>(
      'SELECT * FROM upcoming_events'
    );
    return result.rows.map(row => this.deserializeEvent(row) as EventWithCounts);
  }

  /**
   * Check if slug is available
   */
  async isSlugAvailable(slug: string, excludeId?: string): Promise<boolean> {
    let sql = 'SELECT 1 FROM events WHERE slug = $1';
    const params: unknown[] = [slug];

    if (excludeId) {
      sql += ' AND id != $2';
      params.push(excludeId);
    }

    sql += ' LIMIT 1';

    const result = await query(sql, params);
    return result.rows.length === 0;
  }

  /**
   * Publish an event
   */
  async publishEvent(id: string): Promise<Event | null> {
    return this.updateEvent(id, {
      status: 'published',
      published_at: new Date(),
    });
  }

  // =====================================================
  // EVENT REGISTRATIONS
  // =====================================================

  /**
   * Create an event registration
   */
  async createRegistration(input: CreateEventRegistrationInput): Promise<EventRegistration> {
    const ticketCode = this.generateTicketCode();

    const result = await query<EventRegistration>(
      `INSERT INTO event_registrations (
        event_id, workos_user_id, email_contact_id, email, name,
        registration_status, registration_source, organization_id,
        ticket_type, ticket_code, registration_data, luma_guest_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        input.event_id,
        input.workos_user_id || null,
        input.email_contact_id || null,
        input.email || null,
        input.name || null,
        input.registration_status || 'registered',
        input.registration_source || 'direct',
        input.organization_id || null,
        input.ticket_type || 'general',
        ticketCode,
        JSON.stringify(input.registration_data || {}),
        input.luma_guest_id || null,
      ]
    );

    return this.deserializeRegistration(result.rows[0]);
  }

  /**
   * Get registration by ID
   */
  async getRegistrationById(id: string): Promise<EventRegistration | null> {
    const result = await query<EventRegistration>(
      'SELECT * FROM event_registrations WHERE id = $1',
      [id]
    );

    return result.rows[0] ? this.deserializeRegistration(result.rows[0]) : null;
  }

  /**
   * Get registrations for an event
   */
  async getEventRegistrations(eventId: string): Promise<EventRegistration[]> {
    const result = await query<EventRegistration>(
      `SELECT * FROM event_registrations
       WHERE event_id = $1
       ORDER BY registered_at ASC`,
      [eventId]
    );

    return result.rows.map(row => this.deserializeRegistration(row));
  }

  /**
   * Get registrations by user
   */
  async getUserRegistrations(workosUserId: string): Promise<EventRegistration[]> {
    const result = await query<EventRegistration>(
      `SELECT * FROM event_registrations
       WHERE workos_user_id = $1
       ORDER BY registered_at DESC`,
      [workosUserId]
    );

    return result.rows.map(row => this.deserializeRegistration(row));
  }

  /**
   * Get registrations by email
   */
  async getEmailRegistrations(email: string): Promise<EventRegistration[]> {
    const result = await query<EventRegistration>(
      `SELECT * FROM event_registrations
       WHERE email = $1
       ORDER BY registered_at DESC`,
      [email]
    );

    return result.rows.map(row => this.deserializeRegistration(row));
  }

  /**
   * Check if user is registered for an event
   */
  async isUserRegistered(eventId: string, workosUserId: string): Promise<boolean> {
    const result = await query(
      `SELECT 1 FROM event_registrations
       WHERE event_id = $1 AND workos_user_id = $2
       AND registration_status != 'cancelled'
       LIMIT 1`,
      [eventId, workosUserId]
    );
    return result.rows.length > 0;
  }

  /**
   * Mark attendee as checked in
   */
  async checkInAttendee(registrationId: string): Promise<EventRegistration | null> {
    const result = await query<EventRegistration>(
      `UPDATE event_registrations
       SET attended = TRUE, checked_in_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [registrationId]
    );

    return result.rows[0] ? this.deserializeRegistration(result.rows[0]) : null;
  }

  /**
   * Cancel registration
   */
  async cancelRegistration(registrationId: string): Promise<EventRegistration | null> {
    const result = await query<EventRegistration>(
      `UPDATE event_registrations
       SET registration_status = 'cancelled', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [registrationId]
    );

    return result.rows[0] ? this.deserializeRegistration(result.rows[0]) : null;
  }

  /**
   * Update registration (for imports and admin updates)
   */
  async updateRegistration(
    registrationId: string,
    updates: {
      attended?: boolean;
      checked_in_at?: Date;
      registration_status?: RegistrationStatus;
      luma_guest_id?: string;
      email_contact_id?: string;
    }
  ): Promise<EventRegistration | null> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.attended !== undefined) {
      setClauses.push(`attended = $${paramIndex++}`);
      params.push(updates.attended);
    }
    if (updates.checked_in_at !== undefined) {
      setClauses.push(`checked_in_at = $${paramIndex++}`);
      params.push(updates.checked_in_at);
    }
    if (updates.registration_status !== undefined) {
      setClauses.push(`registration_status = $${paramIndex++}`);
      params.push(updates.registration_status);
    }
    if (updates.luma_guest_id !== undefined) {
      setClauses.push(`luma_guest_id = $${paramIndex++}`);
      params.push(updates.luma_guest_id);
    }
    if (updates.email_contact_id !== undefined) {
      setClauses.push(`email_contact_id = $${paramIndex++}`);
      params.push(updates.email_contact_id);
    }

    params.push(registrationId);

    const result = await query<EventRegistration>(
      `UPDATE event_registrations
       SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      params
    );

    return result.rows[0] ? this.deserializeRegistration(result.rows[0]) : null;
  }

  /**
   * Generate unique ticket code
   */
  private generateTicketCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // =====================================================
  // EVENT SPONSORSHIPS
  // =====================================================

  /**
   * Create an event sponsorship
   */
  async createSponsorship(input: CreateEventSponsorshipInput): Promise<EventSponsorship> {
    const result = await query<EventSponsorship>(
      `INSERT INTO event_sponsorships (
        event_id, organization_id, purchased_by_user_id,
        tier_id, tier_name, amount_cents, currency,
        stripe_checkout_session_id, logo_url, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        input.event_id,
        input.organization_id,
        input.purchased_by_user_id || null,
        input.tier_id,
        input.tier_name || null,
        input.amount_cents,
        input.currency || 'USD',
        input.stripe_checkout_session_id || null,
        input.logo_url || null,
        input.notes || null,
      ]
    );

    return this.deserializeSponsorship(result.rows[0]);
  }

  /**
   * Get sponsorship by ID
   */
  async getSponsorshipById(id: string): Promise<EventSponsorship | null> {
    const result = await query<EventSponsorship>(
      'SELECT * FROM event_sponsorships WHERE id = $1',
      [id]
    );

    return result.rows[0] ? this.deserializeSponsorship(result.rows[0]) : null;
  }

  /**
   * Get sponsorship by Stripe checkout session
   */
  async getSponsorshipByCheckoutSession(sessionId: string): Promise<EventSponsorship | null> {
    const result = await query<EventSponsorship>(
      'SELECT * FROM event_sponsorships WHERE stripe_checkout_session_id = $1',
      [sessionId]
    );

    return result.rows[0] ? this.deserializeSponsorship(result.rows[0]) : null;
  }

  /**
   * Get sponsorships for an event
   */
  async getEventSponsorships(eventId: string): Promise<EventSponsorship[]> {
    const result = await query<EventSponsorship>(
      `SELECT * FROM event_sponsorships
       WHERE event_id = $1
       ORDER BY display_order ASC, created_at ASC`,
      [eventId]
    );

    return result.rows.map(row => this.deserializeSponsorship(row));
  }

  /**
   * Get paid sponsors for display
   */
  async getEventSponsorsForDisplay(eventId: string): Promise<EventSponsorDisplay[]> {
    const result = await query<EventSponsorDisplay>(
      `SELECT * FROM event_sponsors WHERE event_id = $1`,
      [eventId]
    );

    return result.rows;
  }

  /**
   * Get sponsorships by organization
   */
  async getOrganizationSponsorships(organizationId: string): Promise<EventSponsorship[]> {
    const result = await query<EventSponsorship>(
      `SELECT * FROM event_sponsorships
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [organizationId]
    );

    return result.rows.map(row => this.deserializeSponsorship(row));
  }

  /**
   * Mark sponsorship as paid
   */
  async markSponsorshipPaid(
    id: string,
    stripePaymentIntentId?: string,
    stripeInvoiceId?: string
  ): Promise<EventSponsorship | null> {
    const result = await query<EventSponsorship>(
      `UPDATE event_sponsorships
       SET payment_status = 'paid',
           paid_at = NOW(),
           stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
           stripe_invoice_id = COALESCE($3, stripe_invoice_id),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, stripePaymentIntentId || null, stripeInvoiceId || null]
    );

    return result.rows[0] ? this.deserializeSponsorship(result.rows[0]) : null;
  }

  /**
   * Check if organization has sponsorship for event tier
   */
  async hasSponsorship(eventId: string, organizationId: string, tierId: string): Promise<boolean> {
    const result = await query(
      `SELECT 1 FROM event_sponsorships
       WHERE event_id = $1 AND organization_id = $2 AND tier_id = $3
       AND payment_status NOT IN ('cancelled', 'refunded')
       LIMIT 1`,
      [eventId, organizationId, tierId]
    );
    return result.rows.length > 0;
  }

  /**
   * Count sponsors for a tier
   */
  async countTierSponsors(eventId: string, tierId: string): Promise<number> {
    const result = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM event_sponsorships
       WHERE event_id = $1 AND tier_id = $2
       AND payment_status = 'paid'`,
      [eventId, tierId]
    );
    return parseInt(result.rows[0]?.count || '0', 10);
  }

  // =====================================================
  // EVENT CONTENT (PERSPECTIVES)
  // =====================================================

  /**
   * Get perspectives linked to an event (recaps, photos, etc.)
   */
  async getEventContent(eventId: string): Promise<{
    id: string;
    slug: string;
    content_type: string;
    title: string;
    excerpt: string | null;
    external_url: string | null;
    featured_image_url: string | null;
    published_at: Date | null;
    category: string | null;
  }[]> {
    const result = await query<{
      id: string;
      slug: string;
      content_type: string;
      title: string;
      excerpt: string | null;
      external_url: string | null;
      featured_image_url: string | null;
      published_at: Date | null;
      category: string | null;
    }>(
      `SELECT id, slug, content_type, title, excerpt, external_url,
              featured_image_url, published_at, category
       FROM perspectives
       WHERE event_id = $1 AND status = 'published'
       ORDER BY published_at DESC`,
      [eventId]
    );
    return result.rows;
  }

  /**
   * Link a perspective to an event
   */
  async linkPerspectiveToEvent(perspectiveId: string, eventId: string): Promise<boolean> {
    const result = await query(
      `UPDATE perspectives SET event_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [perspectiveId, eventId]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Unlink a perspective from an event
   */
  async unlinkPerspectiveFromEvent(perspectiveId: string): Promise<boolean> {
    const result = await query(
      `UPDATE perspectives SET event_id = NULL, updated_at = NOW()
       WHERE id = $1`,
      [perspectiveId]
    );
    return (result.rowCount || 0) > 0;
  }

  // =====================================================
  // DESERIALIZATION HELPERS
  // =====================================================

  private deserializeEvent(row: any): Event {
    let sponsorshipTiers: SponsorshipTier[] = [];
    if (row.sponsorship_tiers) {
      sponsorshipTiers = typeof row.sponsorship_tiers === 'string'
        ? JSON.parse(row.sponsorship_tiers)
        : row.sponsorship_tiers;
    }

    return {
      ...row,
      sponsorship_tiers: sponsorshipTiers,
      metadata: typeof row.metadata === 'string'
        ? JSON.parse(row.metadata)
        : row.metadata || {},
      start_time: new Date(row.start_time),
      end_time: row.end_time ? new Date(row.end_time) : undefined,
      published_at: row.published_at ? new Date(row.published_at) : undefined,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }

  private deserializeRegistration(row: any): EventRegistration {
    return {
      ...row,
      registration_data: typeof row.registration_data === 'string'
        ? JSON.parse(row.registration_data)
        : row.registration_data || {},
      checked_in_at: row.checked_in_at ? new Date(row.checked_in_at) : undefined,
      registered_at: new Date(row.registered_at),
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }

  private deserializeSponsorship(row: any): EventSponsorship {
    return {
      ...row,
      benefits_delivered: typeof row.benefits_delivered === 'string'
        ? JSON.parse(row.benefits_delivered)
        : row.benefits_delivered || {},
      paid_at: row.paid_at ? new Date(row.paid_at) : undefined,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}

// Export singleton instance
export const eventsDb = new EventsDatabase();
