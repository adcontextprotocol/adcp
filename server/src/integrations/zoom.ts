/**
 * Zoom API Integration
 *
 * Uses Server-to-Server OAuth for authentication.
 * See: https://developers.zoom.us/docs/internal-apps/s2s-oauth/
 */

import crypto from 'crypto';
import { createLogger } from '../logger.js';

const logger = createLogger('zoom-integration');

// Environment variables
const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

// Token cache
let accessToken: string | null = null;
let tokenExpiry: number = 0;

export interface ZoomMeetingSettings {
  host_video?: boolean;
  participant_video?: boolean;
  join_before_host?: boolean;
  mute_upon_entry?: boolean;
  watermark?: boolean;
  audio?: 'voip' | 'telephony' | 'both';
  auto_recording?: 'none' | 'local' | 'cloud';
  waiting_room?: boolean;
}

export interface CreateZoomMeetingInput {
  topic: string;
  type?: 1 | 2 | 3 | 8; // 1=instant, 2=scheduled, 3=recurring no fixed time, 8=recurring fixed time
  start_time?: string; // ISO 8601 format
  duration?: number; // minutes
  timezone?: string;
  agenda?: string;
  password?: string;
  settings?: ZoomMeetingSettings;
  recurrence?: {
    type: 1 | 2 | 3; // 1=daily, 2=weekly, 3=monthly
    repeat_interval?: number;
    weekly_days?: string; // "1,2,3,4,5" for Mon-Fri
    monthly_day?: number;
    end_times?: number;
    end_date_time?: string;
  };
}

export interface ZoomMeeting {
  id: number;
  uuid: string;
  host_id: string;
  topic: string;
  type: number;
  status: string;
  start_time: string;
  duration: number;
  timezone: string;
  agenda?: string;
  created_at: string;
  start_url: string;
  join_url: string;
  password?: string;
  encrypted_password?: string;
}

export interface ZoomRecording {
  uuid: string;
  id: number;
  host_id: string;
  topic: string;
  start_time: string;
  duration: number;
  total_size: number;
  recording_count: number;
  recording_files: ZoomRecordingFile[];
}

export interface ZoomRecordingFile {
  id: string;
  meeting_id: string;
  recording_start: string;
  recording_end: string;
  file_type: string;
  file_extension: string;
  file_size: number;
  play_url?: string;
  download_url?: string;
  status: string;
  recording_type: string;
}

/**
 * Check if Zoom integration is configured
 */
export function isZoomConfigured(): boolean {
  return !!(ZOOM_ACCOUNT_ID && ZOOM_CLIENT_ID && ZOOM_CLIENT_SECRET);
}

/**
 * Get access token using Server-to-Server OAuth
 */
async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 5 minute buffer)
  if (accessToken && Date.now() < tokenExpiry - 300000) {
    return accessToken;
  }

  if (!isZoomConfigured()) {
    throw new Error('Zoom integration not configured. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, and ZOOM_CLIENT_SECRET.');
  }

  const credentials = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');

  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'account_credentials',
      account_id: ZOOM_ACCOUNT_ID!,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error({ status: response.status, error }, 'Failed to get Zoom access token');
    throw new Error(`Failed to get Zoom access token: ${response.status}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);

  logger.info('Obtained new Zoom access token');
  return accessToken!;
}

/**
 * Make authenticated request to Zoom API
 */
async function zoomRequest<T>(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const token = await getAccessToken();

  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`https://api.zoom.us/v2${endpoint}`, options);

  if (!response.ok) {
    const error = await response.text();
    logger.error({ status: response.status, endpoint, error }, 'Zoom API request failed');
    throw new Error(`Zoom API error: ${response.status} - ${error}`);
  }

  // Handle empty responses (e.g., DELETE)
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Create a Zoom meeting
 */
export async function createMeeting(
  hostEmail: string,
  input: CreateZoomMeetingInput
): Promise<ZoomMeeting> {
  logger.info({ hostEmail, topic: input.topic }, 'Creating Zoom meeting');

  const meeting = await zoomRequest<ZoomMeeting>(
    'POST',
    `/users/${encodeURIComponent(hostEmail)}/meetings`,
    {
      topic: input.topic,
      type: input.type || 2, // Default to scheduled meeting
      start_time: input.start_time,
      duration: input.duration || 60,
      timezone: input.timezone || 'America/New_York',
      agenda: input.agenda,
      password: input.password,
      settings: {
        host_video: true,
        participant_video: true,
        join_before_host: true,
        mute_upon_entry: true,
        auto_recording: 'cloud', // Enable cloud recording for transcripts
        waiting_room: false,
        ...input.settings,
      },
      recurrence: input.recurrence,
    }
  );

  logger.info({ meetingId: meeting.id, joinUrl: meeting.join_url }, 'Zoom meeting created');
  return meeting;
}

/**
 * Get a Zoom meeting by ID
 */
export async function getMeeting(meetingId: string | number): Promise<ZoomMeeting> {
  return zoomRequest<ZoomMeeting>('GET', `/meetings/${meetingId}`);
}

/**
 * Update a Zoom meeting
 */
export async function updateMeeting(
  meetingId: string | number,
  updates: Partial<CreateZoomMeetingInput>
): Promise<void> {
  logger.info({ meetingId }, 'Updating Zoom meeting');
  await zoomRequest('PATCH', `/meetings/${meetingId}`, updates);
}

/**
 * Delete a Zoom meeting
 */
export async function deleteMeeting(meetingId: string | number): Promise<void> {
  logger.info({ meetingId }, 'Deleting Zoom meeting');
  await zoomRequest('DELETE', `/meetings/${meetingId}`);
}

/**
 * Get meeting recordings
 */
export async function getMeetingRecordings(meetingId: string): Promise<ZoomRecording> {
  return zoomRequest<ZoomRecording>('GET', `/meetings/${meetingId}/recordings`);
}

/**
 * Get transcript text from a completed recording
 * Returns the VTT transcript content as text
 */
export async function getTranscriptText(meetingUuid: string): Promise<string | null> {
  try {
    const recording = await zoomRequest<ZoomRecording>(
      'GET',
      `/meetings/${encodeURIComponent(encodeURIComponent(meetingUuid))}/recordings`
    );

    // Find the transcript file
    const transcriptFile = recording.recording_files?.find(
      f => f.file_type === 'TRANSCRIPT' || f.recording_type === 'audio_transcript'
    );

    if (!transcriptFile?.download_url) {
      logger.info({ meetingUuid }, 'No transcript file found');
      return null;
    }

    // Download the transcript
    const token = await getAccessToken();
    const response = await fetch(transcriptFile.download_url, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Failed to download transcript');
      return null;
    }

    const transcript = await response.text();
    logger.info({ meetingUuid, length: transcript.length }, 'Retrieved transcript');
    return transcript;
  } catch (error) {
    logger.error({ err: error, meetingUuid }, 'Error getting transcript');
    return null;
  }
}

/**
 * Parse VTT transcript to plain text
 */
export function parseVttToText(vttContent: string): string {
  const lines = vttContent.split('\n');
  const textLines: string[] = [];

  let inCue = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip header and empty lines
    if (trimmed === 'WEBVTT' || trimmed === '') {
      inCue = false;
      continue;
    }

    // Skip timestamp lines
    if (trimmed.includes('-->')) {
      inCue = true;
      continue;
    }

    // Skip cue identifiers (lines that are just numbers)
    if (/^\d+$/.test(trimmed)) {
      continue;
    }

    // Collect text content
    if (inCue && trimmed) {
      textLines.push(trimmed);
    }
  }

  return textLines.join(' ');
}

/**
 * Zoom webhook event types we handle
 */
export type ZoomWebhookEventType =
  | 'meeting.started'
  | 'meeting.ended'
  | 'recording.completed'
  | 'recording.transcript_completed';

export interface ZoomWebhookPayload {
  event: ZoomWebhookEventType;
  event_ts: number;
  payload: {
    account_id: string;
    object: {
      id?: number;
      uuid?: string;
      host_id?: string;
      topic?: string;
      start_time?: string;
      duration?: number;
      recording_files?: ZoomRecordingFile[];
    };
  };
}

/**
 * Verify Zoom webhook signature using HMAC-SHA256
 * See: https://developers.zoom.us/docs/api/rest/webhook-reference/#verify-webhook-events
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string
): boolean {
  const webhookSecret = process.env.ZOOM_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error('ZOOM_WEBHOOK_SECRET not configured - rejecting webhook');
    return false;
  }

  const message = `v0:${timestamp}:${payload}`;
  const expectedSignature = 'v0=' + crypto
    .createHmac('sha256', webhookSecret)
    .update(message)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    // timingSafeEqual throws if buffers have different lengths
    return false;
  }
}
