/**
 * Meeting routes module
 *
 * Handles all API routes for meetings and meeting series
 * including admin, public, and user endpoints.
 */

import { Router, Request, Response } from "express";
import { validate as uuidValidate } from "uuid";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin, optionalAuth } from "../middleware/auth.js";
import { MeetingsDatabase } from "../db/meetings-db.js";
import { WorkingGroupDatabase } from "../db/working-group-db.js";
import { getChannelMembers } from "../slack/client.js";
import type { WorkingGroupTopic, MeetingStatus } from "../types.js";

// UUID validation helper
function isValidUuid(id: string): boolean {
  return uuidValidate(id);
}

const logger = createLogger("meeting-routes");

/**
 * Create meeting routes
 * Returns routers for admin API (/api/admin/meetings), public API (/api/meetings),
 * and user API (/api/me/meetings)
 */
export function createMeetingRouters(): {
  adminApiRouter: Router;
  publicApiRouter: Router;
  userApiRouter: Router;
} {
  const adminApiRouter = Router();
  const publicApiRouter = Router();
  const userApiRouter = Router();

  const meetingsDb = new MeetingsDatabase();
  const workingGroupDb = new WorkingGroupDatabase();

  // =========================================================================
  // ADMIN API ROUTES (/api/admin/meetings)
  // =========================================================================

  // GET /api/admin/meetings - List all meetings with filters
  adminApiRouter.get('/', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const {
        working_group_id,
        series_id,
        status,
        upcoming_only,
        past_only,
        limit,
        offset,
      } = req.query;

      const meetings = await meetingsDb.listMeetings({
        working_group_id: working_group_id as string,
        series_id: series_id as string,
        status: status as MeetingStatus | undefined,
        upcoming_only: upcoming_only === 'true',
        past_only: past_only === 'true',
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });

      res.json({ meetings });
    } catch (error) {
      logger.error({ err: error }, 'List meetings error');
      res.status(500).json({
        error: 'Failed to list meetings',
        message: 'An internal error occurred',
      });
    }
  });

  // GET /api/admin/meetings/series - List all meeting series
  adminApiRouter.get('/series', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { working_group_id, status } = req.query;

      if (!working_group_id) {
        return res.status(400).json({
          error: 'Missing required parameter',
          message: 'working_group_id is required',
        });
      }

      if (!isValidUuid(working_group_id as string)) {
        return res.status(400).json({
          error: 'Invalid working group ID',
          message: 'Working group ID must be a valid UUID',
        });
      }

      const series = await meetingsDb.listSeriesForGroup(working_group_id as string, {
        status: status as string,
      });

      res.json({ series });
    } catch (error) {
      logger.error({ err: error }, 'List meeting series error');
      res.status(500).json({
        error: 'Failed to list meeting series',
        message: 'An internal error occurred',
      });
    }
  });

  // POST /api/admin/meetings/series - Create meeting series
  adminApiRouter.post('/series', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const {
        working_group_id,
        title,
        description,
        topic_slugs,
        recurrence_rule,
        default_start_time,
        duration_minutes,
        timezone,
        invite_mode,
        invite_slack_channel_id,
      } = req.body;

      if (!working_group_id || !title) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'working_group_id and title are required',
        });
      }

      if (!isValidUuid(working_group_id)) {
        return res.status(400).json({
          error: 'Invalid working group ID',
          message: 'Working group ID must be a valid UUID',
        });
      }

      // Verify working group exists
      const group = await workingGroupDb.getWorkingGroupById(working_group_id);
      if (!group) {
        return res.status(404).json({
          error: 'Working group not found',
          message: 'No working group found with the specified ID',
        });
      }

      const series = await meetingsDb.createSeries({
        working_group_id,
        title,
        description,
        topic_slugs,
        recurrence_rule,
        default_start_time,
        duration_minutes,
        timezone,
        invite_mode,
        invite_slack_channel_id,
        created_by_user_id: user.id,
      });

      res.status(201).json(series);
    } catch (error) {
      logger.error({ err: error }, 'Create meeting series error');
      res.status(500).json({
        error: 'Failed to create meeting series',
        message: 'An internal error occurred',
      });
    }
  });

  // GET /api/admin/meetings/series/:id - Get meeting series by ID
  adminApiRouter.get('/series/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid series ID',
          message: 'Series ID must be a valid UUID',
        });
      }

      const series = await meetingsDb.getSeriesById(id);

      if (!series) {
        return res.status(404).json({
          error: 'Meeting series not found',
          message: 'No meeting series found with the specified ID',
        });
      }

      res.json(series);
    } catch (error) {
      logger.error({ err: error }, 'Get meeting series error');
      res.status(500).json({
        error: 'Failed to get meeting series',
        message: 'An internal error occurred',
      });
    }
  });

  // PUT /api/admin/meetings/series/:id - Update meeting series
  adminApiRouter.put('/series/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid series ID',
          message: 'Series ID must be a valid UUID',
        });
      }

      const updates = req.body;

      const series = await meetingsDb.updateSeries(id, updates);

      if (!series) {
        return res.status(404).json({
          error: 'Meeting series not found',
          message: 'No meeting series found with the specified ID',
        });
      }

      res.json(series);
    } catch (error) {
      logger.error({ err: error }, 'Update meeting series error');
      res.status(500).json({
        error: 'Failed to update meeting series',
        message: 'An internal error occurred',
      });
    }
  });

  // DELETE /api/admin/meetings/series/:id - Delete meeting series
  adminApiRouter.delete('/series/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid series ID',
          message: 'Series ID must be a valid UUID',
        });
      }

      const deleted = await meetingsDb.deleteSeries(id);

      if (!deleted) {
        return res.status(404).json({
          error: 'Meeting series not found',
          message: 'No meeting series found with the specified ID',
        });
      }

      res.json({ success: true, deleted: id });
    } catch (error) {
      logger.error({ err: error }, 'Delete meeting series error');
      res.status(500).json({
        error: 'Failed to delete meeting series',
        message: 'An internal error occurred',
      });
    }
  });

  // POST /api/admin/meetings - Create a meeting
  adminApiRouter.post('/', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const {
        series_id,
        working_group_id,
        title,
        description,
        agenda,
        topic_slugs,
        start_time,
        end_time,
        timezone,
        status,
        invite_mode,
        invite_slack_channel_id,
      } = req.body;

      if (!working_group_id || !title || !start_time) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'working_group_id, title, and start_time are required',
        });
      }

      if (!isValidUuid(working_group_id)) {
        return res.status(400).json({
          error: 'Invalid working group ID',
          message: 'Working group ID must be a valid UUID',
        });
      }

      if (series_id && !isValidUuid(series_id)) {
        return res.status(400).json({
          error: 'Invalid series ID',
          message: 'Series ID must be a valid UUID',
        });
      }

      // Verify working group exists
      const group = await workingGroupDb.getWorkingGroupById(working_group_id);
      if (!group) {
        return res.status(404).json({
          error: 'Working group not found',
          message: 'No working group found with the specified ID',
        });
      }

      // Validate slack_channel mode requires channel ID
      if (invite_mode === 'slack_channel' && !invite_slack_channel_id) {
        return res.status(400).json({
          error: 'Missing Slack channel ID',
          message: 'invite_slack_channel_id is required when invite_mode is "slack_channel"',
        });
      }

      const meeting = await meetingsDb.createMeeting({
        series_id,
        working_group_id,
        title,
        description,
        agenda,
        topic_slugs,
        start_time: new Date(start_time),
        end_time: end_time ? new Date(end_time) : undefined,
        timezone,
        status,
        created_by_user_id: user.id,
      });

      // Handle invite mode
      let invitedCount = 0;
      if (invite_mode === 'slack_channel' && invite_slack_channel_id) {
        const channelMembers = await getChannelMembers(invite_slack_channel_id);
        invitedCount = await meetingsDb.addAttendeesFromSlackChannel(meeting.id, channelMembers);
        logger.info({ meetingId: meeting.id, invitedCount, invite_mode, channelId: invite_slack_channel_id }, 'Invited Slack channel members');
      } else if (invite_mode === 'all_members') {
        invitedCount = await meetingsDb.addAttendeesFromGroup(meeting.id, working_group_id);
        logger.info({ meetingId: meeting.id, invitedCount, invite_mode }, 'Invited all group members');
      } else if (invite_mode === 'topic_subscribers' && topic_slugs?.length > 0) {
        invitedCount = await meetingsDb.addAttendeesFromGroup(meeting.id, working_group_id, topic_slugs);
        logger.info({ meetingId: meeting.id, invitedCount, invite_mode }, 'Invited topic subscribers');
      }

      res.status(201).json({ ...meeting, invited_count: invitedCount });
    } catch (error) {
      logger.error({ err: error }, 'Create meeting error');
      res.status(500).json({
        error: 'Failed to create meeting',
        message: 'An internal error occurred',
      });
    }
  });

  // GET /api/admin/meetings/:id - Get meeting by ID
  adminApiRouter.get('/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid meeting ID',
          message: 'Meeting ID must be a valid UUID',
        });
      }

      const meeting = await meetingsDb.getMeetingWithGroup(id);

      if (!meeting) {
        return res.status(404).json({
          error: 'Meeting not found',
          message: 'No meeting found with the specified ID',
        });
      }

      // Also fetch attendees
      const attendees = await meetingsDb.getAttendeesForMeeting(id);

      res.json({ meeting, attendees });
    } catch (error) {
      logger.error({ err: error }, 'Get meeting error');
      res.status(500).json({
        error: 'Failed to get meeting',
        message: 'An internal error occurred',
      });
    }
  });

  // PUT /api/admin/meetings/:id - Update meeting
  adminApiRouter.put('/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid meeting ID',
          message: 'Meeting ID must be a valid UUID',
        });
      }

      const updates = req.body;

      // Convert date strings to Date objects if present
      if (updates.start_time) {
        updates.start_time = new Date(updates.start_time);
      }
      if (updates.end_time) {
        updates.end_time = new Date(updates.end_time);
      }

      const meeting = await meetingsDb.updateMeeting(id, updates);

      if (!meeting) {
        return res.status(404).json({
          error: 'Meeting not found',
          message: 'No meeting found with the specified ID',
        });
      }

      res.json(meeting);
    } catch (error) {
      logger.error({ err: error }, 'Update meeting error');
      res.status(500).json({
        error: 'Failed to update meeting',
        message: 'An internal error occurred',
      });
    }
  });

  // DELETE /api/admin/meetings/:id - Delete meeting
  adminApiRouter.delete('/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid meeting ID',
          message: 'Meeting ID must be a valid UUID',
        });
      }

      const deleted = await meetingsDb.deleteMeeting(id);

      if (!deleted) {
        return res.status(404).json({
          error: 'Meeting not found',
          message: 'No meeting found with the specified ID',
        });
      }

      res.json({ success: true, deleted: id });
    } catch (error) {
      logger.error({ err: error }, 'Delete meeting error');
      res.status(500).json({
        error: 'Failed to delete meeting',
        message: 'An internal error occurred',
      });
    }
  });

  // POST /api/admin/meetings/:id/invite-group - Invite working group members
  adminApiRouter.post('/:id/invite-group', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid meeting ID',
          message: 'Meeting ID must be a valid UUID',
        });
      }

      const meeting = await meetingsDb.getMeetingById(id);
      if (!meeting) {
        return res.status(404).json({
          error: 'Meeting not found',
          message: 'No meeting found with the specified ID',
        });
      }

      const count = await meetingsDb.addAttendeesFromGroup(
        id,
        meeting.working_group_id,
        meeting.topic_slugs.length > 0 ? meeting.topic_slugs : undefined
      );

      res.json({ success: true, invited_count: count });
    } catch (error) {
      logger.error({ err: error }, 'Invite group to meeting error');
      res.status(500).json({
        error: 'Failed to invite group',
        message: 'An internal error occurred',
      });
    }
  });

  // POST /api/admin/meetings/:id/invite-channel - Invite Slack channel members
  adminApiRouter.post('/:id/invite-channel', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { slack_channel_id } = req.body;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid meeting ID',
          message: 'Meeting ID must be a valid UUID',
        });
      }

      if (!slack_channel_id) {
        return res.status(400).json({
          error: 'Missing required field',
          message: 'slack_channel_id is required',
        });
      }

      const meeting = await meetingsDb.getMeetingById(id);
      if (!meeting) {
        return res.status(404).json({
          error: 'Meeting not found',
          message: 'No meeting found with the specified ID',
        });
      }

      // Validate that the Slack channel is associated with the working group
      const workingGroup = await workingGroupDb.getWorkingGroupById(meeting.working_group_id);
      if (workingGroup) {
        const validChannels = [
          workingGroup.slack_channel_id,
          ...(workingGroup.topics?.map(t => t.slack_channel_id) || []),
        ].filter(Boolean);

        if (!validChannels.includes(slack_channel_id)) {
          return res.status(400).json({
            error: 'Invalid Slack channel',
            message: 'The specified Slack channel is not associated with this working group',
          });
        }
      }

      // Get channel members from Slack
      const channelMembers = await getChannelMembers(slack_channel_id);

      // Add attendees from the Slack channel
      const count = await meetingsDb.addAttendeesFromSlackChannel(id, channelMembers);

      res.json({ success: true, invited_count: count, channel_member_count: channelMembers.length });
    } catch (error) {
      logger.error({ err: error }, 'Invite Slack channel to meeting error');
      res.status(500).json({
        error: 'Failed to invite channel members',
        message: 'An internal error occurred',
      });
    }
  });

  // POST /api/admin/meetings/:id/attendees - Add attendee manually
  adminApiRouter.post('/:id/attendees', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid meeting ID',
          message: 'Meeting ID must be a valid UUID',
        });
      }

      const { workos_user_id, email, name } = req.body;

      if (!workos_user_id && !email) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'Either workos_user_id or email is required',
        });
      }

      const meeting = await meetingsDb.getMeetingById(id);
      if (!meeting) {
        return res.status(404).json({
          error: 'Meeting not found',
          message: 'No meeting found with the specified ID',
        });
      }

      const attendee = await meetingsDb.addAttendee({
        meeting_id: id,
        workos_user_id,
        email,
        name,
        invite_source: 'manual',
      });

      res.status(201).json(attendee);
    } catch (error) {
      logger.error({ err: error }, 'Add attendee error');
      res.status(500).json({
        error: 'Failed to add attendee',
        message: 'An internal error occurred',
      });
    }
  });

  // DELETE /api/admin/meetings/:id/attendees/:userId - Remove attendee
  adminApiRouter.delete('/:id/attendees/:userId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id, userId } = req.params;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid meeting ID',
          message: 'Meeting ID must be a valid UUID',
        });
      }

      const removed = await meetingsDb.removeAttendee(id, userId);

      if (!removed) {
        return res.status(404).json({
          error: 'Attendee not found',
          message: 'User is not an attendee of this meeting',
        });
      }

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Remove attendee error');
      res.status(500).json({
        error: 'Failed to remove attendee',
        message: 'An internal error occurred',
      });
    }
  });

  // =========================================================================
  // WORKING GROUP TOPICS ADMIN ROUTES
  // =========================================================================

  // GET /api/admin/meetings/topics/:groupId - Get topics for a working group
  adminApiRouter.get('/topics/:groupId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { groupId } = req.params;

      if (!isValidUuid(groupId)) {
        return res.status(400).json({
          error: 'Invalid group ID',
          message: 'Group ID must be a valid UUID',
        });
      }

      const topics = await meetingsDb.getTopicsForGroup(groupId);
      res.json({ topics });
    } catch (error) {
      logger.error({ err: error }, 'Get topics error');
      res.status(500).json({
        error: 'Failed to get topics',
        message: 'An internal error occurred',
      });
    }
  });

  // PUT /api/admin/meetings/topics/:groupId - Set topics for a working group
  adminApiRouter.put('/topics/:groupId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const { groupId } = req.params;

      if (!isValidUuid(groupId)) {
        return res.status(400).json({
          error: 'Invalid group ID',
          message: 'Group ID must be a valid UUID',
        });
      }

      const { topics } = req.body;

      if (!Array.isArray(topics)) {
        return res.status(400).json({
          error: 'Invalid topics',
          message: 'Topics must be an array',
        });
      }

      // Validate topic structure
      for (const topic of topics) {
        if (!topic.slug || !topic.name) {
          return res.status(400).json({
            error: 'Invalid topic',
            message: 'Each topic must have a slug and name',
          });
        }
      }

      await meetingsDb.setTopicsForGroup(groupId, topics as WorkingGroupTopic[]);
      const updatedTopics = await meetingsDb.getTopicsForGroup(groupId);

      res.json({ topics: updatedTopics });
    } catch (error) {
      logger.error({ err: error }, 'Set topics error');
      res.status(500).json({
        error: 'Failed to set topics',
        message: 'An internal error occurred',
      });
    }
  });

  // =========================================================================
  // PUBLIC API ROUTES (/api/meetings)
  // =========================================================================

  // GET /api/meetings - List upcoming meetings (public)
  publicApiRouter.get('/', optionalAuth, async (req: Request, res: Response) => {
    try {
      const { working_group_id, limit } = req.query;

      // Validate working_group_id if provided
      if (working_group_id && !isValidUuid(working_group_id as string)) {
        return res.status(400).json({
          error: 'Invalid working group ID',
          message: 'Working group ID must be a valid UUID',
        });
      }

      const meetings = await meetingsDb.listMeetings({
        working_group_id: working_group_id as string,
        upcoming_only: true,
        limit: limit ? parseInt(limit as string, 10) : 20,
      });

      res.json({ meetings });
    } catch (error) {
      logger.error({ err: error }, 'List public meetings error');
      res.status(500).json({
        error: 'Failed to list meetings',
        message: 'An internal error occurred',
      });
    }
  });

  // GET /api/meetings/:id - Get meeting details (public)
  publicApiRouter.get('/:id', optionalAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const user = req.user;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid meeting ID',
          message: 'Meeting ID must be a valid UUID',
        });
      }

      const meeting = await meetingsDb.getMeetingWithGroup(id);

      if (!meeting) {
        return res.status(404).json({
          error: 'Meeting not found',
          message: 'No meeting found with the specified ID',
        });
      }

      // Check if user is an attendee (for showing RSVP status)
      let userAttendee = null;
      if (user?.id) {
        userAttendee = await meetingsDb.getAttendee(id, user.id);
      }

      // Get attendee count (not full list for public)
      const attendees = await meetingsDb.getAttendeesForMeeting(id);
      const attendeeCounts = {
        total: attendees.length,
        accepted: attendees.filter(a => a.rsvp_status === 'accepted').length,
        declined: attendees.filter(a => a.rsvp_status === 'declined').length,
        pending: attendees.filter(a => a.rsvp_status === 'pending').length,
      };

      res.json({
        meeting,
        user_rsvp: userAttendee,
        attendee_counts: attendeeCounts,
      });
    } catch (error) {
      logger.error({ err: error }, 'Get public meeting error');
      res.status(500).json({
        error: 'Failed to get meeting',
        message: 'An internal error occurred',
      });
    }
  });

  // POST /api/meetings/:id/rsvp - RSVP to a meeting
  publicApiRouter.post('/:id/rsvp', requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { rsvp_status, rsvp_note } = req.body;
      const user = req.user!;

      if (!isValidUuid(id)) {
        return res.status(400).json({
          error: 'Invalid meeting ID',
          message: 'Meeting ID must be a valid UUID',
        });
      }

      if (!['accepted', 'declined', 'tentative'].includes(rsvp_status)) {
        return res.status(400).json({
          error: 'Invalid RSVP status',
          message: 'Status must be accepted, declined, or tentative',
        });
      }

      const meeting = await meetingsDb.getMeetingById(id);
      if (!meeting) {
        return res.status(404).json({
          error: 'Meeting not found',
          message: 'No meeting found with the specified ID',
        });
      }

      // Check if user is already an attendee
      let attendee = await meetingsDb.getAttendee(id, user.id);

      if (attendee) {
        // Update existing RSVP
        attendee = await meetingsDb.updateAttendee(id, user.id, {
          rsvp_status,
          rsvp_note,
        });
      } else {
        // Add as new attendee with RSVP
        attendee = await meetingsDb.addAttendee({
          meeting_id: id,
          workos_user_id: user.id,
          email: user.email,
          name: user.firstName && user.lastName
            ? `${user.firstName} ${user.lastName}`
            : user.email,
          rsvp_status,
          invite_source: 'request',
        });
      }

      res.json({ success: true, attendee });
    } catch (error) {
      logger.error({ err: error }, 'RSVP error');
      res.status(500).json({
        error: 'Failed to RSVP',
        message: 'An internal error occurred',
      });
    }
  });

  // =========================================================================
  // WORKING GROUP MEETING ROUTES (/api/working-groups/:slug/meetings)
  // These would be mounted separately or added to committees.ts
  // =========================================================================

  // =========================================================================
  // USER API ROUTES (/api/me/meetings)
  // =========================================================================

  // GET /api/me/meetings - Get current user's upcoming meetings
  userApiRouter.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const { limit, upcoming_only } = req.query;

      const meetings = await meetingsDb.getMeetingsForUser(user.id, {
        upcoming_only: upcoming_only !== 'false',
        limit: limit ? parseInt(limit as string, 10) : undefined,
      });

      res.json({ meetings });
    } catch (error) {
      logger.error({ err: error }, 'Get user meetings error');
      res.status(500).json({
        error: 'Failed to get meetings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/me/meetings/topic-subscriptions - Get user's topic subscriptions
  userApiRouter.get('/topic-subscriptions', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const { working_group_id } = req.query;

      if (!working_group_id) {
        return res.status(400).json({
          error: 'Missing required parameter',
          message: 'working_group_id is required',
        });
      }

      const subscription = await meetingsDb.getTopicSubscription(
        working_group_id as string,
        user.id
      );

      res.json({
        subscription: subscription || {
          working_group_id,
          workos_user_id: user.id,
          topic_slugs: [],
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Get topic subscriptions error');
      res.status(500).json({
        error: 'Failed to get subscriptions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PUT /api/me/meetings/topic-subscriptions - Update user's topic subscriptions
  userApiRouter.put('/topic-subscriptions', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const { working_group_id, topic_slugs } = req.body;

      if (!working_group_id || !Array.isArray(topic_slugs)) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'working_group_id and topic_slugs array are required',
        });
      }

      // Verify user is a member of the working group
      const isMember = await workingGroupDb.isMember(working_group_id, user.id);
      if (!isMember) {
        return res.status(403).json({
          error: 'Not a member',
          message: 'You must be a member of this working group to subscribe to topics',
        });
      }

      const subscription = await meetingsDb.updateTopicSubscription({
        working_group_id,
        workos_user_id: user.id,
        topic_slugs,
      });

      res.json({ subscription });
    } catch (error) {
      logger.error({ err: error }, 'Update topic subscriptions error');
      res.status(500).json({
        error: 'Failed to update subscriptions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return { adminApiRouter, publicApiRouter, userApiRouter };
}
