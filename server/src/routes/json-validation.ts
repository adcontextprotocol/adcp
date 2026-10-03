import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { ToolError } from '../addie/tool-error.js';
import { MAX_JSON_FILE_BYTES } from '../mcp/json-file-validation.js';
import { JsonUploadValidationError, validateJsonUploadBytes } from '../mcp/json-upload-validation.js';
import { jsonUploadValidationRateLimiter } from '../middleware/rate-limit.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_JSON_FILE_BYTES, files: 1, fields: 4, parts: 5, fieldSize: 255 },
});

function parseUpload(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.is('multipart/form-data')) {
    res.status(400).json({ error: 'Select the original JSON file in the file picker.' });
    return;
  }
  upload.single('file')(req, res, (error: unknown) => {
    if (error) {
      const oversized = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
      res.status(oversized ? 413 : 400).json({ error: oversized ? 'The JSON file exceeds the 5 MiB limit.' : 'Could not read the upload.' });
      return;
    }
    next();
  });
}

/** Anonymous schema-only validation: bounded multipart input, no storage or model call. */
export function createJsonValidationRouter(): Router {
  const router = Router();
  router.post('/json/validate-upload', jsonUploadValidationRateLimiter, parseUpload, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Select the original JSON file.' });
    const fields = req.body as Record<string, unknown>;
    const allowed = new Set(['expected_file_sha256', 'expected_byte_count', 'schema_path', 'version']);
    if (Object.keys(fields).some((key) => !allowed.has(key) || typeof fields[key] !== 'string')) {
      return res.status(400).json({ error: 'Invalid upload metadata.' });
    }
    if (typeof fields.expected_byte_count !== 'string' || !/^\d{1,7}$/.test(fields.expected_byte_count)) {
      return res.status(400).json({ error: 'The original file byte count is required.' });
    }
    try {
      const result = await validateJsonUploadBytes(req.file.buffer, {
        ...fields, expected_byte_count: Number(fields.expected_byte_count), file_name: req.file.originalname,
      });
      return res.json(result);
    } catch (error) {
      if (error instanceof JsonUploadValidationError) return res.status(400).json({ error: error.publicMessage });
      if (error instanceof ToolError) return res.status(400).json({ error: 'Could not validate the file. Check that it contains UTF-8 JSON and that the schema path and version identify a published AdCP schema.' });
      // Never log the file contents or raw network errors containing URLs.
      return res.status(502).json({ error: 'Could not complete schema validation. Please try again.' });
    }
  });
  return router;
}
