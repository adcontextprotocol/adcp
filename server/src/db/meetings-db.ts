import { query } from './client.js';
import type {
  Meeting,
  MeetingSeries,
  MeetingAttendee,
  WorkingGroupTopicSubscription,
  CreateMeetingInput,
  UpdateMeetingInput,
  CreateMeetingSeriesInput,
  UpdateMeetingSeriesInput,
  CreateMeetingAttendeeInput,
  UpdateMeetingAttendeeInput,
  UpdateTopicSubscriptionInput,
  ListMeetingsOptions,
  MeetingWithGroup,
  MemberMeeting,
  WorkingGroupTopic,
  RecurrenceRule,
} from '../types.js';

/**
 * Database operations for meetings and meeting series
 */
export class MeetingsDatabase {
  // ============== Meeting Series ==============

  /**
   * Create a new meeting series
   */
  async createSeries(input: CreateMeetingSeriesInput): Promise<MeetingSeries> {
    const result = await query<MeetingSeries>(
      `INSERT INTO meeting_series (
        working_group_id, title, description, topic_slugs,
        recurrence_rule, default_start_time, duration_minutes,
        timezone, invite_mode, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        input.working_group_id,
        input.title,
        input.description || null,
        input.topic_slugs || [],
        input.recurrence_rule ? JSON.stringify(input.recurrence_rule) : null,
        input.default_start_time || null,
        input.duration_minutes ?? 60,
        input.timezone ?? 'America/New_York',
        input.invite_mode ?? 'topic_subscribers',
        input.created_by_user_id || null,
      ]
    );

    return result.rows[0];
  }

  /**
   * Get meeting series by ID
   */
  async getSeriesById(id: string): Promise<MeetingSeries | null> {
    const result = await query<MeetingSeries>(
      'SELECT * FROM meeting_series WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Update meeting series
   */
  async updateSeries(id: string, updates: UpdateMeetingSeriesInput): Promise<MeetingSeries | null> {
    const COLUMN_MAP: Record<string, string> = {
      title: 'title',
      description: 'description',
      topic_slugs: 'topic_slugs',
      recurrence_rule: 'recurrence_rule',
      default_start_time: 'default_start_time',
      duration_minutes: 'duration_minutes',
      timezone: 'timezone',
      zoom_meeting_id: 'zoom_meeting_id',
      zoom_join_url: 'zoom_join_url',
      zoom_passcode: 'zoom_passcode',
      google_calendar_id: 'google_calendar_id',
      google_event_series_id: 'google_event_series_id',
      invite_mode: 'invite_mode',
      status: 'status',
    };

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      const columnName = COLUMN_MAP[key];
      if (!columnName) continue;

      setClauses.push(`${columnName} = $${paramIndex++}`);
      // Handle JSON fields
      if (key === 'recurrence_rule' && value) {
        params.push(JSON.stringify(value));
      } else {
        params.push(value);
      }
    }

    if (setClauses.length === 0) {
      return this.getSeriesById(id);
    }

    params.push(id);
    const sql = `
      UPDATE meeting_series
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await query<MeetingSeries>(sql, params);
    return result.rows[0] || null;
  }

  /**
   * Delete meeting series
   */
  async deleteSeries(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM meeting_series WHERE id = $1',
      [id]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * List series for a working group
   */
  async listSeriesForGroup(workingGroupId: string, options: {
    status?: string;
    topic_slugs?: string[];
  } = {}): Promise<MeetingSeries[]> {
    const conditions: string[] = ['working_group_id = $1'];
    const params: unknown[] = [workingGroupId];
    let paramIndex = 2;

    if (options.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(options.status);
    }

    if (options.topic_slugs && options.topic_slugs.length > 0) {
      conditions.push(`topic_slugs && $${paramIndex++}`);
      params.push(options.topic_slugs);
    }

    const result = await query<MeetingSeries>(
      `SELECT * FROM meeting_series
       WHERE ${conditions.join(' AND ')}
       ORDER BY title`,
      params
    );

    return result.rows;
  }

  // ============== Meetings ==============

  /**
   * Create a new meeting
   */
  async createMeeting(input: CreateMeetingInput): Promise<Meeting> {
    const result = await query<Meeting>(
      `INSERT INTO meetings (
        series_id, working_group_id, title, description, agenda,
        topic_slugs, start_time, end_time, timezone, status,
        created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        input.series_id || null,
        input.working_group_id,
        input.title,
        input.description || null,
        input.agenda || null,
        input.topic_slugs || [],
        input.start_time,
        input.end_time || null,
        input.timezone ?? 'America/New_York',
        input.status ?? 'scheduled',
        input.created_by_user_id || null,
      ]
    );

    return result.rows[0];
  }

  /**
   * Get meeting by ID
   */
  async getMeetingById(id: string): Promise<Meeting | null> {
    const result = await query<Meeting>(
      'SELECT * FROM meetings WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Get meeting by Zoom meeting ID
   */
  async getMeetingByZoomId(zoomMeetingId: string): Promise<Meeting | null> {
    const result = await query<Meeting>(
      'SELECT * FROM meetings WHERE zoom_meeting_id = $1',
      [zoomMeetingId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get meeting with working group info
   */
  async getMeetingWithGroup(id: string): Promise<MeetingWithGroup | null> {
    const result = await query<MeetingWithGroup>(
      `SELECT
         m.*,
         wg.name as working_group_name,
         wg.slug as working_group_slug,
         wg.committee_type,
         ms.title as series_title,
         (SELECT COUNT(*) FROM meeting_attendees ma
          WHERE ma.meeting_id = m.id AND ma.rsvp_status = 'accepted')::int as accepted_count,
         (SELECT COUNT(*) FROM meeting_attendees ma
          WHERE ma.meeting_id = m.id)::int as invited_count
       FROM meetings m
       JOIN working_groups wg ON wg.id = m.working_group_id
       LEFT JOIN meeting_series ms ON ms.id = m.series_id
       WHERE m.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Update meeting
   */
  async updateMeeting(id: string, updates: UpdateMeetingInput): Promise<Meeting | null> {
    const COLUMN_MAP: Record<string, string> = {
      title: 'title',
      description: 'description',
      agenda: 'agenda',
      topic_slugs: 'topic_slugs',
      start_time: 'start_time',
      end_time: 'end_time',
      timezone: 'timezone',
      zoom_meeting_id: 'zoom_meeting_id',
      zoom_join_url: 'zoom_join_url',
      zoom_passcode: 'zoom_passcode',
      google_calendar_event_id: 'google_calendar_event_id',
      recording_url: 'recording_url',
      transcript_url: 'transcript_url',
      transcript_text: 'transcript_text',
      summary: 'summary',
      status: 'status',
      slack_channel_id: 'slack_channel_id',
      slack_thread_ts: 'slack_thread_ts',
      slack_announcement_ts: 'slack_announcement_ts',
    };

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      const columnName = COLUMN_MAP[key];
      if (!columnName) continue;

      setClauses.push(`${columnName} = $${paramIndex++}`);
      params.push(value);
    }

    if (setClauses.length === 0) {
      return this.getMeetingById(id);
    }

    params.push(id);
    const sql = `
      UPDATE meetings
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await query<Meeting>(sql, params);
    return result.rows[0] || null;
  }

  /**
   * Delete meeting
   */
  async deleteMeeting(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM meetings WHERE id = $1',
      [id]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * List meetings with filters
   */
  async listMeetings(options: ListMeetingsOptions = {}): Promise<MeetingWithGroup[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.working_group_id) {
      conditions.push(`m.working_group_id = $${paramIndex++}`);
      params.push(options.working_group_id);
    }

    if (options.series_id) {
      conditions.push(`m.series_id = $${paramIndex++}`);
      params.push(options.series_id);
    }

    if (options.status) {
      conditions.push(`m.status = $${paramIndex++}`);
      params.push(options.status);
    }

    if (options.topic_slugs && options.topic_slugs.length > 0) {
      conditions.push(`m.topic_slugs && $${paramIndex++}`);
      params.push(options.topic_slugs);
    }

    if (options.upcoming_only) {
      conditions.push(`m.start_time > NOW()`);
      conditions.push(`m.status = 'scheduled'`);
    }

    if (options.past_only) {
      conditions.push(`m.start_time < NOW()`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    let limitClause = '';
    if (options.limit) {
      limitClause = `LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    let offsetClause = '';
    if (options.offset) {
      offsetClause = `OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await query<MeetingWithGroup>(
      `SELECT
         m.*,
         wg.name as working_group_name,
         wg.slug as working_group_slug,
         wg.committee_type,
         ms.title as series_title,
         (SELECT COUNT(*) FROM meeting_attendees ma
          WHERE ma.meeting_id = m.id AND ma.rsvp_status = 'accepted')::int as accepted_count,
         (SELECT COUNT(*) FROM meeting_attendees ma
          WHERE ma.meeting_id = m.id)::int as invited_count
       FROM meetings m
       JOIN working_groups wg ON wg.id = m.working_group_id
       LEFT JOIN meeting_series ms ON ms.id = m.series_id
       ${whereClause}
       ORDER BY m.start_time ${options.past_only ? 'DESC' : 'ASC'}
       ${limitClause}
       ${offsetClause}`,
      params
    );

    return result.rows;
  }

  /**
   * Get upcoming meetings for public display
   */
  async getUpcomingMeetings(limit: number = 10): Promise<MeetingWithGroup[]> {
    return this.listMeetings({ upcoming_only: true, limit });
  }

  /**
   * Get meetings for a user (where they're an attendee)
   */
  async getMeetingsForUser(userId: string, options: {
    upcoming_only?: boolean;
    limit?: number;
  } = {}): Promise<MemberMeeting[]> {
    const conditions: string[] = [
      `ma.workos_user_id = $1`,
      `ma.rsvp_status != 'declined'`,
    ];
    const params: unknown[] = [userId];
    let paramIndex = 2;

    if (options.upcoming_only) {
      conditions.push(`m.status = 'scheduled'`);
      conditions.push(`m.start_time > NOW()`);
    }

    let limitClause = '';
    if (options.limit) {
      limitClause = `LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    const result = await query<MemberMeeting>(
      `SELECT
         ma.workos_user_id,
         ma.rsvp_status,
         m.id as meeting_id,
         m.title,
         m.start_time,
         m.end_time,
         m.timezone,
         m.zoom_join_url,
         m.working_group_id,
         wg.name as working_group_name,
         wg.slug as working_group_slug
       FROM meeting_attendees ma
       JOIN meetings m ON m.id = ma.meeting_id
       JOIN working_groups wg ON wg.id = m.working_group_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.start_time ASC
       ${limitClause}`,
      params
    );

    return result.rows;
  }

  // ============== Attendees ==============

  /**
   * Add an attendee to a meeting
   */
  async addAttendee(input: CreateMeetingAttendeeInput): Promise<MeetingAttendee> {
    const result = await query<MeetingAttendee>(
      `INSERT INTO meeting_attendees (
        meeting_id, workos_user_id, email, name, rsvp_status, invite_source
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (meeting_id, workos_user_id)
      DO UPDATE SET updated_at = NOW()
      RETURNING *`,
      [
        input.meeting_id,
        input.workos_user_id || null,
        input.email || null,
        input.name || null,
        input.rsvp_status ?? 'pending',
        input.invite_source ?? 'auto',
      ]
    );

    return result.rows[0];
  }

  /**
   * Get attendee record
   */
  async getAttendee(meetingId: string, userId: string): Promise<MeetingAttendee | null> {
    const result = await query<MeetingAttendee>(
      `SELECT * FROM meeting_attendees
       WHERE meeting_id = $1 AND workos_user_id = $2`,
      [meetingId, userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Update attendee (RSVP, attendance)
   */
  async updateAttendee(
    meetingId: string,
    userId: string,
    updates: UpdateMeetingAttendeeInput
  ): Promise<MeetingAttendee | null> {
    const COLUMN_MAP: Record<string, string> = {
      rsvp_status: 'rsvp_status',
      rsvp_note: 'rsvp_note',
      attended: 'attended',
      joined_at: 'joined_at',
      left_at: 'left_at',
    };

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      const columnName = COLUMN_MAP[key];
      if (!columnName) continue;

      setClauses.push(`${columnName} = $${paramIndex++}`);
      params.push(value);
    }

    // Set rsvp_at when status changes
    if (updates.rsvp_status) {
      setClauses.push(`rsvp_at = NOW()`);
    }

    if (setClauses.length === 0) {
      return this.getAttendee(meetingId, userId);
    }

    params.push(meetingId, userId);
    const sql = `
      UPDATE meeting_attendees
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE meeting_id = $${paramIndex} AND workos_user_id = $${paramIndex + 1}
      RETURNING *
    `;

    const result = await query<MeetingAttendee>(sql, params);
    return result.rows[0] || null;
  }

  /**
   * Remove attendee from meeting
   */
  async removeAttendee(meetingId: string, userId: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM meeting_attendees WHERE meeting_id = $1 AND workos_user_id = $2',
      [meetingId, userId]
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Get all attendees for a meeting
   */
  async getAttendeesForMeeting(meetingId: string): Promise<MeetingAttendee[]> {
    const result = await query<MeetingAttendee>(
      `SELECT * FROM meeting_attendees
       WHERE meeting_id = $1
       ORDER BY name, email`,
      [meetingId]
    );
    return result.rows;
  }

  /**
   * Bulk add attendees to a meeting
   */
  async addAttendeesFromGroup(
    meetingId: string,
    workingGroupId: string,
    topicSlugs?: string[]
  ): Promise<number> {
    // Get members to invite based on topic subscriptions
    let memberQuery: string;
    let memberParams: unknown[];

    if (topicSlugs && topicSlugs.length > 0) {
      // Invite only members subscribed to these topics
      // Join with users table to get email (working_group_memberships.user_email is often NULL)
      memberQuery = `
        SELECT
          wgm.workos_user_id,
          COALESCE(u.email, wgm.user_email) as email,
          COALESCE(u.first_name || ' ' || u.last_name, wgm.user_name) as name
        FROM working_group_memberships wgm
        LEFT JOIN users u ON u.workos_user_id = wgm.workos_user_id
        LEFT JOIN working_group_topic_subscriptions wgts
          ON wgts.working_group_id = wgm.working_group_id
          AND wgts.workos_user_id = wgm.workos_user_id
        WHERE wgm.working_group_id = $1
          AND wgm.status = 'active'
          AND (wgts.topic_slugs && $2 OR wgts.topic_slugs IS NULL)
      `;
      memberParams = [workingGroupId, topicSlugs];
    } else {
      // Invite all members
      // Join with users table to get email (working_group_memberships.user_email is often NULL)
      memberQuery = `
        SELECT
          wgm.workos_user_id,
          COALESCE(u.email, wgm.user_email) as email,
          COALESCE(u.first_name || ' ' || u.last_name, wgm.user_name) as name
        FROM working_group_memberships wgm
        LEFT JOIN users u ON u.workos_user_id = wgm.workos_user_id
        WHERE wgm.working_group_id = $1 AND wgm.status = 'active'
      `;
      memberParams = [workingGroupId];
    }

    const members = await query<{
      workos_user_id: string;
      email: string;
      name: string;
    }>(memberQuery, memberParams);

    if (members.rows.length === 0) {
      return 0;
    }

    // Bulk insert attendees
    const values = members.rows.map((_, i) => {
      const base = i * 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, 'pending', 'auto')`;
    }).join(', ');

    const insertParams = members.rows.flatMap(m => [
      meetingId,
      m.workos_user_id,
      m.email,
      m.name,
    ]);

    await query(
      `INSERT INTO meeting_attendees (meeting_id, workos_user_id, email, name, rsvp_status, invite_source)
       VALUES ${values}
       ON CONFLICT (meeting_id, workos_user_id) DO NOTHING`,
      insertParams
    );

    return members.rows.length;
  }

  // ============== Topic Subscriptions ==============

  /**
   * Get or create topic subscription for a user in a group
   */
  async getTopicSubscription(
    workingGroupId: string,
    userId: string
  ): Promise<WorkingGroupTopicSubscription | null> {
    const result = await query<WorkingGroupTopicSubscription>(
      `SELECT * FROM working_group_topic_subscriptions
       WHERE working_group_id = $1 AND workos_user_id = $2`,
      [workingGroupId, userId]
    );
    return result.rows[0] || null;
  }

  /**
   * Update topic subscription (create if not exists)
   */
  async updateTopicSubscription(input: UpdateTopicSubscriptionInput): Promise<WorkingGroupTopicSubscription> {
    const result = await query<WorkingGroupTopicSubscription>(
      `INSERT INTO working_group_topic_subscriptions (working_group_id, workos_user_id, topic_slugs)
       VALUES ($1, $2, $3)
       ON CONFLICT (working_group_id, workos_user_id)
       DO UPDATE SET topic_slugs = $3, updated_at = NOW()
       RETURNING *`,
      [input.working_group_id, input.workos_user_id, input.topic_slugs]
    );
    return result.rows[0];
  }

  /**
   * Get members subscribed to specific topics in a group
   */
  async getMembersForTopics(workingGroupId: string, topicSlugs: string[]): Promise<Array<{
    workos_user_id: string;
    user_email: string;
    user_name: string;
    subscribed_topics: string[];
  }>> {
    const result = await query<{
      workos_user_id: string;
      user_email: string;
      user_name: string;
      subscribed_topics: string[];
    }>(
      `SELECT
         wgm.workos_user_id,
         wgm.user_email,
         wgm.user_name,
         COALESCE(wgts.topic_slugs, '{}') as subscribed_topics
       FROM working_group_memberships wgm
       LEFT JOIN working_group_topic_subscriptions wgts
         ON wgts.working_group_id = wgm.working_group_id
         AND wgts.workos_user_id = wgm.workos_user_id
       WHERE wgm.working_group_id = $1
         AND wgm.status = 'active'
         AND (wgts.topic_slugs && $2 OR wgts.topic_slugs IS NULL)`,
      [workingGroupId, topicSlugs]
    );
    return result.rows;
  }

  // ============== Working Group Topics ==============

  /**
   * Get topics for a working group
   */
  async getTopicsForGroup(workingGroupId: string): Promise<WorkingGroupTopic[]> {
    const result = await query<{ topics: WorkingGroupTopic[] }>(
      'SELECT topics FROM working_groups WHERE id = $1',
      [workingGroupId]
    );
    return result.rows[0]?.topics || [];
  }

  /**
   * Set topics for a working group
   */
  async setTopicsForGroup(workingGroupId: string, topics: WorkingGroupTopic[]): Promise<void> {
    await query(
      'UPDATE working_groups SET topics = $2, updated_at = NOW() WHERE id = $1',
      [workingGroupId, JSON.stringify(topics)]
    );
  }

  /**
   * Add a topic to a working group
   */
  async addTopicToGroup(workingGroupId: string, topic: WorkingGroupTopic): Promise<void> {
    await query(
      `UPDATE working_groups
       SET topics = topics || $2::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [workingGroupId, JSON.stringify(topic)]
    );
  }

  /**
   * Remove a topic from a working group
   */
  async removeTopicFromGroup(workingGroupId: string, topicSlug: string): Promise<void> {
    await query(
      `UPDATE working_groups
       SET topics = (
         SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
         FROM jsonb_array_elements(topics) elem
         WHERE elem->>'slug' != $2
       ),
       updated_at = NOW()
       WHERE id = $1`,
      [workingGroupId, topicSlug]
    );
  }
}
