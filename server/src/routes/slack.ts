/**
 * Slack public routes module
 *
 * Handles public Slack webhook endpoints for both Slack apps.
 * All routes are mounted under /api/slack/ for consistency.
 *
 * Note: There are TWO separate Slack apps:
 * 1. AgenticAdvertising.org Bot - /api/slack/aaobot/*
 * 2. Addie AI Assistant - /api/slack/addie/*
 */

import { Router } from 'express';
import { createLogger } from '../logger.js';
import { isSlackSigningConfigured, isAddieSigningConfigured } from '../slack/verify.js';
import { handleSlashCommand } from '../slack/commands.js';
import { handleSlackEvent } from '../slack/events.js';
import {
  slackJsonParser,
  slackUrlencodedParser,
  createSlackSignatureVerifier,
  handleUrlVerification,
} from '../middleware/slack.js';

const logger = createLogger('slack-routes');

/**
 * Create public Slack routes
 * Returns a router to be mounted at /api/slack with sub-routers for each bot
 */
export function createSlackRouter(): { aaobotRouter: Router; addieRouter: Router } {
  const aaobotRouter = Router();
  const addieRouter = Router();

  // =========================================================================
  // MAIN AAO BOT ROUTES (mounted at /api/slack/aaobot)
  // =========================================================================

  // POST /api/slack/aaobot/commands - Handle Slack slash commands
  aaobotRouter.post(
    '/commands',
    slackUrlencodedParser(),
    createSlackSignatureVerifier(process.env.SLACK_SIGNING_SECRET, 'AAO Bot'),
    async (req, res) => {
      try {
        const command = req.body;

        // Validate it's our command
        if (command.command !== '/aao') {
          logger.warn({ command: command.command }, 'Unknown slash command');
          return res.status(400).json({ error: 'Unknown command' });
        }

        // Handle the command
        const response = await handleSlashCommand(command);

        // Slack expects a 200 response within 3 seconds
        res.json(response);
      } catch (error) {
        logger.error({ err: error }, 'Slack command error');
        res.json({
          response_type: 'ephemeral',
          text: 'Sorry, there was an error processing your command. Please try again later.',
        });
      }
    }
  );

  // POST /api/slack/aaobot/events - Handle Slack Events API for main AAO bot
  aaobotRouter.post(
    '/events',
    slackJsonParser(),
    async (req, res) => {
      try {
        // Handle URL verification challenge (before signature verification)
        if (handleUrlVerification(req, res)) {
          return;
        }

        // Verify the request is from Slack
        if (isSlackSigningConfigured()) {
          const verifier = createSlackSignatureVerifier(
            process.env.SLACK_SIGNING_SECRET,
            'AAO Bot'
          );
          // Run verification manually since we already parsed the body
          const result = await new Promise<boolean>((resolve) => {
            verifier(req, res, () => resolve(true));
            // If verifier doesn't call next(), it sent a response
            setTimeout(() => resolve(false), 0);
          });
          if (!result) return;
        }

        // Handle events asynchronously (don't block response)
        // Slack requires response within 3 seconds
        handleSlackEvent(req.body).catch(err => {
          logger.error({ err }, 'Error handling Slack event');
        });

        // Always respond with 200 immediately to acknowledge receipt
        res.status(200).send();
      } catch (error) {
        logger.error({ err: error }, 'Slack event error');
        res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  // =========================================================================
  // ADDIE AI ASSISTANT ROUTES (mounted at /api/slack/addie)
  // =========================================================================

  // POST /api/slack/addie/events - Handle Slack Events API for Addie
  addieRouter.post(
    '/events',
    slackJsonParser(),
    async (req, res) => {
      try {
        // Handle URL verification challenge (before signature verification)
        if (handleUrlVerification(req, res)) {
          return;
        }

        // Verify the request is from Slack using Addie's signing secret
        if (isAddieSigningConfigured()) {
          const verifier = createSlackSignatureVerifier(
            process.env.ADDIE_SIGNING_SECRET,
            'Addie'
          );
          // Run verification manually since we already parsed the body
          const result = await new Promise<boolean>((resolve) => {
            verifier(req, res, () => resolve(true));
            // If verifier doesn't call next(), it sent a response
            setTimeout(() => resolve(false), 0);
          });
          if (!result) return;
        }

        // Handle events asynchronously (don't block response)
        // Slack requires response within 3 seconds
        handleSlackEvent(req.body).catch(err => {
          logger.error({ err }, 'Error handling Addie Slack event');
        });

        // Always respond with 200 immediately to acknowledge receipt
        res.status(200).send();
      } catch (error) {
        logger.error({ err: error }, 'Addie Slack event error');
        res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  return { aaobotRouter, addieRouter };
}
